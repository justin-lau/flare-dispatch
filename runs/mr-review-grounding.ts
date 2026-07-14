// Retrieval-augmented single-shot grounding for `mr-review` (a cheap A/B test).
//
// BEFORE the model call, the reviewer queries a whole-codebase context store
// (hakiri, an MCP server reached over a Cloudflare tunnel) for code SURROUNDING
// the change — the pre-change versions of the touched files plus a handful of
// keyword hits — and PREPENDS it to the diff as a clearly delimited grounding
// block. The hypothesis: a single-shot reviewer that can see the neighbouring
// code catches context-dependent bugs a diff-only reviewer misses.
//
// It is CONFIG_KV-gated and OFF by default: with no `pr-review.hakiri.endpoint`
// set, `mr-review` behaves EXACTLY as today (this module is never entered). That
// makes the A/B exactly reproducible — flip one config key, nothing else.
//
// Everything here is best-effort: grounding is ADDITIVE, so any HTTP / parse
// failure yields "" and the review proceeds diff-only. The module is split into
// a PURE core (`deriveQueries`, `changedPaths`, `parseSearchRows`,
// `composeGroundedInput`) unit-tested without a network, and one effectful
// `fetchContext` tested against an msw-mocked MCP endpoint.

import { Effect } from "effect";

/** How many search queries we derive from a diff (keep the fan-out cheap). */
export const MAX_QUERIES = 6;
/** `context.search` hits per query. */
export const SEARCH_LIMIT = 3;
/** Hard cap on injected context — headroom ADDITIONAL to the diff, not eating it. */
export const MAX_CONTEXT_CHARS = 12_000;
/**
 * The table `context.query` reads changed-file contents from. NB the tunnel's
 * hakiri may name this `workspace_files` instead — a live-schema detail to
 * confirm against the deployed store (a wrong name simply yields no file-content
 * grounding; search-based grounding is unaffected).
 */
export const REPO_FILES_TABLE = "repo_files";

/** Grounding configuration read from CONFIG_KV (endpoint unset → grounding off). */
export type GroundingConfig = {
  /** Full https URL of the hakiri MCP tunnel (e.g. https://x.trycloudflare.com). */
  readonly endpoint: string;
  /** Optional bearer token. */
  readonly token?: string;
};

// ---------------------------------------------------------------------------
// Pure core.

/** Identifiers too generic to be useful search terms (keywords / noise). */
const STOP_WORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "await",
  "const", "let", "var", "new", "typeof", "throw", "yield", "import", "export",
  "async", "super", "this", "void", "case", "else", "true", "false", "null",
]);

/** The `+`-added lines of a diff (excludes the `+++` file header). */
const addedLines = (diff: string): string[] =>
  diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));

/**
 * The new-side paths a diff touches — from `diff --git a/<old> b/<new>` headers.
 * (The `b/` side is the post-change path; a rename still points at the new name.)
 */
export const changedPaths = (diff: string): string[] => {
  const paths: string[] = [];
  const re = /^diff --git a\/(?:.+?) b\/(.+)$/gm;
  let m: RegExpExecArray | null = re.exec(diff);
  while (m !== null) {
    paths.push(m[1]!.trim());
    m = re.exec(diff);
  }
  return [...new Set(paths)];
};

const basename = (path: string): string => path.split("/").pop() ?? path;

/**
 * Derive up to {@link MAX_QUERIES} search queries from a diff: the changed-file
 * basenames (most specific), the module specifiers of added `import ... from`
 * lines, and identifiers that appear to be CALLED (`name(`) on added lines. Pure.
 */
export const deriveQueries = (diff: string): string[] => {
  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (q: string) => {
    const t = q.trim();
    if (t.length >= 3 && !seen.has(t)) {
      seen.add(t);
      queries.push(t);
    }
  };

  // 1. Changed-file basenames (skip a bare index name that carries no signal).
  for (const p of changedPaths(diff)) push(basename(p));

  const added = addedLines(diff).join("\n");

  // 2. Imported module specifiers — `from '<spec>'` / `from "<spec>"`.
  const importRe = /\bfrom ['"]([^'"]+)['"]/g;
  for (let m = importRe.exec(added); m !== null; m = importRe.exec(added)) {
    push(basename(m[1]!));
  }

  // 3. Called identifiers — `<name>(` (drops keywords + trivially short names).
  const callRe = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  for (let m = callRe.exec(added); m !== null; m = callRe.exec(added)) {
    const name = m[1]!;
    if (!STOP_WORDS.has(name) && name.length >= 3) push(name);
  }

  return queries.slice(0, MAX_QUERIES);
};

/** One search hit projected to the columns we inject. */
export type ContextRow = { readonly path: string; readonly text: string };

/**
 * Parse a hakiri tool-call result body — the `{ columns, rows }` tabular shape
 * carried as a JSON string inside `result.content[0].text`. Column order is not
 * assumed: `path` is located by name, and the injected text prefers a `snippet`
 * column, falling back to `content` then `name`. Any malformed shape → `[]`.
 */
export const parseSearchRows = (toolText: string): ContextRow[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolText);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const table = parsed as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) return [];

  const cols = table.columns.map((c) => String(c));
  const pathIdx = cols.indexOf("path");
  const textIdx = ["snippet", "content", "name"]
    .map((c) => cols.indexOf(c))
    .find((i) => i >= 0);
  if (pathIdx < 0 || textIdx === undefined) return [];

  const out: ContextRow[] = [];
  for (const row of table.rows) {
    if (!Array.isArray(row)) continue;
    const path = row[pathIdx];
    const text = row[textIdx];
    if (typeof path !== "string" || path.length === 0) continue;
    out.push({ path, text: text == null ? "" : String(text) });
  }
  return out;
};

/** The delimiter that separates the grounding block from the change under review. */
const CONTEXT_HEADER =
  "## Repository context (from hakiri — surrounding code on main, for grounding; NOT part of the change)";
const DIFF_HEADER = "## The merge-request diff under review";

/**
 * Compose the grounded model input: the context block, clearly labelled as NOT
 * part of the change, above the real diff (which is passed through INTACT).
 */
export const composeGroundedInput = (context: string, diff: string): string =>
  `${CONTEXT_HEADER}\n${context}\n\n${DIFF_HEADER}\n${diff}`;

/**
 * Assemble injected context from projected rows — one fenced block per unique
 * path (first occurrence wins, so full file contents provided first outrank
 * later search snippets), capped to {@link MAX_CONTEXT_CHARS}. Pure.
 */
export const assembleContext = (rows: readonly ContextRow[]): string => {
  const seen = new Set<string>();
  const blocks: string[] = [];
  let remaining = MAX_CONTEXT_CHARS;
  for (const { path, text } of rows) {
    if (seen.has(path)) continue;
    seen.add(path);
    // Fence overhead (`### <path>\n```\n…\n````) that isn't the body text.
    const overhead = path.length + 12;
    const budget = remaining - overhead;
    if (budget <= 0) break;
    // Truncate an oversized body rather than dropping the whole block — a large
    // changed file should still contribute (partial) grounding, not vanish.
    const body = text.length > budget ? text.slice(0, budget) : text;
    const block = `### ${path}\n\`\`\`\n${body}\n\`\`\``;
    blocks.push(block);
    remaining -= block.length + 2;
  }
  return blocks.join("\n\n");
};

// ---------------------------------------------------------------------------
// Effectful MCP client (best-effort — never fails the review).

/** A single quote-escaped SQL string literal. */
const sqlLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Extract the `result.content[0].text` payload from an MCP tool-call envelope. */
export const toolText = (envelope: unknown): string => {
  const content = (envelope as { result?: { content?: unknown } })?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return "";
  const first = content[0] as { text?: unknown };
  return typeof first.text === "string" ? first.text : "";
};

/** Per-call wall-clock ceiling for a hakiri MCP request (AbortSignal timeout). A
 *  slow/hung tunnel must not stall a review turn — the call aborts and degrades. */
export const HAKIRI_TIMEOUT_MS = 20_000;

/** A hakiri MCP `tools/call` client — one `call(name, arguments)` closure with
 *  the endpoint URL, JSON-RPC envelope, bearer header, and timeout baked in.
 *  Throws on a non-2xx status or a transport/timeout error (the caller decides
 *  how to degrade). Shared by {@link fetchContext} (single-shot grounding) and
 *  the agentic tool loop (runs/mr-review-agentic.ts), so ONE MCP client exists. */
export const makeHakiriCall = (
  config: GroundingConfig,
): ((name: string, argument: Record<string, unknown>) => Promise<unknown>) => {
  const base = config.endpoint.replace(/\/$/, "");
  const url = `${base}/mcp`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...(config.token !== undefined && config.token.length > 0
      ? { authorization: `Bearer ${config.token}` }
      : {}),
  };
  let id = 0;
  return async (name, argument) => {
    id += 1;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: argument },
      }),
      signal: AbortSignal.timeout(HAKIRI_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`hakiri ${name} → ${res.status}`);
    return res.json();
  };
};

/**
 * Fetch grounding context for a change: a `context.search` per derived query
 * PLUS one `context.query` pulling the full current contents of the changed
 * files (so the model sees the pre-change file, not just the hunks). POSTs MCP
 * JSON-RPC to `${endpoint}/mcp` via the platform `fetch`. Best-effort: any HTTP
 * or parse error yields "" so grounding degrades to diff-only.
 */
export const fetchContext = (args: {
  readonly config: GroundingConfig;
  readonly queries: readonly string[];
  readonly paths: readonly string[];
}): Effect.Effect<string> =>
  Effect.tryPromise(async () => {
    const call = makeHakiriCall(args.config);

    const fileRows: ContextRow[] = [];
    // 1. Full contents of the changed files that still exist on main.
    if (args.paths.length > 0) {
      const inList = args.paths.map(sqlLiteral).join(", ");
      const sql = `select path, content from ${REPO_FILES_TABLE} where path in (${inList}) and not deleted`;
      fileRows.push(...parseSearchRows(toolText(await call("context.query", { sql }))));
    }

    // 2. Keyword search per derived query.
    const searchRows: ContextRow[] = [];
    for (const query of args.queries) {
      const env = await call("context.search", { query, limit: SEARCH_LIMIT });
      searchRows.push(...parseSearchRows(toolText(env)));
    }

    // File contents first (they outrank snippets on path collision), then hits.
    return assembleContext([...fileRows, ...searchRows]);
  }).pipe(Effect.catchAll(() => Effect.succeed("")));

// @flare-dispatch/review-agent — the Worker-side review engine.
//
// Three Effect functions the `pr-review` run composes:
//
//   * `riskTier`     — a PURE heuristic on diff size + touched paths. No model
//                      call (cheaper, deterministic). trivial | lite | full.
//   * `reviewDomain` — one domain reviewer (security / performance / …). Gets
//                      structured findings FROM THE MODEL — either a forced
//                      tool call ("tools" mode) or a strict-JSON text response
//                      ("json" mode, for models that don't honour tool-calls).
//                      This is the only model-calling surface.
//   * `coordinate`   — PURE deterministic assembly of the reviewers' findings:
//                      merge + dedup + counts-by-severity + verdict-by-rule. No
//                      model call (the reviewers already did the work), so it
//                      can never fail with `StructuredOutputInvalid`.
//
// --- Transport (reviewDomain only): the `modelGateway` capability ------------
//
// `reviewDomain`'s model calls go through the `modelGateway` capability
// (`@flare-dispatch/core`), which the runtime backs with the Cloudflare Workers
// AI binding (`env.AI`) routed through an AI Gateway. The binding is the auth
// (Workers AI is account-billed), so NO model API key travels with the request —
// the engine carries no base url and no secret. The engine just yields the
// `ModelGateway` Tag, the way a run yields `config` / `sandbox`, and the runtime
// provides it.
//
// --- reviewDomain output modes (per backend, resolved from CONFIG_KV) --------
//
// "tools" mode sends a `report` tool and reads the model's `toolCalls`
// (Workers AI returns each tool call's `arguments` as a parsed OBJECT, though
// the engine also tolerates the OpenAI-style JSON STRING). Reasoning models
// (e.g. DeepSeek-R1 distills) return NO tool calls and emit `<think>…</think>`
// prose in `text` instead, so for those "json" mode sends NO tools and asks for
// a strict JSON object, strips `<think>`/code fences, then `JSON.parse` +
// Schema-decodes against the same `Finding[]` schema. If "tools" mode comes back
// with zero tool calls, the engine auto-falls-back to a single "json" retry.
//
// `systemPrompt` is always SUPPLIED by the caller; this module ships only a
// generic default instruction (no project-specific rubric).

import {
  modelGateway,
  ModelGateway,
  type ModelTool,
  type ModelToolCall,
} from "@flare-dispatch/core";
import { Effect, Either, JSONSchema, ParseResult, Schema } from "effect";
import { type ReviewMode } from "./backend.js";
import { ModelCallFailed, StructuredOutputInvalid } from "./errors.js";
import { extractJsonCandidates } from "./json-extract.js";
import {
  type CoordinatedReview as CoordinatedReviewType,
  Finding,
  type Tier,
} from "./schemas.js";

/**
 * Fallback token budget for a domain review model call when the resolved backend
 * doesn't specify one. Sized for reasoning models (GLM / Kimi / DeepSeek): they
 * spend output tokens inside `<think>` BEFORE emitting the JSON answer, so a tight
 * budget truncates the answer (the unterminated `<think>` is then stripped to EOF
 * → "no JSON object found"). `max_tokens` is a ceiling, so non-reasoning models
 * that answer in a few hundred tokens are unaffected. Per-backend overrides live
 * in `pr-review.<backend>.maxTokens` (CONFIG_KV).
 */
const REVIEW_MAX_TOKENS = 8192;

/** Max chars of raw model text we attach to a `StructuredOutputInvalid`. */
const EXCERPT_LEN = 400;
const excerpt = (text: string): string => text.slice(0, EXCERPT_LEN);

/**
 * Blunt correction appended on the SINGLE json-mode repair retry, after a first
 * response carried no parseable JSON — prose only, or a value truncated inside a
 * reasoning block (the `empty` / `not-json` failures). Kept terse and
 * imperative: the smaller catalog models that ignore the original "respond with
 * only JSON" framing tend to comply with a direct second-person correction.
 */
const JSON_REPAIR_SUFFIX =
  'Your previous response did not contain a valid JSON object. Reply with ONLY the JSON object — no reasoning, no explanation, no <think> block, no markdown code fences. Begin your reply with "{" and end it with "}".';

/** A JSON Schema (draft-07) for a tool's `function.parameters`. */
const toolParametersSchema = (schema: Schema.Schema<any, any>): unknown => {
  const js = JSONSchema.make(schema) as unknown as Record<string, unknown>;
  // Providers want a plain parameters object — drop the `$schema` meta key.
  const { $schema: _drop, ...rest } = js;
  return rest;
};

// ---------------------------------------------------------------------------
// Generic default prompts. The caller (run) SHOULD override `systemPrompt`
// from config; these are the safe, project-neutral fallbacks.

/** Generic per-domain reviewer instruction. */
export const DEFAULT_REVIEW_SYSTEM_PROMPT = `You are a focused code reviewer.
Review the supplied unified diff and report concrete, actionable findings for
your assigned domain only. Anchor every finding to a real file path and line
range present in the diff. Prefer a small number of high-signal findings over
many low-value ones. If the diff is clean for your domain, report zero findings.
Call the \`report\` tool exactly once with your findings (an empty array is
valid). Do not respond with prose — the tool call IS your output.`;

/**
 * Compose the reviewer system prompt from its layers, appending each non-empty
 * one with a blank-line separator. PURE — no I/O — so it unit-tests directly.
 *
 *   - `base`        the reviewer instruction: an operator `*.prompt` override or
 *                   {@link DEFAULT_REVIEW_SYSTEM_PROMPT}.
 *   - `guidelines`  optional ADDITIVE "house rules" (operator `*.guidelines`).
 *                   Layered on top of `base` rather than replacing it, so an
 *                   operator can add a suppression rubric ("what NOT to flag"),
 *                   project conventions, or severity calibration WITHOUT forking
 *                   the maintained default. Labeled authoritative so the model
 *                   treats it as binding, not a hint.
 *   - `focus`       optional per-dispatch focus line (rides the trusted dispatch
 *                   input, never the attacker-controllable diff).
 *
 * Order is base → guidelines → focus: standing house rules sit above a single
 * run's focus. Whitespace-only layers are dropped; the result is trimmed.
 */
export const composeSystemPrompt = (layers: {
  readonly base: string;
  readonly guidelines?: string;
  readonly focus?: string;
}): string => {
  const parts: string[] = [layers.base.trim()];
  const guidelines = layers.guidelines?.trim();
  if (guidelines !== undefined && guidelines !== "") {
    parts.push(
      `Additional review guidelines — treat these as authoritative house rules:\n${guidelines}`,
    );
  }
  const focus = layers.focus?.trim();
  if (focus !== undefined && focus !== "") {
    parts.push(`Extra focus for this review: ${focus}`);
  }
  return parts.join("\n\n");
};

// (Coordination is deterministic — pure code — so there is no coordinator
// prompt; see `coordinate` below.)

// ---------------------------------------------------------------------------
// Shared helpers.

type StructuredCtx = {
  readonly backend: string;
  readonly model: string;
  readonly surface: string;
};

/** Schema-decode an already-parsed value, mapping a mismatch to `StructuredOutputInvalid`. */
const decodeAgainst = <A>(
  value: unknown,
  decode: (u: unknown) => Either.Either<A, ParseResult.ParseError>,
  ctx: StructuredCtx,
  excerptText: string,
): Effect.Effect<A, StructuredOutputInvalid> =>
  Either.match(decode(value), {
    onLeft: (err) =>
      Effect.fail(
        new StructuredOutputInvalid({
          ...ctx,
          reason: "schema-mismatch",
          excerpt: excerpt(excerptText),
          message: `value did not match the expected schema — ${ParseResult.TreeFormatter.formatErrorSync(err)}`,
        }),
      ),
    onRight: (a) => Effect.succeed(a),
  });

/**
 * Strip `<think>`/code fences from text, isolate the JSON value, `JSON.parse`,
 * then Schema-decode. Each failure stage maps to a precise
 * `StructuredOutputInvalid.reason` so the run's PR comment can name the cause.
 * The json-mode path (the model's free `text`).
 *
 * Defensive entry guard: `text` is typed `string` but ModelGateway-shaped
 * adapters across providers can deliver `text === undefined` or a non-string
 * value (Workers AI sometimes omits `text` when it produced tool calls; some
 * gateways forward an array of content blocks). A bare `text.replace(...)`
 * inside `extractJsonText` would throw `TypeError: text.replace is not a
 * function` and bypass the run's error boundary (the boundary only catches
 * `StructuredOutputInvalid` / `ModelCallFailed`, not arbitrary thrown errors).
 * Coerce non-strings to a structured failure so the PR comment names the cause.
 */
const parseStructured = <A>(
  text: string,
  decode: (u: unknown) => Either.Either<A, ParseResult.ParseError>,
  ctx: StructuredCtx,
): Effect.Effect<A, StructuredOutputInvalid> =>
  Effect.gen(function* () {
    if (typeof text !== "string") {
      return yield* Effect.fail(
        new StructuredOutputInvalid({
          ...ctx,
          reason: "not-json",
          excerpt: excerpt(JSON.stringify(text ?? null) ?? "null"),
          message: `expected a string \`text\` from the model, got ${
            text === null ? "null" : typeof text
          } (the provider may have returned tool calls without a text body)`,
        }),
      );
    }
    const candidates = extractJsonCandidates(text);
    if (candidates.length === 0) {
      return yield* Effect.fail(
        new StructuredOutputInvalid({
          ...ctx,
          reason: "empty",
          excerpt: excerpt(text),
          message:
            "no JSON object found in the model response (after stripping <think> + code fences)",
        }),
      );
    }

    // Reasoning models bury the answer in the LAST balanced value and emit
    // earlier JSON-ish fragments (quoted code, example objects) while thinking —
    // so try candidates last-first and keep the first that BOTH parses AND
    // decodes against the schema. `lastError` carries the most specific failure
    // for the PR comment when none validate.
    let lastError: StructuredOutputInvalid = new StructuredOutputInvalid({
      ...ctx,
      reason: "empty",
      excerpt: excerpt(text),
      message:
        "no JSON object found in the model response (after stripping <think> + code fences)",
    });
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i] as string;
      let parsed: unknown;
      try {
        parsed = JSON.parse(candidate) as unknown;
      } catch {
        lastError = new StructuredOutputInvalid({
          ...ctx,
          reason: "not-json",
          excerpt: excerpt(candidate),
          message: "response text was not valid JSON",
        });
        continue;
      }
      const decoded = decode(parsed);
      if (Either.isRight(decoded)) return decoded.right;
      lastError = new StructuredOutputInvalid({
        ...ctx,
        reason: "schema-mismatch",
        excerpt: excerpt(candidate),
        message: `value did not match the expected schema — ${ParseResult.TreeFormatter.formatErrorSync(decoded.left)}`,
      });
    }
    return yield* Effect.fail(lastError);
  });

/**
 * Decode a tool call's `arguments` against the schema. Workers AI returns a
 * parsed OBJECT; OpenAI-style backends return a JSON STRING. Handle both: a
 * string is `JSON.parse`d (via the text path, which also strips any stray
 * fences); an object is decoded directly.
 */
const parseToolArguments = <A>(
  args: unknown,
  decode: (u: unknown) => Either.Either<A, ParseResult.ParseError>,
  ctx: StructuredCtx,
): Effect.Effect<A, StructuredOutputInvalid> =>
  typeof args === "string"
    ? parseStructured(args, decode, ctx)
    : decodeAgainst(args, decode, ctx, JSON.stringify(args ?? null));

/**
 * Pick the tool call to read: the one matching `name`, else the first present
 * (single-tool requests, tolerant of a provider renaming the call). Returns
 * `undefined` only when there are NO tool calls — the empty-tool_calls signal
 * that the caller turns into `bad-response` → the json auto-fallback.
 */
const firstToolCall = (
  calls: ReadonlyArray<ModelToolCall>,
  name: string,
): ModelToolCall | undefined =>
  calls.length === 0 ? undefined : (calls.find((c) => c.name === name) ?? calls[0]);

// ---------------------------------------------------------------------------
// `reviewDomain` — one domain reviewer.

/** The `report` tool's argument shape — also the json-mode response shape. */
const DomainOutput = Schema.Struct({
  findings: Schema.Array(Finding),
});

/**
 * Coerce a double-encoded `findings` field back to an array before decoding.
 *
 * Some providers (notably Workers AI tool-calling) emit a nested array field as
 * a JSON STRING — `{ "findings": "[{…}]" }` instead of `{ "findings": [{…}] }`
 * — which fails the `Schema.Array(Finding)` decode with a schema-mismatch on
 * `["findings"]`. When `findings` is a string, `JSON.parse` it and let the
 * Schema validate the result. This mirrors how `parseToolArguments` already
 * tolerates the whole tool `arguments` arriving as a string vs an object. A
 * parse failure (or a non-string `findings`) falls through unchanged so the
 * Schema decode still surfaces a precise `StructuredOutputInvalid`.
 */
const coerceDomainOutput = (value: unknown): unknown => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("findings" in value) ||
    typeof (value as { findings: unknown }).findings !== "string"
  ) {
    return value;
  }
  try {
    return {
      ...value,
      findings: JSON.parse((value as { findings: string }).findings) as unknown,
    };
  } catch {
    return value;
  }
};

/** The `report` tool's description (the tool itself is built by `completeStructured`). */
const REPORT_TOOL_DESCRIPTION =
  "Report this domain's review findings (possibly empty). Each finding is anchored to a file + line range in the diff.";

export type ReviewDomainInput = {
  /** The domain this reviewer owns — e.g. "security", "performance". */
  readonly agent: string;
  /** The (noise-stripped) unified diff text. */
  readonly diff: string;
  /** Caller-supplied system prompt; falls back to the generic default. */
  readonly systemPrompt?: string;
  /** The risk tier — passed to the prompt for context. */
  readonly tier: Tier;
  /** The model id (a bare `@cf/...` for the Workers AI binding). */
  readonly model: string;
  /** The backend name (for error reporting). */
  readonly backend: string;
  /** Output mode — "tools" (default) sends a tool; "json" parses text. */
  readonly mode?: ReviewMode;
  /**
   * Token budget for the call (the resolved backend's `maxTokens`). Falls back
   * to {@link REVIEW_MAX_TOKENS} — sized so a reasoning model can think AND emit
   * the JSON answer without truncation.
   */
  readonly maxTokens?: number;
  /**
   * Optional AWS creds — required only for `bedrock/*` models. Threaded through
   * to `completeStructured` → `completeRaw` → `modelGateway.complete`. Other
   * backends ignore.
   */
  readonly aws?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken: string;
    readonly region: string;
  };
};

/**
 * Call the model via the `modelGateway` capability, mapping its provider-agnostic
 * `ModelGatewayError` onto the engine's `ModelCallFailed` (preserving the
 * `reason` family the run's error boundary already renders).
 */
const completeRaw = (opts: {
  readonly backend: string;
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly tools?: ReadonlyArray<ModelTool>;
  readonly maxTokens?: number;
  /**
   * Optional JSON Schema for constrained decoding (`response_format`). When set,
   * a provider that supports guided generation emits schema-valid JSON by
   * construction; providers that don't ignore it and the response still falls
   * through the text extractor. Set on the json-mode path only.
   */
  readonly jsonSchema?: unknown;
  /**
   * Optional AWS credentials threaded through to the modelGateway — required
   * only for `bedrock/*` model ids (the Bedrock route SigV4-signs with these
   * short-lived STS creds). Other backends ignore this field.
   */
  readonly aws?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken: string;
    readonly region: string;
  };
}) =>
  modelGateway
    .complete({
      model: opts.model,
      system: opts.system,
      user: opts.user,
      maxTokens: opts.maxTokens ?? REVIEW_MAX_TOKENS,
      ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
      ...(opts.jsonSchema !== undefined ? { jsonSchema: opts.jsonSchema } : {}),
      ...(opts.aws !== undefined ? { aws: opts.aws } : {}),
    })
    .pipe(
      Effect.catchTag("ModelGatewayError", (e) =>
        Effect.fail(
          new ModelCallFailed({
            backend: opts.backend,
            model: e.model,
            reason: e.reason,
            message: e.message,
          }),
        ),
      ),
    );

// ---------------------------------------------------------------------------
// `completeStructured` — the REUSABLE structured-output engine.
//
// The provider-agnostic core the `pr-review` engine and any downstream recipe
// (spec-drift, ci-triage) share: ask the configured backend for one structured
// answer, decoded against a caller-supplied `Schema`. It carries the whole
// "tools vs json + auto-fallback + parse" dance so a recipe only supplies its
// schema, system prompt, and a per-mode user message renderer. No model API key
// — every call rides the `modelGateway` capability (the Workers AI binding is
// the auth).

export type CompleteStructuredInput<A> = {
  /** The backend name (for error reporting). */
  readonly backend: string;
  /** The model id (a bare `@cf/...` for the Workers AI binding). */
  readonly model: string;
  /**
   * Optional AWS creds — required only for `bedrock/*` models (the modelGateway
   * Bedrock route needs them for SigV4). Other backends ignore this field.
   */
  readonly aws?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken: string;
    readonly region: string;
  };
  /** Output mode — "tools" (default) sends a tool; "json" parses text. */
  readonly mode?: ReviewMode;
  /** The system-role instruction. */
  readonly system: string;
  /**
   * The domain-specific user-role body. The engine appends the per-mode framing
   * itself — a "call the tool" line in tools mode, or a strict-JSON instruction
   * (+ the optional {@link jsonContract}) in json mode — so a caller need not
   * restate that boilerplate (or the schema) at every call site.
   */
  readonly userBody?: string;
  /**
   * Optional one-line JSON shape (e.g. `{"items":[{"x":string}]}`) appended in
   * json mode so the model knows the exact contract. Lives next to the schema
   * at the call site; kept compact on purpose (raw draft-07 JSON Schema is far
   * more verbose and token-heavy than this TypeScript-shaped hint).
   */
  readonly jsonContract?: string;
  /**
   * Escape hatch for full control of the per-mode user message — overrides
   * {@link userBody} / {@link jsonContract}. Most callers should not need it.
   */
  readonly renderUser?: (mode: ReviewMode) => string;
  /** Schema the structured output is decoded against. */
  readonly schema: Schema.Schema<A, any>;
  /**
   * Optional pre-decode coercion (e.g. un-double-encode a nested array a
   * provider emitted as a JSON string). Applied before `schema` validation.
   */
  readonly coerce?: (value: unknown) => unknown;
  /** Tool name sent in "tools" mode (default "report"). */
  readonly toolName?: string;
  /** Tool description sent in "tools" mode. */
  readonly toolDescription?: string;
  /** Diagnostic surface label attached to `StructuredOutputInvalid`. */
  readonly surface?: string;
  /** Token budget for the call. */
  readonly maxTokens?: number;
};

/**
 * Ask the configured backend for one structured answer, Schema-validated.
 *
 * In "tools" mode the model is asked to call the named tool; if it returns zero
 * tool calls (a provider that ignores tool choice), this auto-falls-back to a
 * single "json" retry. In "json" mode it parses a strict JSON object from the
 * model's free text (stripping `<think>` blocks + code fences first).
 */
export const completeStructured = <A>(
  input: CompleteStructuredInput<A>,
): Effect.Effect<A, ModelCallFailed | StructuredOutputInvalid, ModelGateway> => {
  const mode = input.mode ?? "tools";
  const toolName = input.toolName ?? "report";
  const ctx: StructuredCtx = {
    backend: input.backend,
    model: input.model,
    surface: input.surface ?? "review",
  };
  const decode = (
    u: unknown,
  ): Either.Either<A, ParseResult.ParseError> =>
    Schema.decodeUnknownEither(input.schema)(
      input.coerce !== undefined ? input.coerce(u) : u,
    );
  const tool: ModelTool = {
    name: toolName,
    description:
      input.toolDescription ?? "Report your structured output for this task.",
    parameters: toolParametersSchema(input.schema),
  };

  // The per-mode user message: a caller-supplied `renderUser` override, else
  // the domain `userBody` with the engine's per-mode framing appended.
  const framedUser = (m: ReviewMode): string =>
    input.renderUser !== undefined
      ? input.renderUser(m)
      : frameUserMessage(input.userBody ?? "", m, {
          toolName,
          ...(input.jsonContract !== undefined
            ? { jsonContract: input.jsonContract }
            : {}),
        });

  // One json-mode attempt with a given user message + token budget — the body
  // shared by the first attempt and its repair retry.
  const runJson = (user: string, maxTokensOverride?: number) =>
    Effect.gen(function* () {
      const maxTokens = maxTokensOverride ?? input.maxTokens;
      const result = yield* completeRaw({
        backend: input.backend,
        model: input.model,
        system: input.system,
        user,
        // Constrained decoding: providers that support guided JSON emit a
        // schema-valid object directly; others ignore it and the text extractor
        // still runs. The schema mirrors the `report` tool's parameters.
        jsonSchema: toolParametersSchema(input.schema),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(input.aws !== undefined ? { aws: input.aws } : {}),
      });
      return yield* parseStructured(result.text, decode, ctx);
    });

  // Repair budget. The repair tells the model to drop the `<think>` block, so the
  // WHOLE budget now goes to the answer rather than the reasoning. Floor it at the
  // default ceiling so neither a tight operator budget NOR a first answer the
  // model truncated inside `<think>` can truncate the retry too — the structured
  // object must FIT, or we'd fail `empty`/`not-json` a second time for the very
  // same reason. `max` never lowers a configured budget; the ceiling keeps a
  // short answer cheap (`max_tokens` is a ceiling, not a target).
  const repairMaxTokens = Math.max(
    input.maxTokens ?? REVIEW_MAX_TOKENS,
    REVIEW_MAX_TOKENS,
  );

  // The json-mode attempt WITH a single repair retry. A model asked for strict
  // JSON sometimes answers in prose, or truncates inside a reasoning block —
  // leaving NO parseable JSON (`empty`) or a half-emitted value (`not-json`).
  // Re-ask ONCE with a blunt correction (and the repair budget above) before
  // giving up: one extra call that turns a hard `StructuredOutputInvalid` into a
  // real answer far more often than not. A `schema-mismatch` is NOT repaired —
  // the model DID emit JSON, just the wrong shape; `parseStructured` already kept
  // the most specific error and a blind retry rarely fixes structure. Bounded to
  // ONE retry (the repair attempt's own failure propagates), so there is no loop.
  const jsonUser = framedUser("json");
  const jsonAttempt = runJson(jsonUser).pipe(
    Effect.catchTag("StructuredOutputInvalid", (e) =>
      e.reason === "empty" || e.reason === "not-json"
        ? runJson(`${jsonUser}\n\n${JSON_REPAIR_SUFFIX}`, repairMaxTokens)
        : Effect.fail(e),
    ),
  );

  const toolsAttempt = Effect.gen(function* () {
    const result = yield* completeRaw({
      backend: input.backend,
      model: input.model,
      system: input.system,
      user: framedUser("tools"),
      tools: [tool],
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.aws !== undefined ? { aws: input.aws } : {}),
    });
    const call = firstToolCall(result.toolCalls, toolName);
    if (call === undefined) {
      // Empty / non-matching tool calls → the bad-response signal the
      // auto-fallback catches.
      return yield* Effect.fail(
        new ModelCallFailed({
          backend: input.backend,
          model: input.model,
          reason: "bad-response",
          message: `model returned no \`${toolName}\` tool call; check provider tool support`,
        }),
      );
    }
    // Workers AI returns tool args as an OBJECT; OpenAI-style as a JSON STRING.
    // `parseToolArguments` handles both before Schema-decode.
    return yield* parseToolArguments(call.arguments, decode, ctx);
  });

  return mode === "json"
    ? jsonAttempt
    : toolsAttempt.pipe(
        // Auto-fallback: a "tools" model that returned no tool call retries once
        // in json mode (the DeepSeek-via-AI-Gateway pathology). Any other
        // `ModelCallFailed` reason (and `StructuredOutputInvalid`) propagates.
        Effect.catchTag("ModelCallFailed", (e) =>
          e.reason === "bad-response" ? jsonAttempt : Effect.fail(e),
        ),
      );
};

/**
 * Run one domain reviewer. Returns its findings, Schema-validated — a thin
 * `completeStructured` over the `report` tool's `{ findings }` schema.
 */
export const reviewDomain = (
  input: ReviewDomainInput,
): Effect.Effect<
  ReadonlyArray<Finding>,
  ModelCallFailed | StructuredOutputInvalid,
  ModelGateway
> =>
  completeStructured({
    backend: input.backend,
    model: input.model,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.aws !== undefined ? { aws: input.aws } : {}),
    system: input.systemPrompt ?? DEFAULT_REVIEW_SYSTEM_PROMPT,
    userBody: renderDomainBody(input),
    jsonContract: DOMAIN_JSON_CONTRACT,
    schema: DomainOutput,
    coerce: coerceDomainOutput,
    toolName: "report",
    toolDescription: REPORT_TOOL_DESCRIPTION,
    surface: "review",
    maxTokens: input.maxTokens ?? REVIEW_MAX_TOKENS,
  }).pipe(Effect.map((o) => o.findings));

/** The domain-specific body of a reviewer's user message (no per-mode framing).
 *  Exported so the agentic reviewer (runs/mr-review-agentic.ts) builds its first
 *  user message with the SAME shape the single-shot reviewer uses. */
export const renderDomainBody = (input: ReviewDomainInput): string =>
  [
    `Review domain: ${input.agent}`,
    `Risk tier: ${input.tier}`,
    "",
    "Unified diff:",
    input.diff.length === 0 ? "(empty diff)" : input.diff,
  ].join("\n");

/** The compact JSON shape a `report` tool / json-mode reviewer must emit. */
const DOMAIN_JSON_CONTRACT = `{"findings":[{"path":string,"startLine":number,"endLine":number,"level":"notice"|"warning"|"failure","title":string,"message":string}]}`;

/**
 * Append the per-mode framing to a caller's `userBody`: a "call the tool" line
 * in tools mode, or a strict-JSON instruction (+ optional one-line contract) in
 * json mode. The single home for the framing the engine adds, so no caller —
 * `reviewDomain` or a recipe — restates it.
 */
const frameUserMessage = (
  body: string,
  mode: ReviewMode,
  opts: { toolName: string; jsonContract?: string },
): string =>
  mode === "tools"
    ? `${body}\n\nCall the \`${opts.toolName}\` tool exactly once with your output (an empty result is valid when there is nothing to report).`
    : [
        body,
        "",
        "Respond with ONLY a single JSON object — no prose, no markdown code fences, nothing before or after the object.",
        ...(opts.jsonContract !== undefined
          ? ["It must match this shape:", opts.jsonContract]
          : []),
      ].join("\n");

// ---------------------------------------------------------------------------
// `coordinate` — DETERMINISTIC assembly. No model call.
//
// The per-domain reviewers already did the hard work (each emitted a
// Schema-valid `Finding[]`). Coordination is pure bookkeeping over the current
// run's findings: dedup, count by severity, and pick a verdict by rule. Doing
// this in code (rather than
// asking a model to re-emit the whole nested `ReviewOutput` via a tool call)
// removes the only remaining `StructuredOutputInvalid` failure mode — a weak
// model could never make the verdict tool-call conform, and the tools→json
// auto-fallback didn't fire on schema-mismatch.

export type CoordinateInput = {
  /** All domains' findings for THIS run, concatenated. */
  readonly findings: ReadonlyArray<Finding>;
};

/** A finding's dedup identity — same (path, startLine, title) is the same issue. */
const findingKey = (f: Finding): string =>
  `${f.path} ${f.startLine} ${f.title}`;

/**
 * Coordinate the per-domain findings into one verdict — PURE, no model call, so
 * it can never produce `StructuredOutputInvalid`. Returns `CoordinatedReview`
 * (no `tier` — the run stitches that back on from its plan).
 *
 *   - dedup by (path, startLine, title), keeping the first occurrence;
 *   - counts straight from `level` (failure/warning/notice);
 *   - verdict by rule: any failure → request-changes; else any warning →
 *     comment; else approve (bias toward approval unless critical).
 *
 * The current run is AUTHORITATIVE — only the findings the reviewers raise on
 * this push count. Nothing is carried over from a prior run, so a finding the
 * author has fixed (no longer in the diff → not re-raised) clears on its own and
 * the verdict can return to `approve`.
 */
export const coordinate = (
  input: CoordinateInput,
): Effect.Effect<CoordinatedReviewType> =>
  Effect.sync(() => coordinateReview(input));

/** The pure core of {@link coordinate} — exported for direct unit testing. */
export const coordinateReview = (
  input: CoordinateInput,
): CoordinatedReviewType => {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const f of input.findings) {
    const key = findingKey(f);
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(f);
  }

  const critical = findings.filter((f) => f.level === "failure").length;
  const warnings = findings.filter((f) => f.level === "warning").length;
  const suggestions = findings.filter((f) => f.level === "notice").length;

  const verdict: CoordinatedReviewType["verdict"] =
    critical > 0 ? "request-changes" : warnings > 0 ? "comment" : "approve";

  return { verdict, critical, warnings, suggestions, findings };
};

// ---------------------------------------------------------------------------
// `riskTier` — PURE heuristic. No model call.

/**
 * Path fragments that, when touched, escalate the tier. A change to CI,
 * dependency manifests, auth, or infra is never "trivial".
 */
const SENSITIVE_PATH_FRAGMENTS = [
  ".github/",
  "Dockerfile",
  "wrangler.",
  "package.json",
  "pnpm-lock",
  "/auth",
  "/security",
  "/secrets",
  "migration",
  "infra/",
] as const;

export type RiskTierInput = {
  /** The (noise-stripped) unified diff text. */
  readonly diff: string;
};

/** Thresholds for the size heuristic — changed-line counts. */
export const RISK_THRESHOLDS = { trivial: 25, lite: 200 } as const;

/**
 * Classify a diff into a risk tier from its size + touched paths. Pure +
 * deterministic — no model call, no I/O.
 *
 *   - any sensitive path touched           → full
 *   - > `lite` changed lines               → full
 *   - > `trivial` changed lines            → lite
 *   - otherwise                            → trivial
 *
 * An empty diff is `trivial`.
 */
export const riskTier = (
  input: RiskTierInput,
): Effect.Effect<Tier> =>
  Effect.sync(() => classifyRisk(input.diff));

/** The pure core of {@link riskTier} — exported for direct unit testing. */
export const classifyRisk = (diff: string): Tier => {
  const lines = diff.split("\n");

  // Changed lines: added/removed content lines, excluding the +++/--- headers.
  const changed = lines.filter(
    (l) =>
      (l.startsWith("+") || l.startsWith("-")) &&
      !l.startsWith("+++") &&
      !l.startsWith("---"),
  ).length;

  // Touched paths: the `+++ b/<path>` headers of the unified diff.
  const touchedPaths = lines
    .filter((l) => l.startsWith("+++ "))
    .map((l) => l.replace(/^\+\+\+\s+(?:b\/)?/, "").trim());

  const touchesSensitive = touchedPaths.some((p) =>
    SENSITIVE_PATH_FRAGMENTS.some((frag) => p.includes(frag)),
  );

  if (touchesSensitive) return "full";
  if (changed > RISK_THRESHOLDS.lite) return "full";
  if (changed > RISK_THRESHOLDS.trivial) return "lite";
  return "trivial";
};

// Recipe: AI code review on every GitLab merge request (PoC).
//
// The GitLab sibling of `pr-review`, built on the SAME Worker-side review engine
// (`@flare-dispatch/review-agent`) but through the provider-neutral `scm`
// capability instead of the GitHub-specific `github` capability. One review
// engine, two providers: `scm.fetchDiff` gets the MR's unified diff, the engine
// fans out domain reviewers via `modelGateway` (Workers AI binding — the binding
// is the auth, no model key), and `scm.postReview` posts the visible note.
//
// --- Deliberately smaller than pr-review (this is a PoC) ---------------------
//
//   * NO container / git checkout — the diff comes from the GitLab API, not a
//     `git diff` in a sandbox. So no `sandbox`, no oxlint grounding, no
//     writeback, no `step(...)` checkpoints: the whole review is one flat Effect
//     the PoC Workflow (apps/dispatcher/src/workflow-gitlab.ts) runs inside a
//     single durable step.
//   * Requirements are exactly `Config | ModelGateway | Scm` — the three Layers
//     the PoC Workflow builds. The run is still a `defineRun` value (for the
//     trigger/contract metadata + registry shape), but the Workflow executes the
//     underlying `mrReviewProgram` directly with that minimal stack.
//
// --- CONFIG the operator sets (out of band) — REUSES the pr-review.* keys -----
//
// The operator configures ONE place: `pr-review.backend`, `pr-review.agents`,
// `pr-review.workers-ai.model`, `pr-review.guidelines`, … (see runs/pr-review.ts
// and packages/review-agent/src/backend.ts). This run reads the same namespace so
// a deploy that already tuned pr-review needs no GitLab-specific config.
//
// Mode: GitLab merge_request webhook (open / reopen / update). Config namespace:
// the shared `pr-review` (DEFAULT_NAMESPACE).

import { Effect, Either, Match, Schema } from "effect";
import {
  config,
  defineRun,
  type ModelGateway,
  scm,
  type Scm,
  ScmError,
  StepFailed,
  type ChangeRef,
  type Config,
} from "@flare-dispatch/core";
import {
  BackendUnconfigured,
  capDiff,
  coordinate as engineCoordinate,
  DEFAULT_NAMESPACE,
  DEFAULT_REVIEW_SYSTEM_PROMPT,
  type Finding,
  guidelinesKey,
  ModelCallFailed,
  resolveBackend,
  ReviewOutputSchema,
  reviewDomain,
  riskTier,
  stripDiffNoise,
  StructuredOutputInvalid,
  type Tier,
} from "@flare-dispatch/review-agent";

/** Footer marker on every MR note this run posts — for idempotent updates. */
const COMMENT_MARKER = "<!-- flare-dispatch: mr-review -->";

/** Config namespace — SHARED with pr-review so operators configure one place. */
const NS = DEFAULT_NAMESPACE;

// The domain-scoped reviewers, one per concern — the same sets pr-review uses.
const FULL_AGENTS = [
  "security",
  "performance",
  "code-quality",
  "documentation",
  "release-management",
  "compliance",
] as const;
const LITE_AGENTS = ["security", "code-quality", "performance", "documentation"] as const;
const TRIVIAL_AGENTS = ["code-quality"] as const;
const GENERAL_AGENT = ["general"] as const;

const AGENT_MODES = ["single", "multi"] as const;
type AgentMode = (typeof AGENT_MODES)[number];
// The PoC defaults to a SINGLE generalist reviewer (cheapest path to a review);
// an operator opts into the tier-scaled persona fan-out with `pr-review.agents=multi`.
const DEFAULT_AGENT_MODE: AgentMode = "single";

const parseAgentMode = (raw: string | undefined): AgentMode =>
  AGENT_MODES.includes(raw as AgentMode) ? (raw as AgentMode) : DEFAULT_AGENT_MODE;

/** The run inputs — extracted from the GitLab merge_request webhook payload. */
export const MrReviewInput = Schema.Struct({
  /** Numeric project id (as a string) or `"group/project"` path. */
  projectId: Schema.String,
  /** The merge-request `iid` (project-scoped id). */
  iid: Schema.Number,
  /** The MR head SHA (the reviewed commit). */
  headSha: Schema.String,
  /** The MR base SHA (three-dot diff endpoint — GitLab's `diff_refs.base_sha`). */
  baseSha: Schema.String,
  /** The project web URL (e.g. `https://gitlab.com/group/project`) — for blob links. */
  projectWebUrl: Schema.String,
  /** Source branch — context only. */
  sourceBranch: Schema.optional(Schema.String),
  /** Target branch — context only. */
  targetBranch: Schema.optional(Schema.String),
});
export type MrReviewInput = typeof MrReviewInput.Type;

type Plan = { readonly tier: Tier; readonly agents: readonly string[] };

const planForTier = (tier: Tier): Plan =>
  Match.value(tier).pipe(
    Match.when("trivial", () => ({ tier: "trivial" as const, agents: TRIVIAL_AGENTS })),
    Match.when("lite", () => ({ tier: "lite" as const, agents: LITE_AGENTS })),
    Match.when("full", () => ({ tier: "full" as const, agents: FULL_AGENTS })),
    Match.exhaustive,
  );

const planForMode = (mode: AgentMode, tier: Tier): Plan =>
  mode === "single" ? { tier, agents: GENERAL_AGENT } : planForTier(tier);

/**
 * The MR review program — a flat Effect over `Config | ModelGateway | Scm`.
 * Exported so the PoC Workflow runs it directly with a minimal Layer stack
 * (no container / step machinery). Always posts a note — success OR failure —
 * then returns the review output (or re-fails as `StepFailed` on any error).
 */
export const mrReviewProgram = (
  input: MrReviewInput,
): Effect.Effect<typeof ReviewOutputSchema.Type, StepFailed, Config | ModelGateway | Scm> =>
  reviewBody(input).pipe(
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        const reason = describeError(err);
        // Best-effort failure note — a post failure must not mask the cause.
        yield* postNote(
          input,
          [`⚠️ **mr-review could not complete**: ${reason}`, "", COMMENT_MARKER].join("\n"),
        ).pipe(
          Effect.catchAll((postErr) =>
            Effect.logWarning(`mr-review: failure-note post failed — ${describeError(postErr)}`),
          ),
        );
        return yield* Effect.fail(new StepFailed({ step: "mr-review", cause: reason }));
      }),
    ),
  );

const reviewBody = (input: MrReviewInput) =>
  Effect.gen(function* () {
    // 1. Resolve the configurable backend (shared pr-review.* namespace) FIRST,
    //    so a misconfigured backend fails fast → the boundary posts a note.
    const resolved = yield* resolveBackend((key) => config.get(key), { namespace: NS });

    // 2. Fetch the MR diff via the neutral `scm` capability (GitLab Layer backs
    //    it). Noise-strip + backend-sized cap so the model context isn't blown.
    const ref = refFor(input);
    const rawDiff = yield* scm.fetchDiff(ref);
    const diff = capDiff(stripDiffNoise(rawDiff), resolved.maxDiffChars);

    // 3. Risk tier — pure heuristic on diff size + touched paths.
    const tier = yield* riskTier({ diff });

    // 4. Agent fan-out mode — single generalist (default) vs tier-scaled personas.
    const agentMode = parseAgentMode(yield* config.get("pr-review.agents"));
    const plan = planForMode(agentMode, tier);

    // 5. Reviewer system prompt — base + optional operator guidelines.
    const guidelines = yield* config.get(guidelinesKey(NS));
    const systemPrompt = composeSystemPromptLocal(DEFAULT_REVIEW_SYSTEM_PROMPT, guidelines);

    // 6. Fault-isolated fan-out — one reviewer per domain, in parallel. A domain
    //    whose model call fails is dropped to zero findings; the review still
    //    ships. Only if EVERY reviewer fails do we re-raise (the typed cause).
    const results = yield* Effect.forEach(
      plan.agents,
      (agent) =>
        reviewDomain({
          agent,
          diff,
          tier: plan.tier,
          model: resolved.model,
          backend: resolved.backend,
          mode: resolved.mode,
          maxTokens: resolved.maxTokens,
          systemPrompt,
        }).pipe(Effect.either),
      { concurrency: plan.agents.length },
    );
    const firstLeft = results.find(Either.isLeft);
    if (firstLeft !== undefined && results.every(Either.isLeft)) {
      return yield* Effect.fail(firstLeft.left);
    }
    const findings: ReadonlyArray<Finding> = results.flatMap((r) =>
      Either.isRight(r) ? r.right : [],
    );

    // 7. Coordinate — pure deterministic dedup + counts + verdict.
    const coordinated = yield* engineCoordinate({ findings });
    const output = { ...coordinated, tier: plan.tier };

    // 8. Post the visible MR note. Best-effort — a note failure must not turn a
    //    green review red.
    yield* postNote(input, renderReviewComment(input, output)).pipe(
      Effect.catchAll((e) =>
        Effect.logWarning(`mr-review: posting MR note failed — ${describeError(e)}`),
      ),
    );

    return output;
  });

// ---------------------------------------------------------------------------
// Helpers.

const refFor = (input: MrReviewInput): ChangeRef => ({
  project: input.projectId,
  number: input.iid,
  headSha: input.headSha,
  baseSha: input.baseSha,
});

const postNote = (input: MrReviewInput, body: string) =>
  scm.postReview({ ref: refFor(input), body });

/** Compose the reviewer system prompt — base + optional operator guidelines. */
const composeSystemPromptLocal = (base: string, guidelines: string | undefined): string => {
  const g = guidelines?.trim();
  return g !== undefined && g !== ""
    ? `${base.trim()}\n\nAdditional review guidelines — treat these as authoritative house rules:\n${g}`
    : base.trim();
};

/** Human-readable one-liner for any error the boundary catches. */
const describeError = (err: unknown): string => {
  if (err instanceof BackendUnconfigured) {
    return `backend "${err.backend}" is misconfigured — set ${err.missing}`;
  }
  if (err instanceof ModelCallFailed) {
    return `model call failed (${err.reason}): ${err.message}`;
  }
  if (err instanceof StructuredOutputInvalid) {
    return `model returned unparseable ${err.surface} output (${err.reason}); the backend may need \`mode: "json"\` or a different model`;
  }
  if (err instanceof ScmError) {
    return `GitLab (${err.provider}) request failed (${err.reason}): ${err.message}`;
  }
  return err instanceof Error ? err.message : JSON.stringify(err);
};

// --- Comment rendering (GitLab flavour) -------------------------------------

const SANITIZE_MAX = 500;
// U+200B zero-width space — inserted after `@` breaks GitLab's @mention autolink
// without visibly altering the text (mirrors pr-review's defence).
const ZWSP = String.fromCharCode(0x200b);
/** Neutralize model-authored text before it renders in the public MR note. */
const sanitizeModelText = (s: string): string =>
  s
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "")
    .replace(/`/g, "'")
    .replace(/@(?=[\w-])/g, `@${ZWSP}`)
    .slice(0, SANITIZE_MAX);

/**
 * GitLab blob URL for a finding — `<web_url>/-/blob/<sha>/<path>#L<n>`. `web_url`
 * + `sha` come from the trusted webhook input; `path` is model-authored, so each
 * segment is sanitized then URL-encoded. The line fragment is dropped when the
 * model's line numbers are nonsense (≤ 0), leaving a plain file link.
 */
const findingUrl = (webUrl: string, sha: string, f: Finding): string => {
  const encodedPath = sanitizeModelText(f.path)
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");
  const start = Math.floor(f.startLine);
  const end = Math.floor(f.endLine);
  const fragment = start > 0 ? (end > start ? `#L${start}-${end}` : `#L${start}`) : "";
  return `${webUrl.replace(/\/$/, "")}/-/blob/${sha}/${encodedPath}${fragment}`;
};

const findingLoc = (f: Finding): string => {
  const path = sanitizeModelText(f.path).replace(/[[\]]/g, "");
  return f.startLine === f.endLine ? `${path}:${f.startLine}` : `${path}:${f.startLine}-${f.endLine}`;
};

const tableCell = (s: string): string => sanitizeModelText(s).replace(/\|/g, "\\|");

const severityBadge = (level: Finding["level"]): string =>
  Match.value(level).pipe(
    Match.when("failure", () => "🛑 Critical"),
    Match.when("warning", () => "⚠️ Warning"),
    Match.when("notice", () => "💡 Suggestion"),
    Match.exhaustive,
  );

/** How many findings render in the note before the overflow line. */
const MAX_RENDERED_FINDINGS = 25;

/** Render the consolidated review as a GitLab-flavoured markdown note. */
const renderReviewComment = (
  input: Pick<MrReviewInput, "projectWebUrl" | "headSha">,
  output: typeof ReviewOutputSchema.Type,
): string => {
  const verdictBadge = Match.value(output.verdict).pipe(
    Match.when("approve", () => "✅ Approve"),
    Match.when("comment", () => "💬 Comment"),
    Match.when("request-changes", () => "🛑 Request changes"),
    Match.exhaustive,
  );

  const header = [
    `### AI code review — ${verdictBadge}`,
    "",
    `Risk tier: \`${output.tier}\` · ${output.critical} critical · ${output.warnings} warnings · ${output.suggestions} suggestions`,
  ];

  const rendered = output.findings.slice(0, MAX_RENDERED_FINDINGS);
  const url = (f: Finding) => findingUrl(input.projectWebUrl, input.headSha, f);

  const findingsBlock =
    output.findings.length === 0
      ? ["", "_No findings._"]
      : [
          "",
          "| # | Severity | Change required | Location |",
          "| --- | --- | --- | --- |",
          ...rendered.map(
            (f, i) =>
              `| ${i + 1} | ${severityBadge(f.level)} | ${tableCell(f.title)} | [${tableCell(findingLoc(f))}](${url(f)}) |`,
          ),
          ...rendered.flatMap((f, i) => [
            "",
            `#### ${i + 1}. ${severityBadge(f.level)} — ${sanitizeModelText(f.title)}`,
            "",
            `📍 [${findingLoc(f)}](${url(f)})`,
            "",
            sanitizeModelText(f.message),
          ]),
          ...(output.findings.length > MAX_RENDERED_FINDINGS
            ? ["", `_…and ${output.findings.length - MAX_RENDERED_FINDINGS} more._`]
            : []),
        ];

  return [...header, ...findingsBlock, "", COMMENT_MARKER].join("\n");
};

// --- The defineRun value (trigger + contract metadata + registry shape) ------
//
// The GitLab MR webhook payload the trigger narrows. The PoC webhook route
// (apps/dispatcher/src/routes/webhook-gitlab.ts) extracts the params directly,
// but the trigger's `inputs`/`gate` are the canonical mapping (and what the
// upstream registry path would use). `actions` filters on
// `object_attributes.action`.
export const mrReview = defineRun({
  name: "mr-review",
  version: "0.1.0",

  triggers: [
    {
      event: "merge_request",
      actions: ["open", "reopen", "update"],
      idempotencyKey: ({ payload }) =>
        `mr-review:${payload.project?.id}:${payload.object_attributes?.iid}:${String(
          payload.object_attributes?.last_commit?.id ?? "",
        ).slice(0, 12)}`,
      // Only a genuine merge_request event (defence in depth over the webhook
      // route's own `object_kind` check).
      gate: ({ payload }) => payload.object_kind === "merge_request",
      inputs: ({ payload }) => mrInputsFromPayload(payload),
    },
  ],

  inputs: MrReviewInput,
  outputs: ReviewOutputSchema,
  limits: { maxDurationSec: 300 },

  run: (input) => mrReviewProgram(input),
});

/**
 * Extract the run inputs from a GitLab merge_request webhook payload. Prefers
 * `diff_refs.base_sha`/`head_sha` (the exact three-dot endpoints GitLab renders)
 * with `oldrev` / `last_commit.id` fallbacks. Exported for the webhook route +
 * tests so ONE mapping is authoritative.
 */
export const mrInputsFromPayload = (payload: {
  project?: { id?: number; web_url?: string };
  object_attributes?: {
    iid?: number;
    last_commit?: { id?: string };
    oldrev?: string;
    diff_refs?: { base_sha?: string; head_sha?: string };
  };
}): MrReviewInput => {
  const oa = payload.object_attributes ?? {};
  const headSha = oa.diff_refs?.head_sha ?? oa.last_commit?.id ?? "";
  const baseSha = oa.diff_refs?.base_sha ?? oa.oldrev ?? "";
  return {
    projectId: String(payload.project?.id ?? ""),
    iid: oa.iid ?? 0,
    headSha,
    baseSha,
    projectWebUrl: payload.project?.web_url ?? "",
  };
};

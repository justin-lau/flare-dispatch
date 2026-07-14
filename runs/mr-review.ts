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

import { Effect, Either, Match, Ref, Schema } from "effect";
import {
  config,
  defineRun,
  ModelGateway,
  type ModelGatewayService,
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
  encodeFindingPath,
  type Finding,
  findingLoc,
  guidelinesKey,
  ModelCallFailed,
  resolveBackend,
  ReviewOutputSchema,
  reviewDomain,
  riskTier,
  sanitizeModelText,
  stripDiffNoise,
  StructuredOutputInvalid,
  tableCell,
  type Tier,
} from "@flare-dispatch/review-agent";
import {
  type CostUsage,
  costFooter,
  type ModelPricing,
  parsePricingOverride,
  pricingKey,
  resolvePricing,
} from "./mr-review-cost";
import {
  changedPaths,
  composeGroundedInput,
  deriveQueries,
  fetchContext,
  type GroundingConfig,
} from "./mr-review-grounding";

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

type ReviewOutput = typeof ReviewOutputSchema.Type;

/**
 * The result of {@link mrReviewCompute}:
 *
 *   * `status` — the terminal outcome the D1 row records:
 *       - `success`       a review ran (approve / comment / request-changes).
 *       - `failure`       the review could not complete (non-quota error).
 *       - `skipped-quota` the model quota was exhausted (rate-limited) — the run
 *                         degrades gracefully: NO note is posted, just a warning.
 *   * `output` — the review verdict (`null` on failure / skipped-quota).
 *   * `noteBody` — the FULLY RENDERED note body to post, or `null` when nothing
 *                  should be posted (skipped-quota). Carrying the body (rather
 *                  than posting inline) lets the caller post it as a SEPARATE
 *                  durable step (see {@link mrPostNote}).
 *   * `usage` — aggregated model token usage across the fan-out (`null` when the
 *               review didn't run) — persisted into the D1 `summary_json`.
 *   * `grounded` — whether hakiri retrieval context was injected into the model
 *                  prompt (the A/B arm) — persisted into the D1 `summary_json`.
 */
export type MrComputeResult = {
  readonly status: "success" | "failure" | "skipped-quota";
  readonly output: ReviewOutput | null;
  readonly noteBody: string | null;
  readonly usage: CostUsage | null;
  readonly grounded: boolean;
};

/** Render the "could not complete" failure note — the reason is model-influenced
 *  (it can carry provider/model error text), so it is sanitized before it lands
 *  in the public note. */
export const failureNote = (reason: string): string =>
  [`⚠️ **mr-review could not complete**: ${sanitizeModelText(reason)}`, "", COMMENT_MARKER].join(
    "\n",
  );

/**
 * The review COMPUTE — resolve backend, fetch the diff, fan out reviewers,
 * coordinate, and RENDER the note — but do NOT post. Never fails: any error is
 * caught and rendered into a "could not complete" note body with `output: null`.
 * A flat Effect over `Config | ModelGateway | Scm`.
 *
 * Posting is the caller's separate concern (a distinct Workflow step) so a
 * mid-flight replay re-runs neither the model fan-out NOR the note post twice.
 */
export const mrReviewCompute = (
  input: MrReviewInput,
): Effect.Effect<MrComputeResult, never, Config | ModelGateway | Scm> =>
  reviewBody(input).pipe(
    Effect.map((r): MrComputeResult => {
      const footer = costFooter({ model: r.model, usage: r.usage, pricing: r.pricing });
      return {
        status: "success",
        output: r.output,
        usage: r.usage,
        grounded: r.grounded,
        noteBody: renderReviewComment(input, r.output, footer),
      };
    }),
    Effect.catchAll((err) =>
      // QUOTA-GRACEFUL DEGRADATION: a rate-limited model failure (free-plan
      // neuron exhaustion → 429) is NOT posted as a failure note — it just logs a
      // warning and records `skipped-quota` so a burned-through daily allowance
      // doesn't spam every open MR with a scary "could not complete" note. Any
      // OTHER failure keeps the visible failure note.
      isRateLimited(err)
        ? Effect.logWarning(
            `mr-review: model quota exhausted (rate-limited) — skipping MR note for project ${input.projectId} !${input.iid}`,
          ).pipe(
            Effect.as<MrComputeResult>({
              status: "skipped-quota",
              output: null,
              usage: null,
              grounded: false,
              noteBody: null,
            }),
          )
        : Effect.succeed<MrComputeResult>({
            status: "failure",
            output: null,
            usage: null,
            grounded: false,
            noteBody: failureNote(describeError(err)),
          }),
    ),
  );

/** A rate-limited model failure — the ONLY error that degrades to skipped-quota
 *  (matched on the typed `reason`, never a message string). */
const isRateLimited = (err: unknown): boolean =>
  err instanceof ModelCallFailed && err.reason === "rate-limited";

/** Post a review note for a change. Exported so the PoC Workflow posts it as its
 *  OWN durable step (idempotent — a replay after a completed post never re-posts). */
export const mrPostNote = (input: MrReviewInput, body: string) =>
  scm.postReview({ ref: refFor(input), body });

/**
 * The standalone run program — a flat Effect over `Config | ModelGateway | Scm`
 * (used by the `defineRun` value). Computes, posts the note best-effort, then
 * returns the output on success or re-fails as `StepFailed` on a failure verdict
 * so a red review is honest. (The PoC Workflow instead calls `mrReviewCompute` +
 * `mrPostNote` as two steps — see workflow-gitlab.ts.)
 */
export const mrReviewProgram = (
  input: MrReviewInput,
): Effect.Effect<ReviewOutput, StepFailed, Config | ModelGateway | Scm> =>
  mrReviewCompute(input).pipe(
    Effect.flatMap((r) => {
      // A `null` body means "post nothing" (skipped-quota) — otherwise post
      // best-effort (a post failure must not mask the review's verdict).
      const post =
        r.noteBody !== null
          ? mrPostNote(input, r.noteBody).pipe(
              Effect.catchAll((e) =>
                Effect.logWarning(`mr-review: posting MR note failed — ${describeError(e)}`),
              ),
            )
          : Effect.void;
      return post.pipe(
        Effect.flatMap(() =>
          r.output !== null
            ? Effect.succeed(r.output)
            : Effect.fail(
                new StepFailed({
                  step: "mr-review",
                  cause:
                    r.status === "skipped-quota"
                      ? "model quota exhausted — review skipped"
                      : "review could not complete",
                }),
              ),
        ),
      );
    }),
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

    // 3. Risk tier — pure heuristic on the REAL diff (grounding, added below,
    //    must not inflate the diff size the tier heuristic sees).
    const tier = yield* riskTier({ diff });

    // 3b. Optional retrieval grounding (CONFIG_KV-gated, OFF by default). When
    //     `pr-review.hakiri.endpoint` is set, fetch surrounding code from the
    //     context store and PREPEND it to the diff as a delimited block — the
    //     real diff is passed through intact, the context is ADDITIONAL headroom.
    //     Best-effort: `fetchContext` never fails, and an empty result leaves the
    //     run diff-only. `grounded` records whether context actually reached the
    //     model (the A/B arm), persisted into summary_json.
    const grounding = yield* resolveGrounding((key) => config.get(key));
    let modelDiff = diff;
    let grounded = false;
    if (grounding !== undefined) {
      const context = yield* fetchContext({
        config: grounding,
        queries: deriveQueries(diff),
        paths: changedPaths(diff),
      });
      if (context.length > 0) {
        modelDiff = composeGroundedInput(context, diff);
        grounded = true;
      }
    }

    // 4. Agent fan-out mode — single generalist (default) vs tier-scaled personas.
    const agentMode = parseAgentMode(yield* config.get("pr-review.agents"));
    const plan = planForMode(agentMode, tier);

    // 5. Reviewer system prompt — base + optional operator guidelines.
    const guidelines = yield* config.get(guidelinesKey(NS));
    const systemPrompt = composeSystemPromptLocal(DEFAULT_REVIEW_SYSTEM_PROMPT, guidelines);

    // 6. Usage metering — wrap the ModelGateway from context so every
    //    `complete` on the fan-out ADDS its reported token usage to a Ref. This
    //    taps the seam WITHOUT touching the shared review engine (which just sees
    //    a normal ModelGateway); models that report no usage add zero.
    const usageRef = yield* Ref.make<CostUsage>({ inputTokens: 0, outputTokens: 0 });
    const baseGateway = yield* ModelGateway;
    const metering: ModelGatewayService = {
      complete: (req) =>
        baseGateway.complete(req).pipe(
          Effect.tap((res) =>
            Ref.update(usageRef, (u) => {
              // Sum provider cost + reasoning tokens across the fan-out, keeping
              // them undefined unless SOME call reported them (so the footer
              // falls back to the pricing table when no provider cost exists).
              const costUsd = addOptional(u.costUsd, res.costUsd);
              const reasoningTokens = addOptional(u.reasoningTokens, res.reasoningTokens);
              return {
                inputTokens: u.inputTokens + (res.inputTokens ?? 0),
                outputTokens: u.outputTokens + (res.outputTokens ?? 0),
                ...(costUsd !== undefined ? { costUsd } : {}),
                ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
              };
            }),
          ),
        ),
    };

    // 7. Fault-isolated fan-out — one reviewer per domain, in parallel, each
    //    provided the metering gateway. A domain whose model call fails is
    //    dropped to zero findings; the review still ships. Only if EVERY reviewer
    //    fails do we re-raise (the typed cause — rate-limited surfaces here).
    const results = yield* Effect.forEach(
      plan.agents,
      (agent) =>
        reviewDomain({
          agent,
          diff: modelDiff,
          tier: plan.tier,
          model: resolved.model,
          backend: resolved.backend,
          mode: resolved.mode,
          maxTokens: resolved.maxTokens,
          systemPrompt,
        }).pipe(Effect.either, Effect.provideService(ModelGateway, metering)),
      { concurrency: plan.agents.length },
    );
    const firstLeft = results.find(Either.isLeft);
    if (firstLeft !== undefined && results.every(Either.isLeft)) {
      return yield* Effect.fail(firstLeft.left);
    }
    const findings: ReadonlyArray<Finding> = results.flatMap((r) =>
      Either.isRight(r) ? r.right : [],
    );

    // 8. Coordinate — pure deterministic dedup + counts + verdict. Rendering +
    //    posting the note is the caller's concern (mrReviewCompute → mrPostNote).
    const coordinated = yield* engineCoordinate({ findings });

    // 9. Aggregate usage + resolve the model's price (operator CONFIG_KV override
    //    over the built-in table) so the caller can render the cost footer.
    const usage = yield* Ref.get(usageRef);
    const pricing: ModelPricing | undefined = resolvePricing(
      resolved.model,
      parsePricingOverride(yield* config.get(pricingKey(resolved.model))),
    );
    return {
      output: { ...coordinated, tier: plan.tier },
      usage,
      model: resolved.model,
      pricing,
      grounded,
    };
  });

/**
 * Resolve the grounding config from CONFIG_KV — `undefined` when
 * `pr-review.hakiri.endpoint` is unset/blank (grounding OFF, today's behaviour).
 */
const resolveGrounding = (
  get: (key: string) => Effect.Effect<string | undefined, never, Config>,
): Effect.Effect<GroundingConfig | undefined, never, Config> =>
  Effect.gen(function* () {
    const endpoint = (yield* get("pr-review.hakiri.endpoint"))?.trim();
    if (endpoint === undefined || endpoint === "") return undefined;
    const token = (yield* get("pr-review.hakiri.token"))?.trim();
    return {
      endpoint,
      ...(token !== undefined && token !== "" ? { token } : {}),
    };
  });

// ---------------------------------------------------------------------------
// Helpers.

/** Sum two optional numbers, staying `undefined` only when BOTH are absent. */
const addOptional = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

export const refFor = (input: MrReviewInput): ChangeRef => ({
  project: input.projectId,
  number: input.iid,
  headSha: input.headSha,
  baseSha: input.baseSha,
});

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
//
// The provider-agnostic sanitizers (sanitizeModelText / encodeFindingPath /
// findingLoc / tableCell) come from @flare-dispatch/review-agent — ONE audited
// copy shared with the GitHub path (pr-review keeps its byte-identical private
// copies for now; see specs/11-gitlab-poc.md). Only the GitLab-specific blob-URL
// shape lives here.

/**
 * GitLab blob URL for a finding — `<web_url>/-/blob/<sha>/<path>#L<n>`. `web_url`
 * + `sha` come from the trusted webhook input; `path` is model-authored, so it is
 * sanitized + URL-encoded by the shared `encodeFindingPath`. The line fragment is
 * dropped when the model's line numbers are nonsense (≤ 0), leaving a plain file
 * link. NB the GitLab fragment is `#L<start>-<end>` (GitHub uses `-L<end>`).
 */
const findingUrl = (webUrl: string, sha: string, f: Finding): string => {
  const encodedPath = encodeFindingPath(f.path);
  const start = Math.floor(f.startLine);
  const end = Math.floor(f.endLine);
  const fragment = start > 0 ? (end > start ? `#L${start}-${end}` : `#L${start}`) : "";
  return `${webUrl.replace(/\/$/, "")}/-/blob/${sha}/${encodedPath}${fragment}`;
};

const severityBadge = (level: Finding["level"]): string =>
  Match.value(level).pipe(
    Match.when("failure", () => "🛑 Critical"),
    Match.when("warning", () => "⚠️ Warning"),
    Match.when("notice", () => "💡 Suggestion"),
    Match.exhaustive,
  );

/** How many findings render in the note before the overflow line. */
const MAX_RENDERED_FINDINGS = 25;

/** Render the consolidated review as a GitLab-flavoured markdown note. The
 *  optional `footer` (the per-run cost line) renders just above the marker; it is
 *  `null` when the model reported no usage (see {@link costFooter}). */
export const renderReviewComment = (
  input: Pick<MrReviewInput, "projectWebUrl" | "headSha">,
  output: typeof ReviewOutputSchema.Type,
  footer: string | null,
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

  return [
    ...header,
    ...findingsBlock,
    "",
    ...(footer !== null ? [footer, ""] : []),
    COMMENT_MARKER,
  ].join("\n");
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

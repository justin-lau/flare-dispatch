// @flare-dispatch/core — the `scm` capability (provider-neutral source control).
//
// The NEUTRAL SEAM for "fetch a change's diff" + "post a review note", modelled
// directly on the `modelGateway` precedent: the interface names the CAPABILITY,
// never a provider. `Github` (services/github.ts) is GitHub-shaped by design —
// repo slugs, installation ids, check-runs, the Git Data API. `Scm` is the
// smaller, portable surface a review recipe actually needs, so ONE run body can
// review a GitHub PR or a GitLab merge request unchanged: the runtime picks the
// Layer (a `makeGitlabScmLive` in @flare-dispatch/runtime-cf backs it with the
// GitLab REST API; a `makeGithubScmLive` could back the same Tag with the
// github-app plumbing) and the run just yields the Tag, the way it already
// yields `config` / `modelGateway`.
//
// Deliberately tiny — two methods, no writes beyond a single review note, no
// enumeration, no installation flow. The `Github` capability keeps the richer,
// GitHub-specific surface (PR sweeps, draft-PR writeback, releases); `Scm` is
// the provider-blind subset the `pr-review` / `mr-review` engine reuses.
//
// --- Errors: provider-agnostic, no HTTP statuses -----------------------------
//
// `ScmError.reason` is a closed literal union the run's error boundary renders —
// the SAME posture as `ModelGatewayError` (services/model-gateway.ts): a Layer
// maps its provider's failures (a 401, a fetch reject, an unparseable body) onto
// one of these reasons; the port never leaks an HTTP status or a provider name
// into the run. `provider` carries the backing provider ("gitlab" / "github")
// for the operator-facing message only, not for control flow.

import { Context, Effect, Schema } from "effect";

/**
 * A change under review — one PR / merge request. Provider-neutral:
 *
 *   - `project` — the repository identity the backing Layer interprets. For a
 *     GitHub Layer it is the `"owner/name"` slug; for a GitLab Layer it is the
 *     numeric project id or the URL-encoded `"group/project"` path. The port
 *     does not care which — the Layer that mints the API URL does.
 *   - `number`  — the change number the provider addresses it by (a GitHub PR
 *     number, a GitLab merge-request `iid`).
 *   - `headSha` / `baseSha` — the two endpoints of the reviewable diff. Callers
 *     produce a three-dot (`base...head`) diff so it matches what the provider's
 *     own UI renders (see the run that consumes this).
 */
export type ChangeRef = {
  readonly project: string;
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
};

/** A top-level review note to post back onto a change. */
export type ReviewNote = {
  readonly ref: ChangeRef;
  /** Markdown body of the note. */
  readonly body: string;
};

/**
 * An `scm` operation failed at the backing provider — a transport / auth / rate
 * failure or an unusable response. Provider-agnostic by construction (no HTTP
 * status, no provider-specific endpoint): the Layer maps its provider error onto
 * one of these `reason`s, mirroring `ModelGatewayError`. `provider` names the
 * backing provider for the operator-facing message only.
 */
export class ScmError extends Schema.TaggedError<ScmError>()("ScmError", {
  /** The backing provider, for the operator-facing reason string ("gitlab"). */
  provider: Schema.String,
  reason: Schema.Literal(
    "auth-failed",
    "not-found",
    "rate-limited",
    "bad-response",
    "unknown",
  ),
  message: Schema.String,
}) {}

/** The service contract a runtime Layer implements. */
export interface ScmService {
  /**
   * Fetch the change's unified diff — the reviewable text the engine feeds the
   * model. The Layer assembles it from the provider's diff API into a standard
   * `git`-style unified diff (`diff --git` / `---` / `+++` / hunks).
   */
  readonly fetchDiff: (ref: ChangeRef) => Effect.Effect<string, ScmError>;

  /**
   * Post a top-level review note back onto the change (the visible comment the
   * review renders). Best-effort *reporting*, like `github.pullReview`: a Layer
   * without credentials degrades to a logged no-op rather than failing the run.
   */
  readonly postReview: (note: ReviewNote) => Effect.Effect<void, ScmError>;
}

/** Context.Tag — the `scm` dependency a review run carries until a Layer provides it. */
export class Scm extends Context.Tag("@flare-dispatch/core/Scm")<
  Scm,
  ScmService
>() {}

/**
 * The `scm` accessor namespace — reads the Scm service from context and
 * delegates, so a run writes `scm.fetchDiff(ref)` rather than the explicit
 * `Effect.flatMap(Scm, (s) => s.fetchDiff(ref))`. Mirrors `github` / `modelGateway`.
 */
export const scm = {
  fetchDiff: (ref: ChangeRef) =>
    Effect.flatMap(Scm, (s) => s.fetchDiff(ref)),
  postReview: (note: ReviewNote) =>
    Effect.flatMap(Scm, (s) => s.postReview(note)),
} as const;

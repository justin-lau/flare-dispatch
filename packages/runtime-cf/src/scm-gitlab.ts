// @flare-dispatch/runtime-cf — GitlabScmLive: the live `scm` capability (GitLab).
//
// Backs the neutral `Scm` Tag with the GitLab REST API via
// `@flare-dispatch/gitlab-app`. `fetchDiff` maps a `ChangeRef` onto the MR diff
// endpoint (`project` → project id/path, `number` → the MR `iid`) and assembles
// a unified diff; `postReview` posts a top-level note. A project access token
// (the `GITLAB_TOKEN` Worker secret) is the auth — see gitlab-app's README.
//
// --- Graceful degradation (mirrors makeGithubLive's pullReview degrade) ------
//
// When the token is ABSENT (a deploy without `GITLAB_TOKEN`): `postReview` is a
// logged no-op — a review note is *reporting*, never *correctness*, so it must
// not fail an otherwise-green run — and `fetchDiff` fails with a typed
// `ScmError` (`reason: "auth-failed"`), since a review with no diff to read
// cannot proceed. With the token present, a genuine API failure is a typed
// `ScmError` the run's error boundary renders.
//
// --- Error mapping -----------------------------------------------------------
//
// `gitlab-app`'s `GitlabApiError` carries an HTTP status; `scmReasonFor` maps it
// (and any other thrown value) onto the provider-agnostic `ScmError.reason`
// union — no HTTP status leaks past this Layer, exactly like the modelGateway /
// github layers.

import {
  fetchMergeRequestDiff,
  postMergeRequestNote,
  GitlabApiError,
} from "@flare-dispatch/gitlab-app";
import { Effect, Layer } from "effect";
import { type ChangeRef, Scm, ScmError, type ScmService } from "@flare-dispatch/core";

const PROVIDER = "gitlab";

/**
 * Map a thrown value onto the provider-agnostic `ScmError.reason`:
 *   401 / 403 → auth-failed, 404 → not-found, 429 → rate-limited,
 *   any other `GitlabApiError` → bad-response, a non-API throw → unknown.
 * PURE — exported for direct unit testing (the logic-heavy seam).
 */
export const scmReasonFor = (cause: unknown): ScmError["reason"] => {
  if (cause instanceof GitlabApiError) {
    if (cause.status === 401 || cause.status === 403) return "auth-failed";
    if (cause.status === 404) return "not-found";
    if (cause.status === 429) return "rate-limited";
    return "bad-response";
  }
  return "unknown";
};

/** Coerce a thrown value into a typed `ScmError`. */
const toScmError = (cause: unknown): ScmError => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new ScmError({
    provider: PROVIDER,
    reason: scmReasonFor(cause),
    message,
  });
};

/** The config the live GitLab `Scm` Layer needs. */
export type GitlabScmConfig = {
  /**
   * The GitLab project/group access token (`GITLAB_TOKEN`). `undefined` selects
   * the degraded Layer: `postReview` no-ops, `fetchDiff` fails `auth-failed`.
   */
  readonly token?: string;
  /** API base override (`https://gitlab.com/api/v4` default) for self-hosted. */
  readonly baseUrl?: string;
};

/**
 * Build the live GitLab `Scm` Layer. Absent a token, the Layer degrades:
 * `fetchDiff` fails with `ScmError(auth-failed)` and `postReview` is a logged
 * no-op (reporting must never fail a run).
 */
export const makeGitlabScmLive = (
  config: GitlabScmConfig,
): Layer.Layer<Scm> => {
  const { token, baseUrl } = config;

  const service: ScmService = {
    fetchDiff: (ref: ChangeRef) =>
      token === undefined
        ? Effect.fail(
            new ScmError({
              provider: PROVIDER,
              reason: "auth-failed",
              message:
                "scm.fetchDiff: no GITLAB_TOKEN on this deploy — cannot read the merge-request diff",
            }),
          )
        : Effect.tryPromise({
            try: () =>
              fetchMergeRequestDiff({
                token,
                projectId: ref.project,
                iid: ref.number,
                ...(baseUrl !== undefined ? { apiBase: baseUrl } : {}),
              }),
            catch: toScmError,
          }),

    postReview: (note) =>
      token === undefined
        ? Effect.logInfo(
            `scm.postReview skipped (no GITLAB_TOKEN) — note on ${note.ref.project}!${note.ref.number} not posted`,
          )
        : Effect.tryPromise({
            try: () =>
              postMergeRequestNote({
                token,
                projectId: note.ref.project,
                iid: note.ref.number,
                body: note.body,
                ...(baseUrl !== undefined ? { apiBase: baseUrl } : {}),
              }),
            catch: toScmError,
          }),
  };

  return Layer.succeed(Scm, service);
};

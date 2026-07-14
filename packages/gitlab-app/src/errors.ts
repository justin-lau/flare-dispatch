// @flare-dispatch/gitlab-app — error type.
//
// Like github-app, the gitlab-app package is the low-level HTTP layer: plain
// typed `async` functions, no Effect dependency (the Effect wrapping happens one
// layer up in `makeGitlabScmLive`). It surfaces a single concrete error class so
// callers can `instanceof`-narrow on it; the Effect Layer maps this onto the
// tagged `ScmError`.

/** Thrown when a GitLab API call returns a non-2xx response. */
export class GitlabApiError extends Error {
  override readonly name = "GitlabApiError";

  constructor(
    message: string,
    /** The HTTP status code GitLab returned. */
    readonly status: number,
    /** The (possibly empty) response body, for diagnostics. */
    readonly body: string,
  ) {
    super(`${message} (HTTP ${status})`);
  }
}

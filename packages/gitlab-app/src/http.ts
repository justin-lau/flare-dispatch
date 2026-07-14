// @flare-dispatch/gitlab-app — shared REST plumbing.
//
// The bits every gitlab-app fetch module repeats: the API base, the
// `PRIVATE-TOKEN` auth header, the URL-encoding of a project id/path, the
// `fetchImpl ?? fetch` / `apiBase ?? DEFAULT_API_BASE` resolution, and the
// non-2xx → `GitlabApiError` guard. One home so the API base (an
// Enterprise/self-hosted-sensitive constant) lives in exactly one place.
//
// GitLab authenticates a personal/project/group access token with the
// `PRIVATE-TOKEN` header (NOT `Authorization: Bearer`, which GitLab reserves for
// OAuth). A project access token scoped to `api` is all this PoC needs.
//
// Provider-neutral plain `async`, no Effect — the same property github-app
// keeps so the Effect Layer in @flare-dispatch/runtime-cf can wrap it.

import { GitlabApiError } from "./errors";

/** GitLab SaaS API base — overridable per call for tests / self-hosted GitLab. */
export const DEFAULT_API_BASE = "https://gitlab.com/api/v4";

/**
 * URL-encode a project identifier for the `/projects/:id` path segment. A
 * numeric id passes through; a `"group/project"` path is percent-encoded whole
 * (GitLab accepts `group%2Fproject`), so both forms address the same endpoint.
 */
export const encodeProjectId = (projectId: string | number): string =>
  encodeURIComponent(String(projectId));

/**
 * Request headers for a token-authenticated GitLab call. Pass `{ json: true }`
 * for a request that carries a JSON body (POST/PUT).
 */
export const glHeaders = (
  token: string,
  opts: { json?: boolean } = {},
): Record<string, string> => ({
  "PRIVATE-TOKEN": token,
  Accept: "application/json",
  ...(opts.json ? { "Content-Type": "application/json" } : {}),
  "User-Agent": "flare-dispatch",
});

/** Resolve the per-call `apiBase` + `fetch` defaults in one place. */
export const resolveClient = (opts: {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): { apiBase: string; doFetch: typeof fetch } => ({
  apiBase: opts.apiBase ?? DEFAULT_API_BASE,
  doFetch: opts.fetchImpl ?? fetch,
});

/**
 * Throw a `GitlabApiError` (status + body text attached) when a response is
 * non-2xx. Each caller keeps its own success-body decode after this guard, so
 * decode semantics stay per-call.
 */
export const assertOk = async (
  res: Response,
  message: string,
): Promise<void> => {
  if (!res.ok) {
    throw new GitlabApiError(
      message,
      res.status,
      await res.text().catch(() => ""),
    );
  }
};

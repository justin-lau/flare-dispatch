// @flare-dispatch/gitlab-app — public API.
//
// Token-authenticated GitLab REST access for the `mr-review` recipe:
//
//   * `fetchMergeRequestDiff` — assemble an MR's per-file diffs into one
//                               unified-diff string (paginated).
//   * `postMergeRequestNote`  — post the visible review comment.
//
// Provider-neutral fetch code: plain typed `async` functions, no Effect
// dependency. The Effect Layer (`makeGitlabScmLive` in
// @flare-dispatch/runtime-cf) wraps these onto the neutral `Scm` Tag.
//
// Deliberately smaller than github-app: there is no App/JWT/installation flow —
// a project access token scoped to `api` is the auth (see README.md).

export { DEFAULT_API_BASE, encodeProjectId, glHeaders } from "./http";
export {
  assembleUnifiedDiff,
  fetchMergeRequestDiff,
  postMergeRequestNote,
  type GitlabMrDiffFile,
  type FetchMergeRequestDiffOptions,
  type PostMergeRequestNoteOptions,
} from "./merge-requests";
export { GitlabApiError } from "./errors";

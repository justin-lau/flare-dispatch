# @flare-dispatch/gitlab-app

Token-authenticated GitLab REST access for the `mr-review` recipe — the GitLab
analog of `@flare-dispatch/github-app`, deliberately **much smaller**.

Provider-neutral fetch code: plain typed `async` functions, no Effect
dependency. The Effect Layer (`makeGitlabScmLive` in
`@flare-dispatch/runtime-cf`) wraps these onto the neutral `Scm` capability.

## Surface

- `fetchMergeRequestDiff({ projectId, iid, token })` — GET the MR's per-file
  diffs (`GET /projects/:id/merge_requests/:iid/diffs`, paginated `per_page=100`
  following the `x-next-page` header) and assemble them into ONE standard
  `git`-style unified diff, so the review engine reads a GitLab MR exactly as it
  reads a GitHub PR.
- `postMergeRequestNote({ projectId, iid, body, token })` — POST a top-level
  note (`POST /projects/:id/merge_requests/:iid/notes`), the visible review
  comment.
- `assembleUnifiedDiff(files)` — the pure diff-assembly helper (exported for
  reuse/tests).

## Auth — token-based, no install flow

Unlike `github-app` (App JWT → installation-token exchange → check-runs), this
package authenticates with a single **project access token** sent in the
`PRIVATE-TOKEN` header. There is **no** App registration, no per-installation
token minting, and no check-run surface — a GitLab MR review posts a note and
reports its verdict inline.

Create a project (or group) access token scoped to `api` and set it as the
Worker secret `GITLAB_TOKEN` (see `specs/11-gitlab-poc.md`).

## Testing

MSW mocks `https://gitlab.com/api/v4` under plain Node + Vitest (mirrors
`github-app`). `onUnhandledRequest: "error"` keeps the tests honest about which
URLs are hit.

// @flare-dispatch/gitlab-app — merge-request diff fetch + review-note post.
//
// The two operations the `mr-review` recipe needs, mirroring github-app's
// `pull-requests.ts` / `reviews.ts`:
//
//   * `fetchMergeRequestDiff` — GET the MR's per-file diffs and assemble them
//     into ONE standard `git`-style unified diff string, so the review engine
//     (which parses `diff --git` / `+++ b/…` headers) reads a GitLab MR exactly
//     as it reads a GitHub PR. Paginates the `/diffs` endpoint (per_page=100,
//     following the `x-next-page` header).
//   * `postMergeRequestNote` — POST a top-level note (the visible review comment).
//
// Authenticated with a project access token via the `PRIVATE-TOKEN` header (see
// http.ts). Provider-neutral plain `async`; the Effect Layer
// (`makeGitlabScmLive` in @flare-dispatch/runtime-cf) wraps these onto `Scm`.
//
// GitLab diffs API: `GET /projects/:id/merge_requests/:iid/diffs` →
//   [{ old_path, new_path, new_file, renamed_file, deleted_file, diff }]
// where `diff` is the hunk body (`@@ … @@` + `+`/`-`/context lines) WITHOUT the
// `---`/`+++` file headers — those are synthesized here from the path + flags.

import { assertOk, encodeProjectId, glHeaders, resolveClient } from "./http";

/** One file's diff entry from the GitLab MR `/diffs` endpoint. */
export type GitlabMrDiffFile = {
  readonly old_path: string;
  readonly new_path: string;
  readonly new_file: boolean;
  readonly renamed_file: boolean;
  readonly deleted_file: boolean;
  /** The hunk body — `@@ … @@` + content lines, no `---`/`+++` headers. */
  readonly diff: string;
};

/**
 * Assemble GitLab's per-file diff entries into ONE standard unified-diff string.
 * PURE — no I/O — so it unit-tests directly. Each file section is:
 *
 *   diff --git a/<old_path> b/<new_path>
 *   --- <a/<old_path> | /dev/null (new file)>
 *   +++ <b/<new_path> | /dev/null (deleted file)>
 *   <hunk body verbatim>
 *
 * A renamed file keeps distinct a/old + b/new headers (the review only needs the
 * paths + hunks; git's `rename from/to` metadata is not reconstructed). A file
 * whose `diff` body is empty (a pure rename/mode change) still emits its headers
 * so the change is visible to the reviewer.
 */
export const assembleUnifiedDiff = (
  files: ReadonlyArray<GitlabMrDiffFile>,
): string =>
  files
    .map((f) => {
      const minus = f.new_file ? "/dev/null" : `a/${f.old_path}`;
      const plus = f.deleted_file ? "/dev/null" : `b/${f.new_path}`;
      const header = [
        `diff --git a/${f.old_path} b/${f.new_path}`,
        `--- ${minus}`,
        `+++ ${plus}`,
      ];
      // Keep the hunk body verbatim; ensure the section ends with a newline so
      // the next `diff --git` starts on its own line.
      const body = f.diff.endsWith("\n") ? f.diff : `${f.diff}\n`;
      return `${header.join("\n")}\n${body}`;
    })
    .join("");

/** Max pages the diff pagination will follow — bounds a pathological MR. */
const MAX_DIFF_PAGES = 50;

export type FetchMergeRequestDiffOptions = {
  /** The project access token authenticating the call. */
  readonly token: string;
  /** Numeric project id or `"group/project"` path. */
  readonly projectId: string | number;
  /** The merge-request `iid` (project-scoped id, NOT the global `id`). */
  readonly iid: number;
  /** API base override (tests / self-hosted GitLab). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * Fetch a merge request's full diff as ONE unified-diff string. Paginates the
 * `/diffs` endpoint (per_page=100) following the `x-next-page` response header
 * until it is empty.
 *
 * @throws {GitlabApiError} when the API returns non-2xx.
 */
export const fetchMergeRequestDiff = async (
  opts: FetchMergeRequestDiffOptions,
): Promise<string> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const project = encodeProjectId(opts.projectId);
  const files: GitlabMrDiffFile[] = [];

  // Defence in depth: `iid` is a caller-supplied value; encode it into the path
  // so a non-numeric value can never inject extra path segments (the webhook
  // route also validates it is a positive integer BEFORE reaching here).
  const iid = encodeURIComponent(String(opts.iid));

  let page = 1;
  for (let i = 0; i < MAX_DIFF_PAGES; i++) {
    const res = await doFetch(
      `${apiBase}/projects/${project}/merge_requests/${iid}/diffs?per_page=100&page=${page}`,
      { method: "GET", headers: glHeaders(opts.token) },
    );
    await assertOk(res, "merge-request diffs fetch failed");
    const batch = (await res.json()) as GitlabMrDiffFile[];
    files.push(...batch);

    // GitLab paginates with `x-next-page` — empty (or absent) means done.
    const next = res.headers.get("x-next-page");
    if (next === null || next.trim() === "") break;
    const parsed = Number.parseInt(next, 10);
    if (!Number.isInteger(parsed) || parsed <= page) break;
    page = parsed;
  }

  return assembleUnifiedDiff(files);
};

export type PostMergeRequestNoteOptions = {
  /** The project access token authenticating the call. */
  readonly token: string;
  /** Numeric project id or `"group/project"` path. */
  readonly projectId: string | number;
  /** The merge-request `iid`. */
  readonly iid: number;
  /** Markdown body of the note. */
  readonly body: string;
  /** API base override (tests / self-hosted GitLab). */
  readonly apiBase?: string;
  /** `fetch` override — defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
};

/**
 * Post a top-level note on a merge request (the visible review comment).
 *
 * @throws {GitlabApiError} when the API returns non-2xx.
 */
export const postMergeRequestNote = async (
  opts: PostMergeRequestNoteOptions,
): Promise<void> => {
  const { apiBase, doFetch } = resolveClient(opts);
  const project = encodeProjectId(opts.projectId);
  const iid = encodeURIComponent(String(opts.iid));
  const res = await doFetch(
    `${apiBase}/projects/${project}/merge_requests/${iid}/notes`,
    {
      method: "POST",
      headers: glHeaders(opts.token, { json: true }),
      body: JSON.stringify({ body: opts.body }),
    },
  );
  await assertOk(res, "merge-request note create failed");
};

// Unit tests for merge-request diff fetch + note post.
//
// Mocks `gitlab.com/api/v4` with MSW and asserts: `fetchMergeRequestDiff`
// paginates the `/diffs` endpoint (following `x-next-page`), sends the
// `PRIVATE-TOKEN` header, and assembles a standard unified diff (new / deleted /
// renamed / modified file shapes); `postMergeRequestNote` POSTs the body to
// `/notes`; a non-2xx surfaces a `GitlabApiError`.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assembleUnifiedDiff,
  fetchMergeRequestDiff,
  GitlabApiError,
  postMergeRequestNote,
  type GitlabMrDiffFile,
} from "./index";

const BASE = "https://gitlab.com/api/v4";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const file = (over: Partial<GitlabMrDiffFile>): GitlabMrDiffFile => ({
  old_path: "src/x.ts",
  new_path: "src/x.ts",
  new_file: false,
  renamed_file: false,
  deleted_file: false,
  diff: "@@ -1 +1 @@\n-const x = 1;\n+const x = 2;\n",
  ...over,
});

describe("assembleUnifiedDiff (pure)", () => {
  it("emits a/old + b/new headers for a modified file", () => {
    const out = assembleUnifiedDiff([file({})]);
    expect(out).toContain("diff --git a/src/x.ts b/src/x.ts");
    expect(out).toContain("--- a/src/x.ts");
    expect(out).toContain("+++ b/src/x.ts");
    expect(out).toContain("+const x = 2;");
  });

  it("a new file uses /dev/null on the minus side", () => {
    const out = assembleUnifiedDiff([
      file({ new_file: true, old_path: "src/new.ts", new_path: "src/new.ts", diff: "@@ -0,0 +1 @@\n+new\n" }),
    ]);
    expect(out).toContain("diff --git a/src/new.ts b/src/new.ts");
    expect(out).toContain("--- /dev/null");
    expect(out).toContain("+++ b/src/new.ts");
  });

  it("a deleted file uses /dev/null on the plus side", () => {
    const out = assembleUnifiedDiff([
      file({ deleted_file: true, old_path: "gone.ts", new_path: "gone.ts", diff: "@@ -1 +0,0 @@\n-gone\n" }),
    ]);
    expect(out).toContain("--- a/gone.ts");
    expect(out).toContain("+++ /dev/null");
  });

  it("a renamed file keeps distinct a/old + b/new paths", () => {
    const out = assembleUnifiedDiff([
      file({ renamed_file: true, old_path: "old/name.ts", new_path: "new/name.ts", diff: "" }),
    ]);
    expect(out).toContain("diff --git a/old/name.ts b/new/name.ts");
    expect(out).toContain("--- a/old/name.ts");
    expect(out).toContain("+++ b/new/name.ts");
  });

  it("concatenates multiple file sections", () => {
    const out = assembleUnifiedDiff([
      file({ new_path: "a.ts", old_path: "a.ts" }),
      file({ new_path: "b.ts", old_path: "b.ts" }),
    ]);
    expect(out.match(/diff --git/g)).toHaveLength(2);
  });
});

describe("fetchMergeRequestDiff", () => {
  it("sends PRIVATE-TOKEN, assembles the diff, hits the /diffs endpoint", async () => {
    let authHeader: string | null = null;
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, ({ request, params }) => {
        authHeader = request.headers.get("PRIVATE-TOKEN");
        expect(params.project).toBe("42");
        expect(params.iid).toBe("7");
        return HttpResponse.json([file({})], {
          headers: { "x-next-page": "" },
        });
      }),
    );

    const diff = await fetchMergeRequestDiff({
      token: "glpat-abc",
      projectId: 42,
      iid: 7,
    });
    expect(authHeader).toBe("glpat-abc");
    expect(diff).toContain("diff --git a/src/x.ts b/src/x.ts");
    expect(diff).toContain("+const x = 2;");
  });

  it("follows x-next-page across pages", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        if (page === "1") {
          return HttpResponse.json(
            [file({ old_path: "p1.ts", new_path: "p1.ts" })],
            { headers: { "x-next-page": "2" } },
          );
        }
        return HttpResponse.json(
          [file({ old_path: "p2.ts", new_path: "p2.ts" })],
          { headers: { "x-next-page": "" } },
        );
      }),
    );

    const diff = await fetchMergeRequestDiff({ token: "t", projectId: 1, iid: 2 });
    expect(diff).toContain("a/p1.ts");
    expect(diff).toContain("a/p2.ts");
    expect(diff.match(/diff --git/g)).toHaveLength(2);
  });

  it("surfaces a 401 as a normalized GitlabApiError", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 }),
      ),
    );
    await expect(
      fetchMergeRequestDiff({ token: "bad", projectId: 1, iid: 2 }),
    ).rejects.toBeInstanceOf(GitlabApiError);
  });
});

describe("postMergeRequestNote", () => {
  it("POSTs the body to /notes with the PRIVATE-TOKEN header", async () => {
    let captured: { auth: string | null; body: Record<string, unknown> } | undefined;
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, async ({ request }) => {
        captured = {
          auth: request.headers.get("PRIVATE-TOKEN"),
          body: (await request.json()) as Record<string, unknown>,
        };
        return HttpResponse.json({ id: 999 }, { status: 201 });
      }),
    );

    await postMergeRequestNote({
      token: "glpat-xyz",
      projectId: 42,
      iid: 7,
      body: "AI review summary",
    });
    expect(captured?.auth).toBe("glpat-xyz");
    expect(captured?.body.body).toBe("AI review summary");
  });

  it("surfaces a non-2xx as a GitlabApiError", async () => {
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, () =>
        HttpResponse.json({ message: "404 Not found" }, { status: 404 }),
      ),
    );
    await expect(
      postMergeRequestNote({ token: "t", projectId: 1, iid: 2, body: "x" }),
    ).rejects.toBeInstanceOf(GitlabApiError);
  });
});

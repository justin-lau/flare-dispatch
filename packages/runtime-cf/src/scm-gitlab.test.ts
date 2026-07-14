// Unit tests for the live GitLab `Scm` Layer.
//
// The provider-error → `ScmError.reason` mapping is a pure function tested
// directly; the Layer's fetch/post + degrade behaviour runs against MSW (this
// suite is plain Node — gitlab-app is provider-neutral fetch code, no Workers
// pool needed).

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { GitlabApiError } from "@flare-dispatch/gitlab-app";
import { scm, type ChangeRef } from "@flare-dispatch/core";
import { makeGitlabScmLive, scmReasonFor } from "./scm-gitlab";

const BASE = "https://gitlab.com/api/v4";

const ref: ChangeRef = {
  project: "42",
  number: 7,
  headSha: "head123",
  baseSha: "base456",
};

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("scmReasonFor (pure)", () => {
  it("maps GitLab statuses onto the ScmError reason union", () => {
    expect(scmReasonFor(new GitlabApiError("x", 401, ""))).toBe("auth-failed");
    expect(scmReasonFor(new GitlabApiError("x", 403, ""))).toBe("auth-failed");
    expect(scmReasonFor(new GitlabApiError("x", 404, ""))).toBe("not-found");
    expect(scmReasonFor(new GitlabApiError("x", 429, ""))).toBe("rate-limited");
    expect(scmReasonFor(new GitlabApiError("x", 500, ""))).toBe("bad-response");
    expect(scmReasonFor(new Error("network"))).toBe("unknown");
  });
});

describe("makeGitlabScmLive — with token", () => {
  it("fetchDiff assembles the MR diff", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json(
          [
            {
              old_path: "src/x.ts",
              new_path: "src/x.ts",
              new_file: false,
              renamed_file: false,
              deleted_file: false,
              diff: "@@ -1 +1 @@\n-a\n+b\n",
            },
          ],
          { headers: { "x-next-page": "" } },
        ),
      ),
    );
    const layer = makeGitlabScmLive({ token: "glpat-abc" });
    const diff = await Effect.runPromise(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(diff).toContain("diff --git a/src/x.ts b/src/x.ts");
    expect(diff).toContain("+b");
  });

  it("fetchDiff maps a 401 onto ScmError(auth-failed)", async () => {
    server.use(
      http.get(`${BASE}/projects/:project/merge_requests/:iid/diffs`, () =>
        HttpResponse.json({ message: "401" }, { status: 401 }),
      ),
    );
    const layer = makeGitlabScmLive({ token: "bad" });
    const exit = await Effect.runPromiseExit(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      // The failure is a typed ScmError with a provider-agnostic reason.
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value._tag).toBe("ScmError");
        expect(failure.value.reason).toBe("auth-failed");
        expect(failure.value.provider).toBe("gitlab");
      }
    }
  });

  it("postReview posts a note", async () => {
    let posted: unknown;
    server.use(
      http.post(`${BASE}/projects/:project/merge_requests/:iid/notes`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ id: 1 }, { status: 201 });
      }),
    );
    const layer = makeGitlabScmLive({ token: "glpat-abc" });
    await Effect.runPromise(
      scm.postReview({ ref, body: "hi" }).pipe(Effect.provide(layer)),
    );
    expect(posted).toEqual({ body: "hi" });
  });
});

describe("makeGitlabScmLive — degraded (no token)", () => {
  it("fetchDiff fails auth-failed", async () => {
    const layer = makeGitlabScmLive({});
    const exit = await Effect.runPromiseExit(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("postReview is a logged no-op (never fails)", async () => {
    const layer = makeGitlabScmLive({});
    // No MSW handler registered — a real POST would error the suite, proving
    // the degraded path makes no network call.
    await expect(
      Effect.runPromise(scm.postReview({ ref, body: "x" }).pipe(Effect.provide(layer))),
    ).resolves.toBeUndefined();
  });
});

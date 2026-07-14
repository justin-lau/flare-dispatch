// Scm fake unit tests — the provider-neutral source-control simulator.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { scm, type ChangeRef } from "../services/scm";
import { makeScmFake } from "./scm-fake";

const ref: ChangeRef = {
  project: "group/project",
  number: 7,
  headSha: "head123",
  baseSha: "base456",
};

describe("makeScmFake", () => {
  it("fetchDiff returns the canned diff and records the ref", async () => {
    const { layer, state } = makeScmFake({ diff: "diff --git a/x b/x\n+y\n" });
    const got = await Effect.runPromise(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(got).toBe("diff --git a/x b/x\n+y\n");
    expect(state.fetchDiffCalls).toEqual([ref]);
    expect(state.postReviewCalls).toHaveLength(0);
  });

  it("postReview records the note and succeeds", async () => {
    const { layer, state } = makeScmFake();
    await Effect.runPromise(
      scm.postReview({ ref, body: "AI review" }).pipe(Effect.provide(layer)),
    );
    expect(state.postReviewCalls).toHaveLength(1);
    expect(state.postReviewCalls[0]).toEqual({ ref, body: "AI review" });
  });

  it("defaults to a valid one-file unified diff", async () => {
    const { layer } = makeScmFake();
    const got = await Effect.runPromise(
      scm.fetchDiff(ref).pipe(Effect.provide(layer)),
    );
    expect(got).toContain("diff --git");
    expect(got).toContain("+++ b/");
  });
});

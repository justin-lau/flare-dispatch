// Run-level unit tests for the `mr-review` run (GitLab PoC).
//
// Exercises `mrReviewProgram` against the SAME three fakes the PoC Workflow
// provides live — `makeScmFake` + `makeModelGatewayFake` + `makeConfigFake` —
// no CF, no network, no model provider. The engine's model path is covered
// exhaustively in packages/review-agent; these tests cover the mr-review
// ORCHESTRATION: diff fetched via `scm`, model called, exactly ONE note posted
// with the marker + a finding, and the trigger's action gating.

import { it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { describe, expect } from "vitest";
import {
  makeConfigFake,
  makeModelGatewayFake,
  makeScmFake,
} from "@flare-dispatch/core/testing";
import { mrInputsFromPayload, mrReview, mrReviewProgram, type MrReviewInput } from "./mr-review";

const baseInput: MrReviewInput = {
  projectId: "42",
  iid: 7,
  headSha: "head1234567890abcdef",
  baseSha: "base456",
  projectWebUrl: "https://gitlab.com/group/proj",
};

/** Backend config so the run survives `resolveBackend` (single-agent default). */
const backendConfig = { "pr-review.workers-ai.model": "@cf/test/model" };

/** A `report` tool call with one finding, answering the lone generalist reviewer. */
const reportWithFinding = {
  toolCalls: [
    {
      name: "report",
      arguments: {
        findings: [
          {
            path: "src/foo.ts",
            startLine: 10,
            endLine: 12,
            level: "warning",
            title: "Missing null check",
            message: "`foo.bar` may be undefined",
          },
        ],
      },
    },
  ],
  text: "",
} as const;

describe("mr-review", () => {
  it.effect("fetches the diff, calls the model, posts ONE note with the marker + finding", () => {
    const scmFake = makeScmFake({
      diff: "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
    });
    const modelFake = makeModelGatewayFake({ responses: [reportWithFinding] });
    const layer = Layer.mergeAll(
      scmFake.layer,
      modelFake.layer,
      makeConfigFake(backendConfig),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(mrReviewProgram(baseInput));
      expect(Exit.isSuccess(exit)).toBe(true);

      // The diff was fetched via `scm` for the right change.
      expect(scmFake.state.fetchDiffCalls).toHaveLength(1);
      expect(scmFake.state.fetchDiffCalls[0]).toMatchObject({
        project: "42",
        number: 7,
        headSha: baseInput.headSha,
        baseSha: baseInput.baseSha,
      });

      // The model was called (single generalist reviewer).
      expect(modelFake.state.requests).toHaveLength(1);
      expect(modelFake.state.requests[0]!.model).toBe("@cf/test/model");

      // Exactly ONE note posted, carrying the marker + the finding + a GitLab blob link.
      expect(scmFake.state.postReviewCalls).toHaveLength(1);
      const body = scmFake.state.postReviewCalls[0]!.body;
      expect(body).toContain("<!-- flare-dispatch: mr-review -->");
      expect(body).toContain("### AI code review");
      expect(body).toContain("Missing null check");
      expect(body).toContain(
        `https://gitlab.com/group/proj/-/blob/${baseInput.headSha}/src/foo.ts#L10-12`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("an unconfigured backend fails AND still posts a 'could not complete' note", () => {
    const scmFake = makeScmFake();
    const modelFake = makeModelGatewayFake();
    // No `pr-review.*` keys seeded → resolveBackend fails BackendUnconfigured.
    const layer = Layer.mergeAll(scmFake.layer, modelFake.layer, makeConfigFake({}));

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(mrReviewProgram(baseInput));
      expect(Exit.isFailure(exit)).toBe(true);

      expect(scmFake.state.postReviewCalls).toHaveLength(1);
      const body = scmFake.state.postReviewCalls[0]!.body;
      expect(body).toContain("could not complete");
      expect(body).toContain("pr-review.workers-ai.model");
      expect(body).toContain("<!-- flare-dispatch: mr-review -->");
      // The diff was never fetched (backend resolution is the first step).
      expect(scmFake.state.fetchDiffCalls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("every reviewer failing → run goes red with an honest note", () => {
    const scmFake = makeScmFake();
    // Empty responses + json mode → the lone reviewer's parse fails.
    const modelFake = makeModelGatewayFake({ responses: [{ toolCalls: [], text: "not json" }] });
    const layer = Layer.mergeAll(
      scmFake.layer,
      modelFake.layer,
      makeConfigFake({ ...backendConfig, "pr-review.workers-ai.mode": "json" }),
    );

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(mrReviewProgram(baseInput));
      expect(Exit.isFailure(exit)).toBe(true);
      const body = scmFake.state.postReviewCalls[0]!.body;
      expect(body).toContain("could not complete");
    }).pipe(Effect.provide(layer));
  });
});

describe("mr-review trigger", () => {
  it("gates on merge_request events + open/reopen/update actions", () => {
    const trigger = mrReview.triggers![0]!;
    expect(trigger.event).toBe("merge_request");
    expect(trigger.actions).toEqual(["open", "reopen", "update"]);
    // The gate accepts a genuine merge_request payload and rejects others.
    expect(trigger.gate!({ payload: { object_kind: "merge_request" } })).toBe(true);
    expect(trigger.gate!({ payload: { object_kind: "note" } })).toBe(false);
  });

  it("mrInputsFromPayload prefers diff_refs endpoints, falls back to last_commit/oldrev", () => {
    const withDiffRefs = mrInputsFromPayload({
      project: { id: 42, web_url: "https://gitlab.com/g/p" },
      object_attributes: {
        iid: 7,
        last_commit: { id: "commitsha" },
        oldrev: "oldrevsha",
        diff_refs: { base_sha: "baseX", head_sha: "headX" },
      },
    });
    expect(withDiffRefs).toEqual({
      projectId: "42",
      iid: 7,
      headSha: "headX",
      baseSha: "baseX",
      projectWebUrl: "https://gitlab.com/g/p",
    });

    // No diff_refs → last_commit.id for head, oldrev for base.
    const fallback = mrInputsFromPayload({
      project: { id: 9, web_url: "https://gitlab.com/g/q" },
      object_attributes: { iid: 3, last_commit: { id: "csha" }, oldrev: "osha" },
    });
    expect(fallback.headSha).toBe("csha");
    expect(fallback.baseSha).toBe("osha");
  });
});

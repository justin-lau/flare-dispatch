// Unit tests for the GitLab review outcome mapping (the pure piece of
// GitlabReviewWorkflow's review step).

import { afterEach, describe, expect, it, vi } from "vitest";
import { Cause, Exit } from "effect";
import type { MrComputeResult } from "@flare-dispatch/runs/mr-review";
import { reviewOutcome } from "./gitlab-review-outcome";

const output = {
  verdict: "comment" as const,
  tier: "lite" as const,
  critical: 0,
  warnings: 1,
  suggestions: 0,
  findings: [],
};

afterEach(() => vi.restoreAllMocks());

const usage = { inputTokens: 14230, outputTokens: 1872 };

describe("reviewOutcome", () => {
  it("success (output present) → status success + summaryJson (output + usage + grounded) + the note body", () => {
    const compute: MrComputeResult = {
      status: "success",
      output,
      usage,
      grounded: true,
      noteBody: "the note",
    };
    const out = reviewOutcome(Exit.succeed(compute));
    expect(out.status).toBe("success");
    expect(out.noteBody).toBe("the note");
    // summary_json carries the review output, the token usage, AND the A/B arm.
    expect(JSON.parse(out.summaryJson!)).toEqual({ ...output, usage, grounded: true });
  });

  it("compute-level failure (output null) → status failure, summaryJson null, failure note", () => {
    const compute: MrComputeResult = {
      status: "failure",
      output: null,
      usage: null,
      grounded: false,
      noteBody: "could not complete",
    };
    const out = reviewOutcome(Exit.succeed(compute));
    expect(out.status).toBe("failure");
    expect(out.summaryJson).toBeNull();
    expect(out.noteBody).toBe("could not complete");
  });

  it("skipped-quota (null note) → status skipped-quota, summaryJson null, posts NOTHING", () => {
    const compute: MrComputeResult = {
      status: "skipped-quota",
      output: null,
      usage: null,
      grounded: false,
      noteBody: null,
    };
    const out = reviewOutcome(Exit.succeed(compute));
    expect(out.status).toBe("skipped-quota");
    expect(out.summaryJson).toBeNull();
    expect(out.noteBody).toBeNull();
  });

  it("a DEFECT is logged (Cause.pretty) and yields a crash note", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = reviewOutcome(Exit.failCause(Cause.die(new Error("boom"))) as Exit.Exit<MrComputeResult, never>);
    expect(out.status).toBe("failure");
    expect(out.summaryJson).toBeNull();
    expect(out.noteBody).toContain("mr-review crashed");
    expect(out.noteBody).toContain("<!-- flare-dispatch: mr-review -->");
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]![0])).toContain("boom");
  });
});

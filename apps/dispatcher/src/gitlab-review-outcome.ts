// FlareDispatch Dispatcher — GitLab review outcome mapping.
//
// The PURE piece of `GitlabReviewWorkflow`'s review step, split out so it is
// unit-testable in plain Node (workflow-gitlab.ts imports `cloudflare:workers`,
// which a Node test can't resolve). Maps the `Exit` of `mrReviewCompute` onto the
// terminal `executions`-row fields + the note body to post — and, crucially,
// LOGS the full `Cause` (via `Cause.pretty`) on a failure/defect so a crashed
// review surfaces in `wrangler tail` instead of being silently swallowed.

import { Cause, Exit } from "effect";
import type { MrComputeResult } from "@flare-dispatch/runs/mr-review";

/** The `<!-- flare-dispatch: mr-review -->` marker — kept in one place. */
const MR_REVIEW_MARKER = "<!-- flare-dispatch: mr-review -->";

/** What the review step yields for `finalize` + the `post-review` step. */
export type ReviewOutcome = {
  /** Terminal `executions.status`. `skipped-quota` = model quota exhausted, no
   *  note posted (graceful degradation). */
  readonly status: "success" | "failure" | "skipped-quota";
  /** `executions.summary_json` — the review output PLUS aggregated token usage;
   *  `null` when the review didn't run (failure / skipped-quota). */
  readonly summaryJson: string | null;
  /** The note body the `post-review` step posts — `null` means post NOTHING
   *  (skipped-quota). */
  readonly noteBody: string | null;
};

/**
 * Map the `mrReviewCompute` Exit onto a {@link ReviewOutcome}. `mrReviewCompute`
 * is designed never to fail (it catches its own errors into a failure note), so
 * the success arm is the normal path; the failure arm is a DEFECT safety net
 * that logs the Cause and posts a generic crash note.
 */
export const reviewOutcome = (
  exit: Exit.Exit<MrComputeResult, never>,
): ReviewOutcome =>
  Exit.match(exit, {
    onSuccess: (r) => ({
      status: r.status,
      // Persist the review output, the aggregated token usage, AND whether the
      // run was retrieval-grounded (the A/B arm) so the D1 row carries the
      // per-run cost inputs and the grounded/diff-only label.
      summaryJson:
        r.output !== null
          ? JSON.stringify({ ...r.output, usage: r.usage, grounded: r.grounded })
          : null,
      noteBody: r.noteBody,
    }),
    onFailure: (cause) => {
      // A DEFECT inside the review (not a handled error) — log the full cause so
      // it reaches `wrangler tail`, then still post a note so the MR author sees
      // the review did not silently vanish.
      console.error(`[gitlab-review] review crashed:\n${Cause.pretty(cause)}`);
      return {
        status: "failure" as const,
        summaryJson: null,
        noteBody: `⚠️ **mr-review crashed** — see the dispatcher logs.\n\n${MR_REVIEW_MARKER}`,
      };
    },
  });

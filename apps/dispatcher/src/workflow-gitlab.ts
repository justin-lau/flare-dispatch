// FlareDispatch Dispatcher — GitlabReviewWorkflow (GitLab MR-review PoC).
//
// A deliberately SLIM Workflow — the `RunWorkflow` (workflow.ts) machinery
// (admission gates, container leases, check-runs, sandbox, writeback, notify)
// is all GitHub/container-shaped and NONE of it applies to a Worker-only GitLab
// review. Three durable steps:
//
//   1. insert-execution — a minimal `executions` D1 row (status running).
//   2. review           — build the 3-Layer stack (modelGateway + config + the
//                         GitLab `scm`) and run `mrReviewProgram`. The program
//                         posts the MR note itself (success OR failure) and
//                         returns the review output; we record its verdict.
//   3. finalize         — update the row's terminal status + summary.
//
// Each step is idempotent: a Workflow resume replays the memoized result rather
// than re-running the body (so the note is not re-posted on a retry). NO
// container / browser imports live here — the PoC deploy binds neither.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Exit, Layer } from "effect";
import {
  ConfigDeferred,
  makeConfigKvLive,
  makeGitlabScmLive,
  makeModelGatewayLive,
  ModelGatewayDeferred,
} from "@flare-dispatch/runtime-cf";
import { mrReviewProgram, type MrReviewInput } from "@flare-dispatch/runs/mr-review";
import type { Env } from "./env";

/** The Workflow params the GitLab webhook route creates each instance with. */
export type GitlabReviewParams = {
  /** Doubles as the instance id AND the `executions` row id. */
  readonly executionId: string;
  /** The `mr-review` run inputs. */
  readonly input: MrReviewInput;
};

/** Narrow the CF `step.do` overloads to the simple `(name, cb)` view we use. */
type StepDo = <T>(name: string, cb: () => Promise<T>) => Promise<T>;

export class GitlabReviewWorkflow extends WorkflowEntrypoint<Env, GitlabReviewParams> {
  override async run(
    event: WorkflowEvent<GitlabReviewParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const { executionId, input } = event.payload;
    // CF types `step.do<T extends Rpc.Serializable<T>>`; our step results are
    // plain JSON records, so bridge through the simple `(name, cb)` view — the
    // same narrowing workflow.ts uses.
    const stepDo = step.do.bind(step) as unknown as StepDo;
    const db = this.env.RUNS_METADATA;

    // 1. Minimal executions row. GitLab has no GitHub-style repo slug — use the
    //    project web URL as `repo`, the source branch as `ref`, the head sha.
    await stepDo("insert-execution", async () => {
      await db
        .prepare(
          `INSERT OR IGNORE INTO executions (id, run, repo, ref, sha, status, started_at, input_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          executionId,
          "mr-review",
          input.projectWebUrl || `gitlab:${input.projectId}`,
          input.sourceBranch ?? "refs/merge-requests",
          input.headSha,
          "running",
          Date.now(),
          JSON.stringify(input),
        )
        .run();
      return { inserted: true };
    });

    // 2. The review. Build the 3-Layer stack, each Layer degrading when its
    //    binding/secret is absent (config dies on read, model fails typed, scm
    //    fails auth-failed) — the program's error boundary posts an honest note.
    const outcome = await stepDo("review", async () => {
      const modelLayer =
        this.env.AI === undefined
          ? ModelGatewayDeferred
          : makeModelGatewayLive(
              this.env.AI,
              this.env.AI_GATEWAY_ID !== undefined && this.env.AI_GATEWAY_ID.length > 0
                ? this.env.AI_GATEWAY_ID
                : undefined,
            );
      const configLayer =
        this.env.CONFIG_KV === undefined
          ? ConfigDeferred
          : makeConfigKvLive(this.env.CONFIG_KV);
      const scmLayer = makeGitlabScmLive(
        this.env.GITLAB_TOKEN !== undefined ? { token: this.env.GITLAB_TOKEN } : {},
      );
      const layer = Layer.mergeAll(modelLayer, configLayer, scmLayer);

      const exit = await Effect.runPromiseExit(
        mrReviewProgram(input).pipe(Effect.provide(layer)),
      );
      return Exit.match(exit, {
        onSuccess: (out) => ({ status: "success" as const, summaryJson: JSON.stringify(out) }),
        onFailure: () => ({ status: "failure" as const, summaryJson: null }),
      });
    });

    // 3. Terminal status + summary.
    await stepDo("finalize", async () => {
      await db
        .prepare(
          `UPDATE executions SET status = ?, completed_at = ?, summary_json = ? WHERE id = ?`,
        )
        .bind(outcome.status, Date.now(), outcome.summaryJson, executionId)
        .run();
      return { finalized: true };
    });
  }
}

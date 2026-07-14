// FlareDispatch Dispatcher — GitlabReviewWorkflow (GitLab MR-review PoC).
//
// A deliberately SLIM Workflow — the `RunWorkflow` (workflow.ts) machinery
// (admission gates, container leases, check-runs, sandbox, writeback, notify)
// is all GitHub/container-shaped and NONE of it applies to a Worker-only GitLab
// review. Three durable steps:
//
//   1. insert-execution — a minimal `executions` D1 row (status running).
//   2. review           — build the 3-Layer stack (modelGateway + config + the
//                         GitLab `scm`) and run `mrReviewCompute` (fetch + model
//                         fan-out + render — but NOT post). Yields the verdict +
//                         the rendered note body.
//   3. post-review      — post the note (its OWN step, so a mid-flight replay
//                         re-runs neither the model fan-out NOR the post twice).
//   4. finalize         — update the row's terminal status + summary.
//
// Each step is idempotent: a Workflow resume replays the memoized result rather
// than re-running the body. NO container / browser imports live here — the PoC
// deploy binds neither.

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import {
  ConfigDeferred,
  makeConfigKvLive,
  makeGitlabScmLive,
  makeModelGatewayLive,
  ModelGatewayDeferred,
} from "@flare-dispatch/runtime-cf";
import {
  mrPostNote,
  mrReviewCompute,
  type MrReviewInput,
} from "@flare-dispatch/runs/mr-review";
import { reviewOutcome } from "./gitlab-review-outcome";
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
    // same narrowing workflow.ts uses. NOTE: `step` is an RPC stub — `step.do`
    // must be invoked as a property call (receiver preserved); extracting it
    // via `.bind(step)` throws `The RPC receiver does not implement "bind"`.
    const stepDo: StepDo = (name, cb) =>
      (step.do as unknown as StepDo)(name, cb);
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

    // The GitLab `scm` Layer — built once, reused by the review + post steps.
    const scmLayer = makeGitlabScmLive(
      this.env.GITLAB_TOKEN !== undefined ? { token: this.env.GITLAB_TOKEN } : {},
    );

    // 2. The review COMPUTE (no post). Build the 3-Layer stack, each Layer
    //    degrading when its binding/secret is absent (config dies on read, model
    //    fails typed, scm fails auth-failed) — `mrReviewCompute` catches those
    //    into a failure note and never itself fails. `reviewOutcome` maps the
    //    Exit to the row fields + note body, logging the Cause on any defect.
    const outcome = await stepDo("review", async () => {
      const modelLayer =
        this.env.AI === undefined
          ? ModelGatewayDeferred
          : makeModelGatewayLive(
              this.env.AI,
              this.env.AI_GATEWAY_ID !== undefined && this.env.AI_GATEWAY_ID.length > 0
                ? this.env.AI_GATEWAY_ID
                : undefined,
              // cloudflareAccountId / gatewayAuthToken / usageSink are unused in
              // the PoC (no Bedrock, no D1 metering sink) — pass through to the
              // OPENROUTER_API_KEY slot so the `openrouter/*` A/B backend works.
              undefined,
              undefined,
              undefined,
              this.env.OPENROUTER_API_KEY,
            );
      const configLayer =
        this.env.CONFIG_KV === undefined
          ? ConfigDeferred
          : makeConfigKvLive(this.env.CONFIG_KV);
      const layer = Layer.mergeAll(modelLayer, configLayer, scmLayer);

      const exit = await Effect.runPromiseExit(
        mrReviewCompute(input).pipe(Effect.provide(layer)),
      );
      return reviewOutcome(exit);
    });

    // 3. Post the note — its OWN durable step, so a replay after a completed
    //    post never re-posts the model fan-out's note. Best-effort: a post
    //    failure is logged, never fails the (already-computed) review. A `null`
    //    body (skipped-quota) posts NOTHING — the run degraded gracefully.
    await stepDo("post-review", async () => {
      const body = outcome.noteBody;
      if (body === null) return { posted: false };
      await Effect.runPromise(
        mrPostNote(input, body).pipe(
          Effect.provide(scmLayer),
          Effect.catchAll((e) =>
            Effect.logWarning(`gitlab-review: posting MR note failed — ${String(e)}`),
          ),
        ),
      );
      return { posted: true };
    });

    // 4. Terminal status + summary.
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

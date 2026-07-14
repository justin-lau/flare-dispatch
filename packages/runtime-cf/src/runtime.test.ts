// Integration tests for the composed live runtime driving `offload-test`.
//
// Exercises the real D1 / R2 / `StepRunnerCloudflare` Layers (Miniflare-backed
// bindings) end-to-end against the actual `offload-test` run — the closest the
// PR4 suite can get to `RunWorkflow` without a container runtime.
//
// --- What is real vs. stubbed, and why ---------------------------------------
//
//   * D1 (`D1ExecutionsLive`)         — REAL, Miniflare D1.
//   * R2 (`R2ArtifactLive`)           — REAL, Miniflare R2.
//   * Step boundary (`StepRunner...`) — REAL `StepRunnerCloudflare`, fed a
//                                       fake `WorkflowStep` whose `.do(name,cb)`
//                                       just awaits `cb()` (Miniflare has no
//                                       Workflows engine; the runner's
//                                       runEffect/throw/re-fail logic is what
//                                       this exercises).
//   * Sandbox (`SandboxCloudflare...`)— STUBBED with the core `sandboxFake`:
//                                       Cloudflare Containers cannot boot under
//                                       Miniflare without a container runtime
//                                       (plan § 6). The live `exec`/`clone`
//                                       mapping is covered by typecheck +
//                                       `wrangler deploy --dry-run`; the
//                                       container smoke is PR5's `wrangler dev`.
//
// The two acceptance cases from plan § PR4: `offload-test` reaches a green
// `executions` row on exit 0 and a red (but non-failed) row on exit 1.
//
// Spec: specs/pm/plan.md § PR4 acceptance.

import { Effect, Exit, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Executions, type RunContext } from "@flare-dispatch/core";
import { CacheFake, sandboxFakeProgram } from "@flare-dispatch/core/testing";
import { offloadTest } from "@flare-dispatch/runs";
import { makeR2ArtifactLive } from "./artifact-r2";
import { makeChecksGithubLive } from "./checks-github";
import {
  BrowserDeferred,
  ChildRunsDeferred,
  CloudflareDeferred,
  ConfigDeferred,
  GithubDeferred,
  ModelGatewayDeferred,
  OidcDeferred,
  ScmDeferred,
} from "./deferred";
import { type ExecutionContext, makeD1ExecutionsLive } from "./executions-d1";
import { makeEmailCloudflareLive } from "./email-cf";
import { makeMailboxCloudflareLive } from "./mailbox-cf";
import { makeIOLive } from "./io-live";
import { makeStepRunnerCloudflare } from "./step-runner-cf";
import { countRows, makeTestBindings, type TestBindings } from "./test-support";

/**
 * A fake `WorkflowStep` — `.do(name, cb)` just runs the callback. Miniflare has
 * no Workflows engine, so this stands in for the real `step` argument;
 * `StepRunnerCloudflare`'s runEffect / throw-at-boundary / re-fail logic runs
 * for real against it.
 */
const fakeWorkflowStep = {
  // Handle both `do(name, cb)` and `do(name, config, cb)` — the runner uses the
  // config overload when a step sets a timeout/retries. The fake ignores the
  // config (there is no Workflows engine to honor it) and just runs the body.
  do: <T>(
    _name: string,
    configOrCallback: unknown,
    maybeCallback?: () => Promise<T>,
  ): Promise<T> => {
    const callback =
      typeof configOrCallback === "function"
        ? (configOrCallback as () => Promise<T>)
        : (maybeCallback as () => Promise<T>);
    return callback();
  },
};

/**
 * Build a `RunContext` Layer with REAL D1 / R2 / `StepRunnerCloudflare`, the
 * sandbox stubbed by the core fake. Mirrors `makeCFRuntimeLive` minus the live
 * Containers binding.
 */
const makeRuntimeUnderTest = (
  bindings: TestBindings,
  executionId: string,
  ctx: ExecutionContext,
  sandboxProgram: Parameters<typeof sandboxFakeProgram>[0],
): Layer.Layer<RunContext> => {
  const io = makeIOLive();
  const executions = makeD1ExecutionsLive(bindings.db, ctx);
  const artifact = makeR2ArtifactLive(bindings.bucket, executionId);
  const stepRunner = makeStepRunnerCloudflare(fakeWorkflowStep, executionId);

  return Layer.mergeAll(
    sandboxFakeProgram(sandboxProgram),
    BrowserDeferred,
    // `offload-test` never touches `cache`; the fake satisfies the Tag without
    // a Containers binding the live `makeCacheR2Live` would need.
    CacheFake,
    artifact,
    io,
    ConfigDeferred,
    GithubDeferred,
    CloudflareDeferred,
    ModelGatewayDeferred,
    ScmDeferred,
    OidcDeferred,
    // No App credentials in this Miniflare suite → the no-op `Checks` Layer.
    makeChecksGithubLive(undefined),
    // No Email Routing in this suite → the no-op `Email` Layer.
    makeEmailCloudflareLive(undefined),
    // No INBOX_DOMAIN in this suite → the dying `Mailbox` stub.
    makeMailboxCloudflareLive(undefined),
    // No RUNS_WORKFLOW binding in this suite → the dying `ChildRuns` stub.
    ChildRunsDeferred,
    executions,
    Layer.provide(stepRunner, Layer.merge(executions, io)),
  );
};

const CTX: ExecutionContext = {
  repo: "owner/name",
  ref: "refs/heads/main",
  sha: "abc123",
  input: { repo: "owner/name", sha: "abc123", command: "pnpm test" },
};
const INPUT = {
  repo: "owner/name",
  sha: "abc123",
  command: "pnpm test",
  secrets: [] as readonly string[],
  install: false,
  failOnNonZeroExit: false,
};

/**
 * The `RunWorkflow` execution-row finalize boundary, minimal: open the row,
 * run the run Effect to an Exit, write the terminal status from it. The same
 * shape `apps/dispatcher/src/workflow.ts` runs — reproduced here so the test
 * does not need the CF `WorkflowEntrypoint` class.
 */
const driveRun = (
  layer: Layer.Layer<RunContext>,
  executionId: string,
): Promise<Exit.Exit<unknown, unknown>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const executions = yield* Executions;
      yield* executions.startExecution({
        id: executionId,
        run: "offload-test",
        startedAt: 0,
      });
      const exit = yield* Effect.exit(offloadTest.run(INPUT));
      yield* executions.finishExecution({
        id: executionId,
        completedAt: 100,
        status: Exit.match(exit, {
          onSuccess: () => "success" as const,
          onFailure: () => "failure" as const,
        }),
      });
      return exit;
    }).pipe(Effect.provide(layer)),
  );

describe("CFRuntimeLive — offload-test end-to-end", () => {
  let bindings: TestBindings;

  beforeEach(async () => {
    bindings = await makeTestBindings();
    // `offload-test`'s upload-log step uploads the exec step's `logPath`. The
    // core sandbox fake pins a canned `logPath` of `logs/fake/exec.ndjson`;
    // seed that source object so the live `R2ArtifactLive` upload can promote
    // it. (The live `SandboxCloudflareLive.exec` writes this key itself; the
    // fake does not, so the test seeds it.)
    await bindings.bucket.put("logs/fake/exec.ndjson", "fake exec log\n");
  });
  afterEach(async () => {
    await bindings.dispose();
  });

  it("green path — exit 0 → success row, one steps row per step", async () => {
    const executionId = "01TEST0000000000000000GREEN";
    const layer = makeRuntimeUnderTest(bindings, executionId, CTX, {
      "pnpm test": { exitCode: 0 },
    });

    const exit = await driveRun(layer, executionId);
    expect(Exit.isSuccess(exit)).toBe(true);

    // One executions row, status success.
    expect(await countRows(bindings.db, "executions")).toBe(1);
    const execRow = await bindings.db
      .prepare(`SELECT status FROM executions WHERE id = ?`)
      .bind(executionId)
      .first<{ status: string }>();
    expect(execRow?.status).toBe("success");

    // `offload-test` has three run-body steps — checkout, exec, upload-log —
    // each one `steps` row (plan § 6: D1 write count stays bounded).
    expect(await countRows(bindings.db, "steps")).toBe(3);
    const stepRows = await bindings.db
      .prepare(`SELECT name, status FROM steps WHERE execution_id = ?`)
      .bind(executionId)
      .all<{ name: string; status: string }>();
    expect(stepRows.results.map((r) => r.name).sort()).toEqual([
      "checkout",
      "exec",
      "upload-log",
    ]);
    expect(stepRows.results.every((r) => r.status === "success")).toBe(true);
  });

  it("red path — exit 1 → failure-free run, but a 'success' execution row", async () => {
    // A non-zero command exit is a NORMAL result (a failing test) — the run
    // Effect *succeeds*, surfacing `exitCode: 1`. The execution row is
    // therefore `success` (the run completed); the red verdict is the
    // check-run's job (PR6), not the execution status.
    const executionId = "01TEST00000000000000000RED";
    const layer = makeRuntimeUnderTest(bindings, executionId, CTX, {
      "pnpm test": { exitCode: 1, stderr: "1 failing" },
    });

    const exit = await driveRun(layer, executionId);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect((exit.value as { exitCode: number }).exitCode).toBe(1);
    }

    const execRow = await bindings.db
      .prepare(`SELECT status FROM executions WHERE id = ?`)
      .bind(executionId)
      .first<{ status: string }>();
    expect(execRow?.status).toBe("success");
    // All three steps still recorded successful — exit 1 does not fail a step.
    const stepRows = await bindings.db
      .prepare(`SELECT status FROM steps WHERE execution_id = ?`)
      .bind(executionId)
      .all<{ status: string }>();
    expect(stepRows.results.every((r) => r.status === "success")).toBe(true);
  });

  it("exec timeout → ExecTimeout propagates, execution row is 'failure'", async () => {
    // A genuine `ExecTimeout` is a typed run failure — the StepRunnerCloudflare
    // throw-at-boundary / re-fail path must carry it back into the `E` channel
    // so the run Effect fails and the execution row is `failure`.
    const executionId = "01TEST000000000000000TIMEOUT";
    const layer = makeRuntimeUnderTest(bindings, executionId, CTX, {
      "pnpm test": { fail: "ExecTimeout", timeoutSec: 600 },
    });

    const exit = await driveRun(layer, executionId);
    expect(Exit.isFailure(exit)).toBe(true);

    const execRow = await bindings.db
      .prepare(`SELECT status FROM executions WHERE id = ?`)
      .bind(executionId)
      .first<{ status: string }>();
    expect(execRow?.status).toBe("failure");
    // The failed `exec` step is recorded with its error tag.
    const execStep = await bindings.db
      .prepare(`SELECT status FROM steps WHERE execution_id = ? AND name = ?`)
      .bind(executionId, "exec")
      .first<{ status: string }>();
    expect(execStep?.status).toBe("failure");
  });

  it("writes the artifact log object via R2ArtifactLive", async () => {
    // `offload-test`'s upload-log step calls `artifact.upload` with the exec
    // step's `logPath`. The sandbox fake's canned ExecResult pins
    // `logPath: logs/fake/exec.ndjson`; seed that source object so the live
    // R2 upload can promote it to the artifact key.
    const executionId = "01TEST0000000000000ARTIFACT";
    await bindings.bucket.put("logs/fake/exec.ndjson", "fake log\n");

    const layer = makeRuntimeUnderTest(bindings, executionId, CTX, {
      "pnpm test": { exitCode: 0 },
    });
    const exit = await driveRun(layer, executionId);
    expect(Exit.isSuccess(exit)).toBe(true);

    const artifactObj = await bindings.bucket.get(
      `artifacts/${executionId}/step.log`,
    );
    expect(artifactObj).not.toBeNull();
    expect(await artifactObj?.text()).toBe("fake log\n");
  });
});

// @flare-dispatch/core/testing — the in-memory test runtime.
//
// `CFRuntimeTest` is the full `RunContext` wired to in-memory fakes: a run
// Effect executes against it in plain `vitest` with no CF, Docker, or network.
//
// specs/03-dsl.md § Unit-testing runs sketches `CFRuntimeTest` and
// `sandboxFakeProgram` as living in a separate `@flare-dispatch/runtime-test`
// package. V0 consolidates them here, behind the `@flare-dispatch/core/testing`
// sub-path — one fewer package to publish/pin while the surface is small. If
// the test runtime grows its own dependencies it can be split out later; the
// import path (`@flare-dispatch/core/testing`) is the seam that makes that
// move mechanical.
//
// Spec: specs/pm/plan.md § PR2, specs/03-dsl.md § Layers + § Unit-testing runs.

import { Layer } from "effect";
import {
  ArtifactFake,
  type ArtifactFakeState,
  makeArtifactFake,
} from "./fakes/artifact-fake";
import {
  ChecksFake,
  type ChecksFakeState,
  makeChecksFake,
} from "./fakes/checks-fake";
import {
  ChildRunsFake,
  type ChildRunsFakeState,
  makeChildRunsFake,
} from "./fakes/child-runs-fake";
import {
  EmailFake,
  type EmailFakeState,
  makeEmailFake,
} from "./fakes/email-fake";
import {
  ExecutionsFake,
  type ExecutionsFakeState,
  makeExecutionsFake,
} from "./fakes/executions-fake";
import { IOFake, type IOFakeState, makeIOFake } from "./fakes/io-fake";
import {
  MailboxFake,
  type MailboxFakeState,
  makeMailboxFake,
} from "./fakes/mailbox-fake";
import {
  BrowserFake,
  type BrowserFakeState,
  CacheFake,
  ConfigFake,
  makeBrowserFake,
  makeConfigFake,
} from "./fakes/misc-fakes";
import {
  GithubFake,
  type GithubFakeState,
  makeGithubFake,
} from "./fakes/github-fake";
import {
  CloudflareFake,
  type CloudflareFakeState,
  makeCloudflareFake,
} from "./fakes/cloudflare-fake";
import {
  makeModelGatewayFake,
  ModelGatewayFake,
  type ModelGatewayFakeState,
} from "./fakes/model-gateway-fake";
import {
  OidcFake,
  type OidcFakeState,
  makeOidcFake,
} from "./fakes/oidc-fake";
import {
  makeScmFake,
  ScmFake,
  type ScmFakeState,
} from "./fakes/scm-fake";
import {
  makeSandboxFake,
  SandboxFake,
  type SandboxFakeState,
} from "./fakes/sandbox-fake";
import {
  DEFAULT_TEST_EXECUTION_ID,
  makeStepRunnerInline,
  StepRunnerInline,
} from "./fakes/step-runner-inline";
import type { RunContext } from "./context";

// --- Re-export the fakes + their builders ------------------------------------
export {
  ArtifactFake,
  makeArtifactFake,
  type ArtifactFakeState,
} from "./fakes/artifact-fake";
export {
  ChecksFake,
  makeChecksFake,
  type ChecksFakeState,
  type CheckCreateCall,
  type CheckProgressCall,
  type CheckUpdateCall,
} from "./fakes/checks-fake";
export {
  ChildRunsFake,
  makeChildRunsFake,
  type ChildRunsFakeState,
  type SpawnRecord,
} from "./fakes/child-runs-fake";
export {
  EmailFake,
  makeEmailFake,
  type EmailFakeState,
} from "./fakes/email-fake";
export {
  MailboxFake,
  makeMailboxFake,
  type MailboxFakeState,
  type MailboxFakeOptions,
} from "./fakes/mailbox-fake";
export {
  ExecutionsFake,
  makeExecutionsFake,
  type ExecutionsFakeState,
} from "./fakes/executions-fake";
export {
  IOFake,
  makeIOFake,
  type IOFakeState,
  type IOFakeOptions,
  type LogEntry,
} from "./fakes/io-fake";
export {
  BrowserFake,
  type BrowserFakeState,
  CacheFake,
  ConfigFake,
  makeBrowserFake,
  makeConfigFake,
} from "./fakes/misc-fakes";
export {
  GithubFake,
  makeGithubFake,
  type GithubFakeState,
} from "./fakes/github-fake";
export {
  CloudflareFake,
  makeCloudflareFake,
  type CloudflareFakeState,
} from "./fakes/cloudflare-fake";
export {
  ModelGatewayFake,
  makeModelGatewayFake,
  type ModelGatewayFakeState,
  type ModelGatewayFakeOptions,
  type ModelGatewayFakeResponse,
} from "./fakes/model-gateway-fake";
export {
  OidcFake,
  makeOidcFake,
  type OidcFakeState,
} from "./fakes/oidc-fake";
export {
  ScmFake,
  makeScmFake,
  type ScmFakeState,
  type ScmFakeOptions,
} from "./fakes/scm-fake";
export {
  SandboxFake,
  makeSandboxFake,
  sandboxFakeProgram,
  type SandboxFakeState,
  type CannedExec,
  type CannedProgram,
} from "./fakes/sandbox-fake";
export {
  StepRunnerInline,
  makeStepRunnerInline,
  DEFAULT_TEST_EXECUTION_ID,
  enqueueInlineEvent,
  type InlineEventQueue,
} from "./fakes/step-runner-inline";

/**
 * The complete test runtime: every capability service backed by an in-memory
 * fake, the step boundary backed by `StepRunnerInline`. Provide this to a run
 * Effect and it executes fully in-process.
 *
 * The fakes here are the *default* (no-arg) builds — their internal state is
 * not externally visible. A test that needs to assert on fake state composes
 * its own runtime from `makeCFRuntimeTest`.
 */
export const CFRuntimeTest: Layer.Layer<RunContext> = Layer.mergeAll(
  SandboxFake,
  BrowserFake,
  CacheFake,
  ArtifactFake,
  IOFake,
  ConfigFake,
  ChecksFake,
  EmailFake,
  MailboxFake,
  GithubFake,
  CloudflareFake,
  ModelGatewayFake,
  ScmFake,
  OidcFake,
  ChildRunsFake,
  ExecutionsFake,
  // StepRunnerInline needs Executions + IO — supply them from the merge above.
  Layer.provide(StepRunnerInline, Layer.merge(ExecutionsFake, IOFake)),
);

/** Inspectable handles to every fake in a `makeCFRuntimeTest` runtime. */
export type CFRuntimeTestHandles = {
  readonly sandbox: SandboxFakeState;
  readonly browser: BrowserFakeState;
  readonly artifact: ArtifactFakeState;
  readonly io: IOFakeState;
  readonly checks: ChecksFakeState;
  readonly email: EmailFakeState;
  readonly mailbox: MailboxFakeState;
  readonly executions: ExecutionsFakeState;
  readonly github: GithubFakeState;
  readonly cloudflare: CloudflareFakeState;
  readonly modelGateway: ModelGatewayFakeState;
  readonly scm: ScmFakeState;
  readonly oidc: OidcFakeState;
  readonly childRuns: ChildRunsFakeState;
  /** The inline runner's event queue — feed `step.waitForEvent` from tests. */
  readonly eventQueue: import("./fakes/step-runner-inline").InlineEventQueue;
};

export type CFRuntimeTestOptions = {
  /** canned command→result program for the sandbox fake. */
  readonly sandboxProgram?: Parameters<typeof makeSandboxFake>[0];
  /** path→content map answering `sandbox.readFile`; an unseeded path fails. */
  readonly sandboxFiles?: Parameters<typeof makeSandboxFake>[1];
  /**
   * Transient `runDetached` launch failures — command-substring → number of
   * leading launches to reject with `ContainerLaunchFailed` before succeeding.
   * Drives a run's launch-retry path (e.g. product-demo's `runAgent`).
   */
  readonly sandboxLaunchFailures?: Parameters<typeof makeSandboxFake>[2];
  /** Browser fake options — e.g. the canned CDP `wsEndpoint`. */
  readonly browser?: Parameters<typeof makeBrowserFake>[0];
  /** Config-store seed — `config.get` keys a run / `loadSecrets` resolves. */
  readonly config?: Record<string, string>;
  /** Mailbox fake options — the inbox domain + local-part seed the
   * deterministic `allocate` mint uses. */
  readonly mailbox?: Parameters<typeof makeMailboxFake>[0];
  /** Github fake seed — repos + PRs + workflow runs returned by `github.*`. */
  readonly github?: Parameters<typeof makeGithubFake>[0];
  /** Cloudflare fake seed — deployments returned by `cloudflare.*`. */
  readonly cloudflare?: Parameters<typeof makeCloudflareFake>[0];
  /** ModelGateway fake script — answers `modelGateway.complete` returns. */
  readonly modelGateway?: Parameters<typeof makeModelGatewayFake>[0];
  /** Scm fake options — the canned diff `scm.fetchDiff` returns. */
  readonly scm?: Parameters<typeof makeScmFake>[0];
  /** Oidc fake options — issuer override + deterministic `iat` clock. */
  readonly oidc?: Parameters<typeof makeOidcFake>[0];
  /** ChildRuns fake options — instance ids to treat as already-created. */
  readonly childRuns?: Parameters<typeof makeChildRunsFake>[0];
  /** the execution id `StepRunnerInline` records steps under. */
  readonly executionId?: string;
  /** IO fake clock options. */
  readonly io?: Parameters<typeof makeIOFake>[0];
  /**
   * Event queue `step.waitForEvent` resolves against. Tests pre-populate it
   * with `enqueueInlineEvent(queue, type, payload)`; an empty queue causes
   * the run's `waitForEvent` to fail with `ApprovalTimedOut` immediately
   * (the inline runner does not sleep). The same queue is returned in
   * `handles.eventQueue` so a test can inject AFTER constructing the runtime.
   */
  readonly eventQueue?: import("./fakes/step-runner-inline").InlineEventQueue;
};

/**
 * Build a test runtime *plus* inspectable handles to every fake — the entry
 * point for tests that assert "the fake ExecutionsService recorded N steps" or
 * "the sandbox saw command X". `CFRuntimeTest` is the no-assertion shortcut.
 */
export const makeCFRuntimeTest = (
  opts: CFRuntimeTestOptions = {},
): { layer: Layer.Layer<RunContext>; handles: CFRuntimeTestHandles } => {
  const sandbox = makeSandboxFake(
    opts.sandboxProgram,
    opts.sandboxFiles,
    opts.sandboxLaunchFailures,
  );
  const browser = makeBrowserFake(opts.browser);
  const artifact = makeArtifactFake();
  // One execution id shared by the step runner AND `io.executionId`, so a run
  // that addresses itself (e.g. the release-PR marker) sees the same id its
  // steps record under.
  const executionId = opts.executionId ?? DEFAULT_TEST_EXECUTION_ID;
  const io = makeIOFake({ ...opts.io, executionId });
  const checks = makeChecksFake();
  const emailFake = makeEmailFake();
  const mailboxFake = makeMailboxFake(opts.mailbox);
  const github = makeGithubFake(opts.github);
  const cloudflare = makeCloudflareFake(opts.cloudflare);
  const modelGateway = makeModelGatewayFake(opts.modelGateway);
  const scm = makeScmFake(opts.scm);
  const oidcLayer = makeOidcFake(opts.oidc);
  const childRuns = makeChildRunsFake(opts.childRuns);
  const executions = makeExecutionsFake();
  const eventQueue = opts.eventQueue ?? new Map<string, unknown[]>();
  const stepRunner = makeStepRunnerInline({
    executionId,
    eventQueue,
  });

  const layer = Layer.mergeAll(
    sandbox.layer,
    browser.layer,
    CacheFake,
    artifact.layer,
    io.layer,
    makeConfigFake(opts.config),
    checks.layer,
    emailFake.layer,
    mailboxFake.layer,
    github.layer,
    cloudflare.layer,
    modelGateway.layer,
    scm.layer,
    oidcLayer.layer,
    childRuns.layer,
    executions.layer,
    Layer.provide(stepRunner, Layer.merge(executions.layer, io.layer)),
  );

  return {
    layer,
    handles: {
      sandbox: sandbox.state,
      browser: browser.state,
      artifact: artifact.state,
      io: io.state,
      checks: checks.state,
      email: emailFake.state,
      mailbox: mailboxFake.state,
      github: github.state,
      cloudflare: cloudflare.state,
      modelGateway: modelGateway.state,
      scm: scm.state,
      oidc: oidcLayer.state,
      childRuns: childRuns.state,
      executions: executions.state,
      eventQueue,
    },
  };
};

// @flare-dispatch/core — RunContext.
//
// The aggregate environment a run's Effect carries in its R channel: the union
// of every capability service. A runtime Layer (CFRuntimeLive / Dev / Test)
// provides all of them at once; a run never constructs it directly.
//
// `Executions` and `StepRunner` are part of `RunContext` even though a run
// never calls them directly: `step` (the run frame) depends on both — it runs
// the body via the `StepRunner` strategy and records the lifecycle into
// `Executions` — so any Effect that contains a `step(...)` carries them in R.
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § 3.

import type { Artifact } from "./services/artifact";
import type { Browser } from "./services/browser";
import type { Cache } from "./services/cache";
import type { Checks } from "./services/checks";
import type { ChildRuns } from "./services/child-runs";
import type { Cloudflare } from "./services/cloudflare";
import type { Config } from "./services/config";
import type { Email } from "./services/email";
import type { Executions } from "./services/executions";
import type { Github } from "./services/github";
import type { IO } from "./services/io";
import type { Mailbox } from "./services/mailbox";
import type { ModelGateway } from "./services/model-gateway";
import type { Oidc } from "./services/oidc";
import type { Sandbox } from "./services/sandbox";
import type { Scm } from "./services/scm";
import type { StepRunner } from "./services/step-runner";

/** The union of capability services every run Effect depends on. */
export type RunContext =
  | Sandbox
  | Browser
  | Cache
  | Artifact
  | IO
  | Config
  | Checks
  | Email
  | Mailbox
  | Github
  | Cloudflare
  | ModelGateway
  | Scm
  | Oidc
  | ChildRuns
  | Executions
  | StepRunner;

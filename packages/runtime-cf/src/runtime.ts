// @flare-dispatch/runtime-cf — CFRuntimeLive: the composed live runtime Layer.
//
// `Layer.mergeAll` of every capability Layer, wired to the real Cloudflare
// bindings — the production counterpart of `@flare-dispatch/core/testing`'s
// `CFRuntimeTest`. A run Effect provided this Layer executes against live D1 /
// R2 / Containers / Workflows. specs/03-dsl.md § Layers sketches `CFRuntimeLive`
// as a static value; in practice it is per-execution — the D1 `executions`
// row, the R2 artifact prefix, and the `StepRunner`'s `WorkflowStep` are all
// execution-scoped — so it is built by `makeCFRuntimeLive` from the dispatch
// event inside `RunWorkflow.run`.
//
// Layer composition note: `StepRunnerCloudflare` depends on `Executions` + `IO`
// (it records the step lifecycle), so its Layer is `Layer.provide`d those two
// — exactly how `CFRuntimeTest` wires `StepRunnerInline`.
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § PR4.

import { type Sandbox } from "@cloudflare/sandbox";
import { Layer } from "effect";
import type { RunContext } from "@flare-dispatch/core";
import { makeR2ArtifactLive } from "./artifact-r2";
import {
  type BrowserRenderingConfig,
  makeBrowserRenderingLive,
} from "./browser-cf";
import { makeCacheR2Live } from "./cache-r2";
import {
  type ChecksGithubConfig,
  makeChecksGithubLive,
} from "./checks-github";
import {
  type WorkflowBindingLike,
  makeChildRunsLive,
} from "./child-runs-cf";
import { makeConfigKvLive } from "./config-kv";
import {
  type EmailCloudflareConfig,
  makeEmailCloudflareLive,
} from "./email-cf";
import {
  type MailboxCloudflareConfig,
  makeMailboxCloudflareLive,
} from "./mailbox-cf";
import {
  BrowserDeferred,
  ChildRunsDeferred,
  CloudflareDeferred,
  ConfigDeferred,
  ModelGatewayDeferred,
  OidcDeferred,
  ScmDeferred,
} from "./deferred";
import {
  type CloudflareLiveConfig,
  makeCloudflareLive,
} from "./cloudflare-live";
import { type GithubLiveConfig, makeGithubLive } from "./github-live";
import { type AiBinding, makeModelGatewayLive } from "./model-gateway-cf";
import { makeOidcLive, type OidcLiveConfig } from "./oidc-live";
import { type ExecutionContext, makeD1ExecutionsLive } from "./executions-d1";
import { makeIOLive } from "./io-live";
import { makeSandboxCloudflareLive } from "./sandbox-cf";
import { makeStepRunnerCloudflare } from "./step-runner-cf";

/** The minimal `WorkflowStep` surface `StepRunnerCloudflare` needs. */
type WorkflowStepLike = {
  readonly do: <T>(name: string, callback: () => Promise<T>) => Promise<T>;
};

/** Everything `makeCFRuntimeLive` needs to wire the per-execution runtime. */
export type CFRuntimeLiveOptions = {
  /** D1 binding — `env.RUNS_METADATA`. */
  readonly db: D1Database;
  /** R2 binding — `env.RUNS_STORAGE`. */
  readonly bucket: R2Bucket;
  /** Containers binding — `env.RUNS_SANDBOX`. */
  readonly sandboxNs: DurableObjectNamespace<Sandbox>;
  /** The `step` argument from `WorkflowEntrypoint.run`. */
  readonly workflowStep: WorkflowStepLike;
  /**
   * The CF `Workflow` binding (`env.RUNS_WORKFLOW`) backing the `childRuns`
   * capability (`spawnChildRun` / the `fanOut` primitive). A run spawns child
   * `RunWorkflow` instances through it, inheriting this execution's github
   * context and recording this execution's id as each child's
   * `parent_execution_id` lineage. `undefined` selects `ChildRunsDeferred`: a
   * run that calls `spawnChildRun` then dies loudly. `RUNS_WORKFLOW` is a
   * required Dispatcher binding, so the production call site always passes it.
   */
  readonly runsWorkflow?: WorkflowBindingLike;
  /** This execution's ULID — namespaces D1 rows, R2 keys, the sandbox id. */
  readonly executionId: string;
  /** repo/ref/sha/input the `executions` row requires. */
  readonly execution: ExecutionContext;
  /**
   * GitHub App credentials + installation id for the `Checks` capability
   * (PR check-run posting) AND the `Sandbox` capability's `gitClone`
   * (private-repo HTTPS auth). `undefined` (no `GITHUB_APP_ID` /
   * `GITHUB_APP_PRIVATE_KEY` secret, or a dispatch with no `installation_id`)
   * selects the no-op `Checks` Layer + unauthenticated clone — the execution
   * still runs against public repos, only the PR check-run is skipped.
   *
   * One config powers both capabilities: a dispatch that can post a check-run
   * to a repo can also mint a fresh installation token for cloning the same
   * repo, so a second field would diverge silently. Pass once.
   */
  readonly checks?: ChecksGithubConfig;
  /**
   * GitHub App credentials for the `github` capability's read + content-write
   * surface (`actionRuns`, `openDraftPullRequest`) — used by Schedule-mode runs
   * (`spec-drift`, `ci-triage`) that carry no per-dispatch `installation_id`,
   * so they cannot ride `checks`. The capability resolves the per-repo
   * installation itself from the App JWT. `undefined` (no App secrets) → the
   * write surface is a logged no-op and the read surface returns empty. Distinct
   * from `checks`, which additionally pins a specific installation for the
   * check-run write; one App can power both.
   */
  readonly githubApp?: GithubLiveConfig;
  /**
   * Cloudflare REST credentials for the `cloudflare` capability — a scoped
   * `CLOUDFLARE_API_TOKEN` (Pages:Read) + `CLOUDFLARE_ACCOUNT_ID`. Used by the
   * `ci-triage` run to read failed Pages deployments. `undefined` (no token) →
   * `CloudflareDeferred`: `cloudflare.deployments` returns empty (a triage sweep
   * finds nothing CF-side rather than failing). Non-CF runs never touch the Tag.
   */
  readonly cloudflare?: CloudflareLiveConfig;
  /**
   * KV binding for the `config` capability (`env.CONFIG_KV`). `undefined` —
   * a deploy with no `CONFIG_KV` namespace — selects the dying `Config` stub:
   * a run that reads config fails loudly rather than silently seeing every
   * key as unset. Present, the `loadSecrets` primitive can resolve credentials.
   */
  readonly configKv?: KVNamespace;
  /**
   * Per-execution config overrides checked before `configKv` (specs/08 § 6.3).
   * The Worker injects execution-scoped values the run reads via `config.get`
   * but that must not persist in KV — the self-heal model-proxy URL + token.
   */
  readonly configOverrides?: Readonly<Record<string, string>>;
  /**
   * Browser Rendering connect config for the `browser` capability
   * (`BROWSER_CDP_*` Worker secrets). `undefined` — a deploy with no Browser
   * Rendering configured — selects the dying `Browser` stub: a browser run
   * (`cdp-acceptance`) fails loudly. Non-browser runs never touch the Tag.
   */
  readonly browser?: BrowserRenderingConfig;
  /**
   * The Worker's public domain (e.g. `flare-dispatch.<account>.workers.dev`)
   * the `sandbox` capability's `exposePort` uses to construct container preview
   * URLs — the publicly-reachable URL a cloud browser dials instead of the
   * container's `localhost`. A deploy-time property (`SANDBOX_PREVIEW_HOSTNAME`).
   * `undefined` — a deploy that has not configured it — makes `exposePort` fail
   * with `ExposePortFailed`; a browser-acceptance run that needs a reachable
   * URL fails loudly rather than handing the suite an unreachable `localhost`.
   * Non-browser runs never touch the surface.
   */
  readonly sandboxPreviewHostname?: string;
  /**
   * The dispatcher's own public origin (e.g.
   * `https://<worker>.<account>.workers.dev`) — prefixed onto the
   * `/v1/artifacts/...` URLs the `artifact` capability returns so the links
   * embedded in GitHub check-run summaries are absolute (GitHub resolves
   * relative markdown links against `github.com`, breaking them). Resolved by
   * the Workflow from the dispatch payload's request origin or the
   * `PUBLIC_ORIGIN` var; `undefined` keeps the historical relative paths.
   * Children inherit it via the `childRuns` dispatch payload.
   */
  readonly publicOrigin?: string;
  /**
   * The tokened log-viewer base URL for this execution
   * (`https://<origin>/logs/<id>?t=<token>`). Threaded into the `Sandbox`
   * Layer so the inline-truncation breadcrumb in a checkpointed `ExecResult`
   * deep-links to the readable viewer instead of the dead-end "full log in R2".
   * Built by the dispatcher (it owns the log-token secret); `undefined` keeps
   * the historical message.
   */
  readonly logsViewerBase?: string;
  /**
   * OIDC signing config for the `oidc` capability — the ES256 private JWK
   * (`OIDC_SIGNING_JWK` secret) + the issuer URL the IdP's trust policy
   * pins. `undefined` selects `OidcDeferred`: a run that calls `oidc.sign`
   * fails with `OidcSigningFailed` (`reason: "key-load"`).
   */
  readonly oidc?: OidcLiveConfig;
  /**
   * Cloudflare Email Routing config for the `email` capability — the
   * `SEND_EMAIL` binding + verified `EMAIL_FROM` sender. `undefined` (no
   * binding / no sender on this deploy) selects the no-op `Email` Layer: the
   * Workflow's completion-notify and any `email.send` in a run become a logged
   * no-op (`skipped: true`) rather than failing — email is reporting, never a
   * gate on the run's verdict.
   */
  readonly email?: EmailCloudflareConfig;
  /**
   * Cloudflare Email Routing + D1 config for the `mailbox` capability — the
   * `INBOX_DOMAIN` catch-all domain + the read-token signer. `undefined` (no
   * `INBOX_DOMAIN` on this deploy) selects the dying `Mailbox` stub: a run that
   * calls `mailbox.allocate` (via `provisionInbox`) fails loudly rather than
   * minting an address no inbound rule will deliver to. Only the
   * `email-otp-login` family of runs touches the Tag.
   */
  readonly mailbox?: MailboxCloudflareConfig;
  /**
   * Cloudflare Workers AI binding (`env.AI`) for the `modelGateway` capability —
   * the model backend the `pr-review` engine calls. The binding is the auth
   * (Workers AI is account-billed), so no model API key is configured. `undefined`
   * (no `"ai"` binding on this deploy) selects the dying `ModelGateway` stub: a
   * run that calls a model fails loudly; non-model runs never touch the Tag.
   */
  readonly ai?: AiBinding;
  /**
   * Optional AI Gateway id (`AI_GATEWAY_ID` var) the `modelGateway` routes
   * Workers AI calls through — for caching / rate-limiting / observability.
   * `undefined`/empty → call Workers AI directly (no gateway). Only used when
   * `ai` is present.
   *
   * REQUIRED for `anthropic/*` and `bedrock/*` model ids — those routes pin to
   * an AI Gateway URL pattern.
   */
  readonly aiGatewayId?: string;
  /**
   * Cloudflare account id (`CLOUDFLARE_ACCOUNT_ID` var) — the first segment of
   * the AI Gateway Bedrock forwarder URL. REQUIRED for `bedrock/*` model ids.
   * `undefined` → `bedrock/*` calls fail with an operator-facing error naming
   * what to set; other routes ignore this field.
   */
  readonly cloudflareAccountId?: string;
  /**
   * Optional `cf-aig-authorization` token (`AI_GATEWAY_AUTH_TOKEN` secret) —
   * forwarded as a header on every gateway-bound route (`anthropic/*`,
   * `deepseek/*`, `bedrock/*`) when the operator's AI Gateway has
   * [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
   * turned on. Orthogonal to AWS SigV4. The `@cf/*` Workers AI route uses the
   * binding (no header seam), so an authenticated gateway must allow first-party
   * Workers AI binding traffic.
   */
  readonly aiGatewayAuthToken?: string;
};

/**
 * Build the complete live `RunContext` Layer for one execution. All capability
 * services are merged; `StepRunnerCloudflare` is provided its `Executions` +
 * `IO` dependencies from the same merge.
 */
export const makeCFRuntimeLive = (
  opts: CFRuntimeLiveOptions,
): Layer.Layer<RunContext> => {
  const io = makeIOLive({
    db: opts.db,
    currentExecutionId: opts.executionId,
    ...(opts.logsViewerBase !== undefined
      ? { logsViewerBase: opts.logsViewerBase }
      : {}),
  });
  const executions = makeD1ExecutionsLive(opts.db, opts.execution);
  const artifact = makeR2ArtifactLive(
    opts.bucket,
    opts.executionId,
    opts.sandboxNs,
    opts.publicOrigin,
  );
  const sandbox = makeSandboxCloudflareLive(
    opts.sandboxNs,
    opts.bucket,
    opts.executionId,
    opts.checks,
    opts.sandboxPreviewHostname,
    opts.logsViewerBase,
  );
  const stepRunner = makeStepRunnerCloudflare(
    opts.workflowStep,
    opts.executionId,
  );
  const checks = makeChecksGithubLive(opts.checks);
  // The cache archive key is scoped by repo so two repos with an identical
  // lockfile hash cannot collide (cross-repo cache poisoning).
  const cache = makeCacheR2Live(
    opts.bucket,
    opts.sandboxNs,
    opts.execution.repo,
  );
  // `Config` is live when the `CONFIG_KV` binding is present; absent, the
  // dying stub keeps a config-reading run from silently mis-behaving.
  const config =
    opts.configKv === undefined
      ? ConfigDeferred
      : makeConfigKvLive(opts.configKv, opts.configOverrides);
  // `Browser` is live when Browser Rendering is configured; absent, the dying
  // stub keeps a browser run from silently mis-behaving.
  const browser =
    opts.browser === undefined
      ? BrowserDeferred
      : makeBrowserRenderingLive(opts.browser);
  // `Oidc` is live when the signing JWK + issuer are configured; absent, a
  // call to `oidc.sign` fails with `OidcSigningFailed`.
  const oidcLayer =
    opts.oidc === undefined ? OidcDeferred : makeOidcLive(opts.oidc);
  // `Email` is live when the Email Routing `send_email` binding + sender are
  // configured; absent, the no-op Layer logs and skips (notification must never
  // fail a run).
  const email = makeEmailCloudflareLive(opts.email);
  // `Mailbox` is live when `INBOX_DOMAIN` is configured; absent, the dying stub
  // keeps a provisioning run (`email-otp-login`) from minting addresses no
  // inbound rule delivers to.
  const mailbox = makeMailboxCloudflareLive(opts.mailbox);
  // `ModelGateway` is live when the Workers AI `"ai"` binding is present; absent,
  // the dying stub keeps a model-calling run from silently mis-behaving. The
  // binding is the auth (account-billed) — no model API key is configured.
  const modelGateway =
    opts.ai === undefined
      ? ModelGatewayDeferred
      : makeModelGatewayLive(
          opts.ai,
          opts.aiGatewayId !== undefined && opts.aiGatewayId.length > 0
            ? opts.aiGatewayId
            : undefined,
          opts.cloudflareAccountId !== undefined &&
            opts.cloudflareAccountId.length > 0
            ? opts.cloudflareAccountId
            : undefined,
          opts.aiGatewayAuthToken !== undefined &&
            opts.aiGatewayAuthToken.length > 0
            ? opts.aiGatewayAuthToken
            : undefined,
          // Per-execution token metering → `execution_model_usage` (cost
          // attribution). Same db + executionId the rest of the runtime uses.
          { db: opts.db, executionId: opts.executionId },
        );
  // `Github` is live when App credentials are present. Prefer the dedicated
  // `githubApp` creds (Schedule-mode runs that carry no installation_id), then
  // fall back to the `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` the `Checks`
  // capability carries (Webhook/Action mode). Absent → `pullReview` /
  // `openDraftPullRequest` are logged no-ops and the read surface returns empty
  // (reporting must never fail a run). The per-repo installation is resolved by
  // the capability itself when a request carries no `installationId`.
  const githubAppCfg =
    opts.githubApp ??
    (opts.checks === undefined
      ? undefined
      : {
          appId: opts.checks.appId,
          privateKeyPem: opts.checks.privateKeyPem,
        });
  const github = makeGithubLive(githubAppCfg);
  // `Cloudflare` is live when a scoped API token + account id are configured;
  // absent, the deferred Layer returns empty (a read-only capability degrades
  // to "found nothing", never a die).
  const cloudflare =
    opts.cloudflare === undefined
      ? CloudflareDeferred
      : makeCloudflareLive(opts.cloudflare);
  // `ChildRuns` is live when the `RUNS_WORKFLOW` binding is threaded in;
  // children inherit this execution's github context (so they post their own
  // check-runs) and record this execution's id as their `parent_execution_id`.
  // Absent the binding, the dying stub keeps a fan-out run from silently
  // dropping its children.
  const childRuns =
    opts.runsWorkflow === undefined
      ? ChildRunsDeferred
      : makeChildRunsLive({
          workflow: opts.runsWorkflow,
          db: opts.db,
          parentExecutionId: opts.executionId,
          // Children inherit the parent's public origin so their artifact
          // links are absolute too (a child posts its own check-run).
          ...(opts.publicOrigin !== undefined
            ? { origin: opts.publicOrigin }
            : {}),
          github: {
            repo: opts.execution.repo,
            ref: opts.execution.ref,
            sha: opts.execution.sha,
            ...(opts.checks?.installationId !== undefined
              ? { installationId: opts.checks.installationId }
              : {}),
          },
        });

  return Layer.mergeAll(
    sandbox,
    browser,
    cache,
    artifact,
    io,
    config,
    checks,
    email,
    mailbox,
    github,
    cloudflare,
    modelGateway,
    // `Scm` (the provider-neutral GitLab/GitHub review seam) is only wired live
    // by the GitLab PoC entry (apps/dispatcher/src/index.poc.ts) — the primary
    // runtime has no SCM provider, so the dying stub keeps the Tag satisfied
    // for `RunContext` without any existing run touching it.
    ScmDeferred,
    oidcLayer,
    childRuns,
    executions,
    // StepRunnerCloudflare needs Executions + IO — supply them from the merge.
    Layer.provide(stepRunner, Layer.merge(executions, io)),
  );
};

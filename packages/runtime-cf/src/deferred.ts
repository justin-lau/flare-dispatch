// @flare-dispatch/runtime-cf — deferred V0 capability Layers.
//
// `RunContext` is the union of *all* capability services, so `CFRuntimeLive`
// must supply a Layer for every Tag — even the ones a given deploy can't back.
// Per specs/pm/plan.md § 1 ("All other DSL surface stubbed to `Effect.die`")
// an unbacked capability fails loudly rather than silently mis-behaving.
//
// Live as of PR8: `Cache` (R2-backed, see cache-r2.ts — always wired) and
// `Config` (KV-backed, see config-kv.ts — wired when the `CONFIG_KV` binding
// is present, else `ConfigDeferred` below). `Checks` went live in PR6.
// `Browser` is the last V0 stub — Browser Rendering lands in V2 (PR9).
//
// Spec: specs/03-dsl.md § Layers, specs/pm/plan.md § PR4 + § PR6 + § PR8.

import { Effect, Layer } from "effect";
import {
  Browser,
  BrowserUnavailable,
  type BrowserService,
  ChildRuns,
  type ChildRunsService,
  Cloudflare,
  type CloudflareService,
  Config,
  type ConfigService,
  Github,
  type GithubService,
  ModelGateway,
  ModelGatewayError,
  type ModelGatewayService,
  Oidc,
  OidcSigningFailed,
  type OidcService,
  Scm,
  ScmError,
  type ScmService,
} from "@flare-dispatch/core";

/** Browser — Browser Rendering binding deferred to V2 (PR9). */
export const BrowserDeferred: Layer.Layer<Browser> = Layer.succeed(
  Browser,
  ((): BrowserService => ({
    newPage: () =>
      Effect.fail(
        new BrowserUnavailable({
          reason: "transient",
        }),
      ),
    newCDPSession: () =>
      Effect.fail(
        new BrowserUnavailable({
          reason: "transient",
        }),
      ),
  }))(),
);

/**
 * ChildRuns — the fallback when no `RUNS_WORKFLOW` binding is threaded into the
 * runtime. `RUNS_WORKFLOW` is a required Dispatcher binding, so the live runtime
 * always wires `makeChildRunsLive`; this stub only covers a runtime built
 * without it (a stand-alone capability harness). A run that calls
 * `spawnChildRun` on such a runtime dies loudly rather than silently dropping
 * the fan-out.
 */
export const ChildRunsDeferred: Layer.Layer<ChildRuns> = Layer.succeed(
  ChildRuns,
  ((): ChildRunsService => ({
    spawn: ({ run }) =>
      Effect.die(
        `spawnChildRun: no RUNS_WORKFLOW binding on this runtime (run="${run}")`,
      ),
    poll: () =>
      Effect.die(
        "waitForChildren: no RUNS_WORKFLOW binding on this runtime",
      ),
  }))(),
);

/**
 * Config — the fallback when a deploy has no `CONFIG_KV` namespace. A run that
 * reads config on such a deploy dies rather than silently seeing every key as
 * unset. A deploy with the binding gets the live `makeConfigKvLive` Layer.
 */
export const ConfigDeferred: Layer.Layer<Config> = Layer.succeed(
  Config,
  ((): ConfigService => ({
    get: () => Effect.die("config.get: no CONFIG_KV binding on this deploy"),
    getJSON: () =>
      Effect.die("config.getJSON: no CONFIG_KV binding on this deploy"),
  }))(),
);

/**
 * Github — the fallback until a live HTTP-backed binding lands. The Tag exists
 * so a run author can write `github.openPullRequests(...)` and unit-test it
 * against the in-memory fake (`GithubFake` in `@flare-dispatch/core/testing`).
 * A live deploy that has not wired the GitHub-API caller dies loudly rather
 * than silently returning empty arrays — this surface is V3+ work, paired
 * with the `pr-review-sweep` recipe.
 */
export const GithubDeferred: Layer.Layer<Github> = Layer.succeed(
  Github,
  ((): GithubService => ({
    repositories: () =>
      Effect.die(
        "github.repositories: not implemented in this deploy — V3 capability",
      ),
    openPullRequests: () =>
      Effect.die(
        "github.openPullRequests: not implemented in this deploy — V3 capability",
      ),
    // `actionRuns` (a read) degrades to empty on an uncredentialed deploy — a
    // Schedule-mode sweep simply finds nothing rather than dying. The live
    // credentialed path is `makeGithubLive` (github-live.ts).
    actionRuns: () =>
      Effect.logInfo(
        "github.actionRuns skipped (no GitHub App credentials) — empty",
      ).pipe(Effect.as([])),
    // `pullReview` is *reporting*, not correctness — a deploy without GitHub
    // App credentials degrades to a logged no-op (the same posture as the no-op
    // `Checks` Layer), never failing an otherwise-green run. The live
    // credentialed path is `makeGithubLive` (github-live.ts).
    pullReview: ({ repo, pr }) =>
      Effect.logInfo(
        `github.pullReview skipped (no GitHub App credentials) — PR comment on ${repo}#${pr} not posted`,
      ),
    // `openDraftPullRequest` (a content write) degrades to a logged no-op, the
    // same posture as `pullReview`. The recipe sees `created: false`.
    openDraftPullRequest: ({ repo, headBranch }) =>
      Effect.logInfo(
        `github.openDraftPullRequest skipped (no GitHub App credentials) — ${repo}#${headBranch} not opened`,
      ).pipe(Effect.as({ number: 0, url: "", created: false })),
    // `createRelease` (a release write) degrades to a logged no-op, the same
    // posture as the other writes. The recipe sees `published: false`.
    createRelease: ({ repo, tag }) =>
      Effect.logInfo(
        `github.createRelease skipped (no GitHub App credentials) — ${repo}@${tag} not published`,
      ).pipe(Effect.as({ id: 0, url: "", tag, published: false })),
  }))(),
);

/**
 * Cloudflare — the fallback when a deploy has no `CLOUDFLARE_API_TOKEN`. A
 * read-only capability, so the safe degradation is *empty*, not a die: a
 * Schedule-mode triage sweep finds nothing CF-side rather than failing the run.
 * The live credentialed path is `makeCloudflareLive` (cloudflare-live.ts).
 */
export const CloudflareDeferred: Layer.Layer<Cloudflare> = Layer.succeed(
  Cloudflare,
  ((): CloudflareService => ({
    deployments: () =>
      Effect.logInfo(
        "cloudflare.deployments skipped (no CLOUDFLARE_API_TOKEN) — empty",
      ).pipe(Effect.as([])),
    usage: ({ windowHours } = {}) =>
      Effect.logInfo(
        "cloudflare.usage skipped (no CLOUDFLARE_API_TOKEN) — empty snapshot",
      ).pipe(Effect.as({ windowHours: windowHours ?? 168, workers: [], ai: [] })),
  }))(),
);

/**
 * ModelGateway — the fallback when a deploy has no Workers AI `"ai"` binding.
 * The Tag is always supplied so a model-calling run can be tested against the
 * `ModelGatewayFake`; a live deploy without the binding fails the run with a
 * typed `ModelGatewayError` (`reason: "unknown"`) rather than silently
 * mis-behaving. Wire `makeModelGatewayLive(env.AI, gatewayId)` when the binding
 * is present. Only model-calling runs (`pr-review`) touch the Tag.
 */
export const ModelGatewayDeferred: Layer.Layer<ModelGateway> = Layer.succeed(
  ModelGateway,
  ((): ModelGatewayService => ({
    complete: ({ model }) =>
      Effect.fail(
        new ModelGatewayError({
          model,
          reason: "unknown",
          message: "modelGateway.complete: no Workers AI (`AI`) binding on this deploy",
        }),
      ),
  }))(),
);

/**
 * Scm — the fallback when a deploy has no SCM (GitLab) provider wired. The Tag
 * is always supplied so a review run can be tested against `ScmFake`; a live
 * deploy without a backing provider fails `fetchDiff` with a typed `ScmError`
 * (`reason: "unknown"`) and no-ops `postReview` (reporting must never fail a
 * run). Only the `mr-review` recipe touches the Tag; wire `makeGitlabScmLive`
 * when the `GITLAB_TOKEN` is present.
 */
export const ScmDeferred: Layer.Layer<Scm> = Layer.succeed(
  Scm,
  ((): ScmService => ({
    fetchDiff: () =>
      Effect.fail(
        new ScmError({
          provider: "none",
          reason: "unknown",
          message: "scm.fetchDiff: no SCM provider wired on this deploy",
        }),
      ),
    postReview: ({ ref }) =>
      Effect.logInfo(
        `scm.postReview skipped (no SCM provider) — note on ${ref.project}!${ref.number} not posted`,
      ),
  }))(),
);

/**
 * Oidc — the fallback when a deploy has no `OIDC_SIGNING_JWK` secret. The
 * Tag is always supplied so a run can be tested against the
 * `OidcFake`; a live deploy without the signing key fails the run with a
 * typed `OidcSigningFailed` rather than silently signing with a missing key.
 * Wire `makeOidcRenderingLive(jwk, issuer)` when the secret is present.
 */
export const OidcDeferred: Layer.Layer<Oidc> = Layer.succeed(
  Oidc,
  ((): OidcService => ({
    sign: () =>
      Effect.fail(
        new OidcSigningFailed({
          reason: "key-load",
          cause: "OIDC_SIGNING_JWK Worker secret not set on this deploy",
        }),
      ),
    // `issuer()` returns the configured issuer URL even on a no-key deploy
    // — the URL is operational metadata, not gated on key presence.
    issuer: () => Effect.succeed("https://oidc-not-configured.local"),
  }))(),
);


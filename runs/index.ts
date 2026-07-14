// @flare-dispatch/runs — the FlareDispatch starter run catalog.
//
// The Dispatcher's `RunWorkflow` resolves a dispatched run by name against
// this module's exports — the seam each new run slots into. V0 shipped
// `offload-test`; PR9 adds `cdp-acceptance` (browser acceptance, V2); the
// Schedule-mode PR adds `product-demo` (V3 — first cron-triggerable run, also
// dispatchable Action-mode via the recipe's ci.yml).
//
// Spec: specs/02-runs.md, specs/pm/plan.md § PR3 + § PR4 + § PR9 + § PR10.

export { offloadTest } from "./offload-test";
export { cdpAcceptance } from "./cdp-acceptance";
export { deploySmoke } from "./deploy-smoke";
export { workerDeploy } from "./worker-deploy";
export { matrixFanout } from "./matrix-fanout";
export { vitestShard } from "./vitest-shard";
export { playwrightE2E } from "./playwright-e2e";
export { productDemo } from "./product-demo";
export { playwrightDemo } from "./playwright-demo";
export { prReview } from "./pr-review";
export { mrReview } from "./mr-review";
export { specDriftPr } from "./spec-drift-pr";
export { ciTriagePr } from "./ci-triage-pr";
export { refreshFixtures } from "./refresh-fixtures";
export { selfHealPr } from "./self-heal-pr";
export { releaseNotes } from "./release-notes";
export { oxlint } from "./oxlint";
export { emailOtpLogin } from "./email-otp-login";
export { finopsAudit } from "./finops-audit";

// FlareDispatch Dispatcher — GitLab MR-review PoC entry point.
//
// A separate Worker entry from index.ts, deployed with wrangler.poc.jsonc. It
// reuses the SAME request router (router.ts → http-app.ts) — so the GitHub /
// viewer / dashboard routes still exist and 503/degrade when their bindings are
// unconfigured — but exports ONLY the GitLab review Workflow, NOT the Sandbox /
// AgentBudget Durable Object classes. index.ts owns those (container-coupled)
// re-exports; this entry stays free of any `@cloudflare/sandbox` /
// container-binding surface, which is exactly what the PoC's free-plan deploy
// shape (wrangler.poc.jsonc) can support.
//
// The `proxyToSandbox` preview-proxy that index.ts runs before the router is a
// container feature this deploy has no bindings for, so it is deliberately
// absent here — the PoC never boots a container.

import type { Env } from "./env";
import { handleRequest } from "./router";

// The GitLab MR-review Workflow (workflow-gitlab.ts) — the ONLY binding class
// this entry exports. Declared in wrangler.poc.jsonc's `workflows` block.
export { GitlabReviewWorkflow } from "./workflow-gitlab";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

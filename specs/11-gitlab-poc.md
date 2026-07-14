# 11 — GitLab MR-review PoC

A proof-of-concept that FlareDispatch's Worker-side code-review engine reviews a
**GitLab merge request** as readily as a GitHub pull request — by introducing a
provider-neutral source-control seam and backing it with a GitLab adapter, with
zero change to the review engine itself.

## Goal

On a GitLab `merge_request` webhook (open / reopen / update), fetch the MR's
diff over the GitLab API, run the existing multi-agent review (Workers AI via
the `modelGateway` capability — the binding is the auth, no model key), and post
the verdict as a merge-request note. All in a Worker; no container, no GitHub
App, no check-runs.

## Design — the `Scm` port (the modelGateway precedent)

The review engine (`@flare-dispatch/review-agent`) already calls its model
through a **capability**, `modelGateway`, whose interface names the capability,
not the provider (`env.AI` / Anthropic / Bedrock are *backends* selected by a
Layer). This PoC applies the exact same move to source control.

- **`Scm`** (`packages/core/src/services/scm.ts`) — a tiny, provider-blind port:
  - `ChangeRef = { project, number, headSha, baseSha }` — `project` is a
    `"owner/name"` slug OR a GitLab project id/path; the Layer interprets it.
  - `fetchDiff(ref) → string` and `postReview({ ref, body }) → void`.
  - `ScmError.reason` is a closed literal union (`auth-failed` / `not-found` /
    `rate-limited` / `bad-response` / `unknown`) — **no HTTP statuses**, exactly
    like `ModelGatewayError`. A backing Layer maps its provider's failures onto
    a reason; the run's error boundary renders it.
  - `Scm` joins `RunContext`, so a `defineRun` body can `yield* scm.fetchDiff`.
    `makeScmFake` mirrors `makeModelGatewayFake` (records calls, canned diff).

This is the neutral seam the phased upstream plan (below) generalises: the same
`Scm` Tag can be backed by a *GitHub* Layer, at which point `pr-review` and
`mr-review` are the same run over two providers.

## The pieces

| Layer | What |
| --- | --- |
| `packages/gitlab-app` | Token-auth GitLab REST — `fetchMergeRequestDiff` (paginated `/diffs`, assembled into one unified diff), `postMergeRequestNote`. `PRIVATE-TOKEN` auth; no App/install flow. |
| `packages/runtime-cf/src/scm-gitlab.ts` | `makeGitlabScmLive({ token, baseUrl? })` — backs `Scm` with gitlab-app; maps errors → `ScmError`; token-absent → degraded (fetch fails `auth-failed`, post no-ops). |
| `runs/mr-review.ts` | The run — a flat Effect over `Config | ModelGateway | Scm` reusing the review engine (`stripDiffNoise` → `capDiff` → `riskTier` → `reviewDomain` fan-out → `coordinate`). Reuses the `pr-review.*` config namespace. |
| `apps/dispatcher/src/routes/webhook-gitlab.ts` | `POST /v1/webhooks/gitlab` — constant-time `X-Gitlab-Token` verify, MR-event + action gating, stable-id dispatch to the review Workflow. |
| `apps/dispatcher/src/workflow-gitlab.ts` | `GitlabReviewWorkflow` — insert-execution / review / finalize (D1). Builds the 3-Layer stack and runs `mrReviewProgram`. |
| `apps/dispatcher/src/index.poc.ts` + `wrangler.poc.jsonc` | The free-plan deploy shape — Worker + D1 + KV + AI + the Workflow, nothing else. |

## Deliberately out of scope (this is a PoC)

- **No writeback / suggestions** — a single top-level note, not inline diff
  comments or committed fixes.
- **No check-run equivalent** — GitLab commit-status / MR approval is not posted;
  the verdict lives in the note.
- **No install flow** — a project access token, not an OAuth App.
- **No clone URL / container** — the diff comes from the API, so there is no
  `git checkout`, hence no oxlint grounding (that runs in a sandbox).
- **No `mr-review` oxlint self-review** and no cron/schedule surface.

## Free-plan trim (`wrangler.poc.jsonc`)

Copied from the root `wrangler.jsonc`, then stripped to: `d1_databases`
(RUNS_METADATA), `kv_namespaces` (CONFIG_KV; IDEMPOTENCY_KV commented like
upstream), `ai` (AI), `workflows` (GITLAB_REVIEW_WORKFLOW → GitlabReviewWorkflow),
`observability`. **Removed**: containers, durable_objects, migrations (no DO
class is exported), browser, crons/triggers, routes/custom domains, assets,
send_email, and the ACCESS_* / PUBLIC_ORIGIN / INBOX_DOMAIN / CLOUDFLARE_ACCOUNT_ID
/ ADMISSION_CAP vars. `VIEWER_ACCESS_MODE=token-only` (no Access app fronts the PoC).

## Provisioning runbook

```bash
CFG=apps/dispatcher/wrangler.poc.jsonc

# 1. D1 + apply the shared migrations.
wrangler d1 create flare-dispatch-gitlab-poc          # paste database_id into $CFG
wrangler d1 migrations apply RUNS_METADATA --remote --config $CFG

# 2. KV for config.
wrangler kv namespace create CONFIG_KV                # paste id into $CFG

# 3. Secrets.
wrangler secret put GITLAB_TOKEN --config $CFG          # project access token, scope: api
wrangler secret put GITLAB_WEBHOOK_SECRET --config $CFG # a long random string

# 4. Point the review at a model (shared pr-review.* namespace).
wrangler kv key put --binding CONFIG_KV pr-review.backend workers-ai --config $CFG
wrangler kv key put --binding CONFIG_KV pr-review.workers-ai.model "@cf/meta/llama-3.3-70b-instruct-fp8-fast" --config $CFG
# Optional: pr-review.agents=multi (tier-scaled personas; default single),
#           pr-review.workers-ai.mode=json (for reasoning models),
#           pr-review.guidelines="..." (house rules).

# 5. Deploy.
wrangler deploy --config $CFG
```

### GitLab side

1. **Project access token** — Project → Settings → Access Tokens → role
   `Developer` (or higher), scope **`api`**. This is `GITLAB_TOKEN`.
2. **Webhook** — Project → Settings → Webhooks → URL
   `https://<worker>.workers.dev/v1/webhooks/gitlab`, **Secret token** = the same
   value as `GITLAB_WEBHOOK_SECRET`, trigger **Merge request events**. Add SSL
   verification. GitLab sends `X-Gitlab-Token` = the secret; the route
   constant-time-compares it.

## Phased upstream outline

The PoC is intentionally shaped so upstreaming is incremental, each phase
independently valuable:

1. **Port in core** — land `Scm` + `makeScmFake` (the neutral seam). No behaviour
   change; `pr-review` still uses `github`.
2. **`gitlab-app` + `makeGitlabScmLive`** — the GitLab adapter, tested in
   isolation (this PoC).
3. **GitHub Layer migration** — add `makeGithubScmLive` (wrapping the existing
   github-app plumbing) so `Scm` has a GitHub backing too.
4. **Diff-source seam** — refactor `pr-review` to fetch its diff via `Scm`
   instead of a container `git diff` where a diff API suffices, collapsing
   `pr-review` and `mr-review` toward one run.
5. **Parity** — one review run over both providers; provider selection is a Layer
   choice at the webhook boundary, not a fork in the run.

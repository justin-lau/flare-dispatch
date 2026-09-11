// FlareDispatch Dispatcher — `POST /v1/webhooks/gitlab` (GitLab PoC).
//
// The GitLab sibling of routes/webhook.ts, deliberately self-contained: GitLab
// merge_request events fan out to ONE `GitlabReviewWorkflow` per (project, MR,
// head-sha). Unlike the GitHub route it does NOT go through the run registry /
// trigger-evaluation machinery — the PoC dispatches the single `mr-review`
// Workflow directly.
//
// --- Strict opt-in (byte-parity with the GitHub route's posture) -------------
//
// GitLab mode is OFF by default: a deploy without `GITLAB_WEBHOOK_SECRET`
// returns 503 rather than accepting unverified bodies.
//
// --- Verification ------------------------------------------------------------
//
// GitLab authenticates a webhook with a plain shared *secret token* echoed in
// the `X-Gitlab-Token` header (NOT an HMAC over the body, unlike GitHub). We
// compare it to `GITLAB_WEBHOOK_SECRET` in CONSTANT TIME (`constantTimeEqual`)
// so a `===` early-return can't leak the secret's length/prefix via timing.

import type { Env } from "../env";
import { toInstanceId } from "../instance-id";
import { mrInputsFromPayload } from "@flare-dispatch/runs/mr-review";
import { postMergeRequestNote } from "@flare-dispatch/gitlab-app";

/** GitLab's webhook secret-token header. */
const TOKEN_HEADER = "X-Gitlab-Token";
/** GitLab's event-kind header — MR events carry exactly this value. */
const EVENT_HEADER = "X-Gitlab-Event";
/** GitLab's per-delivery id header (for optional dedup). */
const EVENT_UUID_HEADER = "X-Gitlab-Event-UUID";
/** The one event kind this route handles. */
const MERGE_REQUEST_EVENT = "Merge Request Hook";
/** The MR actions that warrant a (re)review. */
const REVIEWABLE_ACTIONS = new Set(["open", "reopen", "update"]);
/** TTL on receiver-dedup KV entries (24h) — matches the GitHub route. */
const DEDUP_TTL_SEC = 86_400;
const THROTTLE_WINDOW_MS = 15 * 60 * 1000;
const THROTTLE_MAX = 3;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * A bodyless `204 No Content` acknowledgement (GitLab redelivers on a non-2xx,
 * so an ignored event must still ack). A 204 is a null-body status — a Response
 * constructed with a body + 204 THROWS — so it carries no JSON.
 */
const noContent = (): Response => new Response(null, { status: 204 });

/**
 * Constant-time string equality. Both inputs are HMAC-SHA256'd under a fresh
 * per-invocation random key, then the two fixed-length (32-byte) digests are
 * XOR-accumulated — so neither the comparison time NOR the digest length leaks
 * anything about the inputs' length or content. The double-HMAC construction is
 * the standard defence when a native constant-time `timingSafeEqual` isn't
 * available (workerd has no `node:crypto` `timingSafeEqual`). Exported for tests.
 */
export const constantTimeEqual = async (
  a: string,
  b: string,
): Promise<boolean> => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.sign("HMAC", key, enc.encode(a)),
    crypto.subtle.sign("HMAC", key, enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i]! ^ vb[i]!;
  return diff === 0;
};

/** The GitLab merge_request webhook payload slice this route reads. */
type GitlabMrPayload = {
  object_kind?: string;
  project?: { id?: number; web_url?: string };
  object_attributes?: {
    iid?: number;
    action?: string;
    source_branch?: string;
    target_branch?: string;
    last_commit?: { id?: string };
    oldrev?: string;
    diff_refs?: { base_sha?: string; head_sha?: string };
    labels?: Array<{ title?: string }>;
  };
};

/** Handle `POST /v1/webhooks/gitlab`. */
export const handleGitlabWebhook = async (
  request: Request,
  env: Env,
): Promise<Response> => {
  // 1. Opt-in: refuse if no webhook secret is provisioned. An empty / whitespace
  //    secret is treated as UNSET (never as a valid credential) — otherwise a
  //    blank env var would accept an empty X-Gitlab-Token.
  const secret = env.GITLAB_WEBHOOK_SECRET;
  if (secret === undefined || secret.trim().length === 0) {
    return json(
      {
        error: "webhook_not_configured",
        message: "GITLAB_WEBHOOK_SECRET is unset; GitLab mode is off on this deploy",
      },
      503,
    );
  }

  // 2. Constant-time verify X-Gitlab-Token against the secret.
  const token = request.headers.get(TOKEN_HEADER) ?? "";
  const ok = await constantTimeEqual(token, secret);
  if (!ok) {
    return json(
      { error: "unauthorized", message: "X-Gitlab-Token missing or invalid" },
      401,
    );
  }

  // 3. Only merge_request events; anything else is acknowledged + ignored.
  const event = request.headers.get(EVENT_HEADER);
  if (event !== MERGE_REQUEST_EVENT) {
    return noContent();
  }

  // 4. Parse the body and gate on object_kind + action.
  let payload: GitlabMrPayload;
  try {
    payload = (await request.json()) as GitlabMrPayload;
  } catch (cause) {
    return json(
      { error: "invalid_json", detail: cause instanceof Error ? cause.message : String(cause) },
      400,
    );
  }
  const action = payload.object_attributes?.action;
  if (payload.object_kind !== "merge_request" || action === undefined || !REVIEWABLE_ACTIONS.has(action)) {
    return noContent();
  }

  // 4b. Validate the identifiers BEFORE they are interpolated into a GitLab API
  //     URL. `project.id` + `iid` MUST be positive integers — a forged string
  //     (e.g. "../../projects/2/merge_requests/1") is rejected here (defence in
  //     depth over gitlab-app's own URL-encoding). 400: the token verified, so a
  //     malformed body is a client/config error, not a silent ignore.
  const projectId = Math.trunc(Number(payload.project?.id));
  const iid = Math.trunc(Number(payload.object_attributes?.iid));
  if (!Number.isInteger(projectId) || projectId <= 0 || !Number.isInteger(iid) || iid <= 0) {
    return json(
      { error: "invalid_payload", message: "project.id and object_attributes.iid must be positive integers" },
      400,
    );
  }
  const lb = payload.object_attributes?.labels;
  const ti = Array.isArray(lb) ? lb.map((l) => (l as { title?: unknown })?.title).filter((t): t is string => typeof t === "string") : [];
  if (ti.includes("skip-ai-review")) {
    return noContent();
  }
  const bypass = ti.includes("request-ai-review");
  // 5. Optional receiver-level dedup on the delivery UUID.
  const deliveryId = request.headers.get(EVENT_UUID_HEADER);
  if (deliveryId !== null && deliveryId.length > 0 && env.IDEMPOTENCY_KV !== undefined) {
    const key = `gl-delivery:${deliveryId}`;
    const seen = await env.IDEMPOTENCY_KV.get(key);
    if (seen !== null) {
      return json({ deduped: true, deliveryId }, 202);
    }
    await env.IDEMPOTENCY_KV.put(key, "1", { expirationTtl: DEDUP_TTL_SEC });
  }
  const tKey = `throttle:${projectId}:${iid}`;
  let tState: { starts: number[]; notedAt?: number } | null = null;
  if (!bypass && env.IDEMPOTENCY_KV !== undefined) {
    const now = Date.now();
    const st: { starts: number[]; notedAt?: number } = { starts: [] };
    const raw = await env.IDEMPOTENCY_KV.get(tKey);
    if (raw !== null) {
      try {
        const p = JSON.parse(raw) as { starts?: unknown; notedAt?: unknown };
        if (Array.isArray(p.starts)) st.starts = p.starts.filter((x): x is number => typeof x === "number");
        if (typeof p.notedAt === "number") st.notedAt = p.notedAt;
      } catch {}
    }
    st.starts = st.starts.filter((s) => now - s < THROTTLE_WINDOW_MS);
    if (st.starts.length >= THROTTLE_MAX) {
      const retryAt = st.starts[0]! + THROTTLE_WINDOW_MS;
      const retryAfterSec = Math.max(1, Math.ceil((retryAt - now) / 1000));
      if (st.notedAt === undefined || now - st.notedAt >= THROTTLE_WINDOW_MS) {
        const hhmm = new Date(retryAt).toISOString().slice(11, 16);
        const noteBody = `Review throttled: three reviews in the last 15 minutes. The next review runs after ${hhmm} UTC, or add the \`request-ai-review\` label.\n\n<!-- flare-dispatch: mr-review-throttle -->`;
        const tok = env.GITLAB_TOKEN;
        if (tok !== undefined && tok.trim().length > 0) {
          try {
            await postMergeRequestNote({ token: tok, projectId, iid, body: noteBody });
            // Only a delivered note suppresses the next one; a failed or skipped
            // post leaves notedAt unset so the next trigger retries the note.
            st.notedAt = now;
          } catch (e) {
            console.warn(`[webhook-gitlab] throttle note failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      await env.IDEMPOTENCY_KV.put(tKey, JSON.stringify(st), { expirationTtl: 900 });
      console.log(JSON.stringify({ event: "mr-review.throttled", projectId, iid, retryAfterSec }));
      return json({ status: "throttled", retryAfterSec }, 202);
    }
    tState = st;
  }
  // 6. The review Workflow must be bound to dispatch.
  if (env.GITLAB_REVIEW_WORKFLOW === undefined) {
    return json(
      {
        error: "workflow_not_configured",
        message: "GITLAB_REVIEW_WORKFLOW binding is absent on this deploy",
      },
      503,
    );
  }

  // 7. Extract the run inputs (mrInputsFromPayload is the run's canonical
  //    mapping — prefers diff_refs endpoints). Override projectId/iid with the
  //    VALIDATED integers above (mrInputsFromPayload coerces; these are checked).
  //    Add source/target branch context.
  const input = {
    ...mrInputsFromPayload(payload),
    projectId: String(projectId),
    iid,
    ...(payload.object_attributes?.source_branch !== undefined
      ? { sourceBranch: payload.object_attributes.source_branch }
      : {}),
    ...(payload.object_attributes?.target_branch !== undefined
      ? { targetBranch: payload.object_attributes.target_branch }
      : {}),
  };

  // 8. Dispatch — a stable id collapses redeliveries at the platform layer.
  // The semantic key MUST pass through toInstanceId: CF Workflows accepts only
  // [A-Za-z0-9_-] (≤64 chars) — a raw `:`-joined key fails instance.invalid_id.
  const id = toInstanceId(`mr-review:${input.projectId}:${input.iid}:${input.headSha.slice(0, 12)}`);
  let duplicated = false;
  try {
    await env.GITLAB_REVIEW_WORKFLOW.create({ id, params: { executionId: id, input } });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // A duplicate create IS the dedup path — treat it as accepted.
    if (!/already.?exists|duplicate/i.test(message)) {
      console.error(`[webhook-gitlab] create failed id="${id}": ${message}`);
      return json({ error: "dispatch_failed", detail: message }, 500);
    }
    duplicated = true;
  }
  if (!duplicated && tState !== null && env.IDEMPOTENCY_KV !== undefined) {
    tState.starts.push(Date.now());
    await env.IDEMPOTENCY_KV.put(tKey, JSON.stringify(tState), { expirationTtl: 900 });
  }
  return json({ accepted: true, executionId: id, action }, 202);
};

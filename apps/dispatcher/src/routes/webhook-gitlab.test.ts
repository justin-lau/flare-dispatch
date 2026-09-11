// FlareDispatch Dispatcher — `POST /v1/webhooks/gitlab` acceptance tests.
//
// Drives `handleGitlabWebhook` via the router with a hand-built `Request` + fake
// `Env`. Mirrors the GitHub webhook test contract, adapted to GitLab:
//   no secret configured → 503;
//   bad X-Gitlab-Token → 401;
//   non-MR event → 204 ignore;
//   gated (non-reviewable) action → 204 ignore;
//   open action + valid token → 202, one Workflow.create;
//   duplicate delivery UUID → 202 deduped, no second create.
// Plus a unit test for the constant-time compare helper.

import { describe, expect, it } from "vitest";
import { handleRequest } from "../router";
import { constantTimeEqual } from "./webhook-gitlab";
import { makeFakeEnv, makeFakeKv, makeFakeR2, makeFakeWorkflow } from "../test-helpers";
import type { Env } from "../env";

const WEBHOOK_SECRET = "gitlab-webhook-secret-please-rotate";

const mrPayload = (action = "open") => ({
  object_kind: "merge_request",
  project: { id: 42, web_url: "https://gitlab.com/group/proj" },
  object_attributes: {
    iid: 7,
    action,
    source_branch: "feature",
    target_branch: "main",
    last_commit: { id: "commitsha1234567890" },
    diff_refs: { base_sha: "basesha", head_sha: "headsha1234567890" },
  },
});

const gitlabRequest = (
  payload: unknown,
  opts: { token?: string; event?: string; deliveryId?: string } = {},
): Request => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Gitlab-Event": opts.event ?? "Merge Request Hook",
  };
  if (opts.token !== undefined) headers["X-Gitlab-Token"] = opts.token;
  if (opts.deliveryId !== undefined) headers["X-Gitlab-Event-UUID"] = opts.deliveryId;
  return new Request("https://dispatcher.example/v1/webhooks/gitlab", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
};

const fixture = (opts: { withSecret?: boolean; withWorkflow?: boolean; withKv?: boolean } = {}) => {
  const reviewWorkflow = makeFakeWorkflow();
  const idempotencyKv = opts.withKv ? makeFakeKv() : undefined;
  const env: Env = makeFakeEnv({
    hmacSecret: "unused",
    workflow: makeFakeWorkflow(),
    storage: makeFakeR2(),
    idempotencyKv: idempotencyKv?.binding,
    ...(opts.withSecret === false ? {} : { gitlabWebhookSecret: WEBHOOK_SECRET }),
    ...(opts.withWorkflow === false ? {} : { gitlabReviewWorkflow: reviewWorkflow.binding }),
  });
  return { env, reviewWorkflow, idempotencyKv };
};

describe("POST /v1/webhooks/gitlab", () => {
  it("no webhook secret configured → 503", async () => {
    const { env, reviewWorkflow } = fixture({ withSecret: false });
    const res = await handleRequest(gitlabRequest(mrPayload(), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(503);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("empty/whitespace webhook secret is treated as unconfigured → 503", async () => {
    const reviewWorkflow = makeFakeWorkflow();
    const env: Env = makeFakeEnv({
      hmacSecret: "unused",
      workflow: makeFakeWorkflow(),
      storage: makeFakeR2(),
      gitlabWebhookSecret: "   ",
      gitlabReviewWorkflow: reviewWorkflow.binding,
    });
    const res = await handleRequest(gitlabRequest(mrPayload(), { token: "   " }), env);
    expect(res.status).toBe(503);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("forged non-integer iid → 400, no dispatch", async () => {
    const { env, reviewWorkflow } = fixture();
    const forged = {
      object_kind: "merge_request",
      project: { id: 1, web_url: "https://gitlab.com/g/p" },
      object_attributes: {
        iid: "../../projects/2/merge_requests/1",
        action: "open",
        last_commit: { id: "sha" },
        diff_refs: { base_sha: "b", head_sha: "h" },
      },
    };
    const res = await handleRequest(gitlabRequest(forged, { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(400);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("non-positive project.id → 400, no dispatch", async () => {
    const { env, reviewWorkflow } = fixture();
    const bad = {
      object_kind: "merge_request",
      project: { id: 0, web_url: "https://gitlab.com/g/p" },
      object_attributes: { iid: 7, action: "open", last_commit: { id: "sha" }, diff_refs: { base_sha: "b", head_sha: "h" } },
    };
    const res = await handleRequest(gitlabRequest(bad, { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(400);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("bad X-Gitlab-Token → 401", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(gitlabRequest(mrPayload(), { token: "wrong" }), env);
    expect(res.status).toBe(401);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("missing token → 401", async () => {
    const { env } = fixture();
    const res = await handleRequest(gitlabRequest(mrPayload()), env);
    expect(res.status).toBe(401);
  });

  it("non-merge_request event → 204 ignore", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(
      gitlabRequest(mrPayload(), { token: WEBHOOK_SECRET, event: "Note Hook" }),
      env,
    );
    expect(res.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("non-reviewable action (close) → 204 ignore", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(
      gitlabRequest(mrPayload("close"), { token: WEBHOOK_SECRET }),
      env,
    );
    expect(res.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("open action + valid token → 202, one Workflow.create with the extracted input", async () => {
    const { env, reviewWorkflow } = fixture();
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
    const call = reviewWorkflow.calls[0]!;
    // The semantic key is sanitized by toInstanceId — CF Workflows rejects ":".
    expect(call.id).toBe("mr-review_42_7_headsha12345");
    const params = call.params as { executionId: string; input: Record<string, unknown> };
    expect(params.input).toMatchObject({
      projectId: "42",
      iid: 7,
      headSha: "headsha1234567890",
      baseSha: "basesha",
      projectWebUrl: "https://gitlab.com/group/proj",
      sourceBranch: "feature",
      targetBranch: "main",
    });
  });

  it("workflow binding absent → 503", async () => {
    const { env, reviewWorkflow } = fixture({ withWorkflow: false });
    const res = await handleRequest(gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(503);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });

  it("duplicate delivery UUID → 202 deduped, no second create", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const uuid = "delivery-uuid-1";
    const first = await handleRequest(
      gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET, deliveryId: uuid }),
      env,
    );
    expect(first.status).toBe(202);
    expect(reviewWorkflow.calls).toHaveLength(1);
    const second = await handleRequest(
      gitlabRequest(mrPayload("open"), { token: WEBHOOK_SECRET, deliveryId: uuid }),
      env,
    );
    expect(second.status).toBe(202);
    // No SECOND dispatch — the redelivery short-circuited on the KV entry.
    expect(reviewWorkflow.calls).toHaveLength(1);
  });
});

describe("constantTimeEqual", () => {
  it("is true for equal strings, false otherwise (incl. different lengths)", async () => {
    expect(await constantTimeEqual("secret", "secret")).toBe(true);
    expect(await constantTimeEqual("secret", "secreT")).toBe(false);
    expect(await constantTimeEqual("secret", "secret-longer")).toBe(false);
    expect(await constantTimeEqual("", "")).toBe(true);
  });
});
describe("mr-review labels + throttle", () => {
  const withHead = (head: string, labels?: Array<{ title: string }>) => ({
    object_kind: "merge_request",
    project: { id: 42, web_url: "https://gitlab.com/group/proj" },
    object_attributes: { iid: 7, action: "open", source_branch: "feature", target_branch: "main", last_commit: { id: head }, diff_refs: { base_sha: "basesha", head_sha: head }, ...(labels !== undefined ? { labels } : {}) },
  });
  const tok = (env: Env) => { (env as unknown as Record<string, unknown>).GITLAB_TOKEN = "tok"; };
  const stub = (notes: string[]) => {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, init?: { body?: unknown }) => {
      if (String(u).includes("/notes")) { notes.push(String(init?.body ?? "")); return new Response("{}", { status: 201 }); }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    return prev;
  };
  it("4th throttles one note; 5th no second note", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    tok(env);
    const notes: string[] = [];
    const prev = stub(notes);
    try {
      const shas = ["aaaa111111111111", "bbbb222222222222", "cccc333333333333", "dddd444444444444"];
      for (let i = 0; i < 3; i++) await handleRequest(gitlabRequest(withHead(shas[i]!), { token: WEBHOOK_SECRET, deliveryId: `a${i}` }), env);
      expect(reviewWorkflow.calls).toHaveLength(3);
      const f = await handleRequest(gitlabRequest(withHead(shas[3]!), { token: WEBHOOK_SECRET, deliveryId: "a3" }), env);
      expect(f.status).toBe(202);
      expect(await f.json()).toMatchObject({ status: "throttled" });
      expect(reviewWorkflow.calls).toHaveLength(3);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain("<!-- flare-dispatch: mr-review-throttle -->");
      const g = await handleRequest(gitlabRequest(withHead("eeee555555555555"), { token: WEBHOOK_SECRET, deliveryId: "a4" }), env);
      expect(await g.json()).toMatchObject({ status: "throttled" });
      expect(notes).toHaveLength(1);
    } finally { globalThis.fetch = prev; }
  });
  it("request-ai-review bypasses", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    tok(env);
    const prev = stub([]);
    try {
      for (const [i, s] of ["aaaa111111111111", "bbbb222222222222", "cccc333333333333"].entries()) await handleRequest(gitlabRequest(withHead(s), { token: WEBHOOK_SECRET, deliveryId: `b${i}` }), env);
      const r = await handleRequest(gitlabRequest(withHead("dddd444444444444", [{ title: "request-ai-review" }]), { token: WEBHOOK_SECRET, deliveryId: "b3" }), env);
      expect(await r.json()).toMatchObject({ accepted: true });
      expect(reviewWorkflow.calls).toHaveLength(4);
    } finally { globalThis.fetch = prev; }
  });
  it("skip-ai-review 204", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const r = await handleRequest(gitlabRequest(withHead("ffff666666666666", [{ title: "skip-ai-review" }]), { token: WEBHOOK_SECRET, deliveryId: "s1" }), env);
    expect(r.status).toBe(204);
    expect(reviewWorkflow.calls).toHaveLength(0);
  });
  it("no KV no throttle", async () => {
    const { env, reviewWorkflow } = fixture();
    for (const [i, s] of ["aaaa111111111111", "bbbb222222222222", "cccc333333333333", "dddd444444444444"].entries()) await handleRequest(gitlabRequest(withHead(s), { token: WEBHOOK_SECRET, deliveryId: `n${i}` }), env);
    expect(reviewWorkflow.calls).toHaveLength(4);
  });
  it("null JSON body → 400 invalid_payload", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const res = await handleRequest(gitlabRequest(null, { token: WEBHOOK_SECRET }), env);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_payload" });
    expect(reviewWorkflow.calls).toHaveLength(0);
  });
  it("future starts do not throttle", async () => {
    const { env, reviewWorkflow } = fixture({ withKv: true });
    const future = Date.now() + 60 * 60 * 1000;
    await env.IDEMPOTENCY_KV!.put(`throttle:42:7`, JSON.stringify({ starts: [future] }), { expirationTtl: 900 });
    const res = await handleRequest(gitlabRequest(withHead("ffff666666666666"), { token: WEBHOOK_SECRET, deliveryId: "f1" }), env);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(reviewWorkflow.calls).toHaveLength(1);
  });
});

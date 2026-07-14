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
    expect(call.id).toBe("mr-review:42:7:headsha12345");
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

// Unit tests for the shared GitLab REST plumbing.

import { describe, expect, it } from "vitest";
import { assertOk, encodeProjectId, glHeaders } from "./http";
import { GitlabApiError } from "./errors";

describe("encodeProjectId", () => {
  it("passes a numeric id through", () => {
    expect(encodeProjectId(42)).toBe("42");
  });
  it("percent-encodes a group/project path (incl. the slash)", () => {
    expect(encodeProjectId("group/sub/project")).toBe("group%2Fsub%2Fproject");
  });
});

describe("glHeaders", () => {
  it("uses PRIVATE-TOKEN (not Authorization) and no Content-Type by default", () => {
    const h = glHeaders("glpat-abc");
    expect(h["PRIVATE-TOKEN"]).toBe("glpat-abc");
    expect(h.Authorization).toBeUndefined();
    expect(h["Content-Type"]).toBeUndefined();
  });
  it("adds Content-Type: application/json for a JSON body", () => {
    expect(glHeaders("t", { json: true })["Content-Type"]).toBe("application/json");
  });
});

describe("assertOk", () => {
  it("throws GitlabApiError carrying status + body on non-2xx", async () => {
    const res = new Response("nope", { status: 403 });
    await expect(assertOk(res, "boom")).rejects.toBeInstanceOf(GitlabApiError);
    const res2 = new Response("nope", { status: 403 });
    await expect(assertOk(res2, "boom")).rejects.toMatchObject({ status: 403, body: "nope" });
  });
  it("is a no-op on a 2xx", async () => {
    await expect(assertOk(new Response("ok", { status: 200 }), "x")).resolves.toBeUndefined();
  });
});

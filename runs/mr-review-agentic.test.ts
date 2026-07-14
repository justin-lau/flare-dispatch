// Tests for the agentic mr-review loop: the serializable turn functions
// (init / runAgenticTurn / finalize) and the in-Effect driver. The model loop is
// driven by the scripted `makeModelGatewayFake`; the hakiri tool calls hit an
// msw-mocked MCP endpoint (the same `{result:{content:[{text}]}}` envelope the
// grounding suite uses).

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Effect, Layer } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Config, ModelGateway, ModelGatewayError } from "@flare-dispatch/core";
import {
  makeConfigFake,
  makeModelGatewayFake,
  type ModelGatewayFakeState,
  makeScmFake,
} from "@flare-dispatch/core/testing";
import {
  type AgenticState,
  finalizeAgentic,
  initAgenticReview,
  MAX_TURNS,
  runAgenticReview,
  runAgenticTurn,
} from "./mr-review-agentic";
import type { MrReviewInput } from "./mr-review";

const ENDPOINT = "https://hakiri.test";

const INPUT: MrReviewInput = {
  projectId: "1",
  iid: 2,
  headSha: "abc123",
  baseSha: "def456",
  projectWebUrl: "https://gitlab.test/g/p",
};

const SAMPLE_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,2 +1,3 @@",
  " const x = 1;",
  "+export const run = () => helper(x);",
].join("\n");

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Wrap a `{columns,rows}` table in the MCP tool-call envelope. */
const envelope = (table: unknown) =>
  HttpResponse.json({ result: { content: [{ text: JSON.stringify(table) }] } });

/** A default agentic state (retrieval configured) for direct turn tests. */
const baseState = (o: Partial<AgenticState> = {}): AgenticState => ({
  messages: [
    { role: "system", content: "sys" },
    { role: "user", content: "Review domain: general\n\nUnified diff:\n(diff)" },
  ],
  turn: 0,
  cost: { inputTokens: 0, outputTokens: 0 },
  done: false,
  model: "openrouter/x",
  backend: "openrouter",
  maxTokens: 4096,
  tier: "lite",
  retrieval: { endpoint: ENDPOINT },
  toolCallCount: 0,
  ...o,
});

const runTurn = (
  state: AgenticState,
  fake: { layer: Layer.Layer<ModelGateway> },
  // A turn re-reads the hakiri token from Config — provide a fake (default empty).
  config: Layer.Layer<Config> = makeConfigFake({}),
): Promise<AgenticState> =>
  Effect.runPromise(
    runAgenticTurn(state).pipe(Effect.provide(Layer.mergeAll(fake.layer, config))),
  );

// A scripted model response calling hakiri_search / submit_review.
const searchCall = (query: string, usage?: { inputTokens: number; outputTokens: number }) => ({
  toolCalls: [{ name: "hakiri_search", arguments: { query } }],
  text: "",
  ...(usage ?? {}),
});
const submitCall = (
  findings: ReadonlyArray<unknown>,
  usage?: { inputTokens: number; outputTokens: number },
) => ({
  toolCalls: [{ name: "submit_review", arguments: { findings } }],
  text: "",
  ...(usage ?? {}),
});

// ---------------------------------------------------------------------------

describe("initAgenticReview", () => {
  it("builds the system + first user turn, computes the tier, resolves retrieval + model", async () => {
    const config = makeConfigFake({
      "pr-review.backend": "openrouter",
      "pr-review.openrouter.model": "openrouter/deepseek/deepseek-v4-pro",
      "pr-review.hakiri.endpoint": ENDPOINT,
      "pr-review.hakiri.token": "secret",
    });
    const scm = makeScmFake({ diff: SAMPLE_DIFF });
    const state = await Effect.runPromise(
      initAgenticReview(INPUT).pipe(Effect.provide(Layer.mergeAll(config, scm.layer))),
    );

    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]?.role).toBe("system");
    expect(state.messages[0]?.content).toContain("AGENTIC");
    expect(state.messages[1]?.role).toBe("user");
    // Same renderDomainBody shape the single-shot reviewer uses (single "general" domain).
    expect(state.messages[1]?.content).toContain("Review domain: general");
    expect(state.messages[1]?.content).toContain(SAMPLE_DIFF);
    expect(state.done).toBe(false);
    expect(state.turn).toBe(0);
    // ONLY the endpoint is carried — the bearer token must never enter the state.
    expect(state.retrieval).toEqual({ endpoint: ENDPOINT });
    expect(state.model).toBe("openrouter/deepseek/deepseek-v4-pro");
    // fetchDiff was called with the MR ref.
    expect(scm.state.fetchDiffCalls[0]).toMatchObject({ project: "1", number: 2 });
  });

  it("never persists the hakiri bearer token in the serialized state (init or turn returns)", async () => {
    const TOKEN = "super-secret-bearer-xyz";
    const config = makeConfigFake({
      "pr-review.backend": "openrouter",
      "pr-review.openrouter.model": "openrouter/m",
      "pr-review.hakiri.endpoint": ENDPOINT,
      "pr-review.hakiri.token": TOKEN,
    });
    const scm = makeScmFake({ diff: SAMPLE_DIFF });

    // init state carries no token.
    const initState = await Effect.runPromise(
      initAgenticReview(INPUT).pipe(Effect.provide(Layer.mergeAll(config, scm.layer))),
    );
    expect(JSON.stringify(initState)).not.toContain(TOKEN);

    // A turn that actually reaches hakiri (with the token in Config) still returns
    // state with no token — even though it USED the token to authenticate.
    let seenAuth = "";
    server.use(
      http.post(`${ENDPOINT}/mcp`, ({ request }) => {
        seenAuth = request.headers.get("authorization") ?? "";
        return envelope({ columns: ["path", "snippet"], rows: [["a", "b"]] });
      }),
    );
    const withPendingCall: AgenticState = {
      ...initState,
      messages: [
        ...initState.messages,
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "hakiri_search", arguments: { query: "q" } }] },
      ],
    };
    const fake = makeModelGatewayFake({ responses: [submitCall([])] });
    const turnState = await runTurn(withPendingCall, fake, config);

    // The token WAS used (auth header sent) but is absent from the returned state.
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(turnState)).not.toContain(TOKEN);
  });

  it("leaves retrieval undefined when no hakiri endpoint is configured", async () => {
    const config = makeConfigFake({
      "pr-review.backend": "openrouter",
      "pr-review.openrouter.model": "openrouter/m",
    });
    const scm = makeScmFake();
    const state = await Effect.runPromise(
      initAgenticReview(INPUT).pipe(Effect.provide(Layer.mergeAll(config, scm.layer))),
    );
    expect(state.retrieval).toBeUndefined();
    expect(state.done).toBe(false);
  });

  it("clamps the agentic diff below the backend cap (Workflow step-return budget)", async () => {
    // openrouter's backend cap is 240k; the agentic ceiling is 150k. A 240k diff
    // must be clamped so the diff — re-returned by every durable turn step — stays
    // under the ~1 MiB step-return budget.
    const bigDiff =
      "diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1 +1 @@\n" +
      "+// padding line\n".repeat(16_000);
    const config = makeConfigFake({
      "pr-review.backend": "openrouter",
      "pr-review.openrouter.model": "openrouter/m",
    });
    const scm = makeScmFake({ diff: bigDiff });
    const state = await Effect.runPromise(
      initAgenticReview(INPUT).pipe(Effect.provide(Layer.mergeAll(config, scm.layer))),
    );
    expect(bigDiff.length).toBeGreaterThan(200_000);
    // The user turn carries the diff — clamped near 150k, well under the raw length.
    const userContent = state.messages[1]?.content ?? "";
    expect(userContent.length).toBeLessThanOrEqual(155_000);
    expect(userContent.length).toBeGreaterThan(120_000);
  });

  it("records a terminal error when the backend is unconfigured (never throws)", async () => {
    const config = makeConfigFake({});
    const scm = makeScmFake();
    const state = await Effect.runPromise(
      initAgenticReview(INPUT).pipe(Effect.provide(Layer.mergeAll(config, scm.layer))),
    );
    expect(state.done).toBe(true);
    expect(state.error?.rateLimited).toBe(false);
    expect(state.error?.message).toContain("misconfigured");
  });
});

describe("runAgenticTurn", () => {
  it("threads the previous turn's tool result into the next turn's request, sums cost, ends on submit", async () => {
    server.use(
      http.post(`${ENDPOINT}/mcp`, () =>
        envelope({ columns: ["path", "snippet"], rows: [["src/foo.ts", "the helper snippet body"]] }),
      ),
    );
    const fake = makeModelGatewayFake({
      responses: [
        searchCall("helper", { inputTokens: 100, outputTokens: 20 }),
        submitCall([], { inputTokens: 50, outputTokens: 10 }),
      ],
    });

    let state = baseState();
    state = await runTurn(state, fake); // turn 0 → model asks to search
    expect(state.done).toBe(false);
    expect(state.turn).toBe(1);
    // The assistant turn recorded the tool call with a synthesized id.
    const asst = state.messages[state.messages.length - 1];
    expect(asst?.role).toBe("assistant");
    expect(asst?.toolCalls?.[0]?.id).toBe("call_0_0");

    state = await runTurn(state, fake); // turn 1 → executes search, then submits
    expect(state.done).toBe(true);
    expect(state.findings).toEqual([]);

    // Turn 1's request carries turn 0's tool result, paired by toolCallId.
    const req2 = (fake.state as ModelGatewayFakeState).requests[1];
    const toolMsg = req2?.messages?.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe("call_0_0");
    expect(toolMsg?.name).toBe("hakiri_search");
    expect(toolMsg?.content).toContain("the helper snippet body");

    // Cost summed across both turns; one retrieval call executed.
    expect(state.cost).toEqual({ inputTokens: 150, outputTokens: 30 });
    expect(state.toolCallCount).toBe(1);
  });

  it("a tool-execution HTTP failure yields an error tool result — never fails the Effect", async () => {
    server.use(http.post(`${ENDPOINT}/mcp`, () => new HttpResponse(null, { status: 500 })));
    const fake = makeModelGatewayFake({
      responses: [searchCall("x"), submitCall([])],
    });
    let state = baseState();
    state = await runTurn(state, fake); // search call
    state = await runTurn(state, fake); // execute → 500 → error result, then submit

    expect(state.done).toBe(true);
    const toolMsg = (fake.state as ModelGatewayFakeState).requests[1]?.messages?.find(
      (m) => m.role === "tool",
    );
    expect(toolMsg?.content).toContain("error");
  });

  it("caps executed tool calls per turn — the 5th gets a consolidate error result", async () => {
    server.use(
      http.post(`${ENDPOINT}/mcp`, () => envelope({ columns: ["path", "snippet"], rows: [["a", "b"]] })),
    );
    const fiveCalls = Array.from({ length: 5 }, (_, i) => ({
      name: "hakiri_search",
      arguments: { query: `q${i}` },
      id: `c${i}`,
    }));
    const state = baseState({
      turn: 1,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "u" },
        { role: "assistant", content: "", toolCalls: fiveCalls },
      ],
    });
    const fake = makeModelGatewayFake({ responses: [submitCall([])] });

    const next = await runTurn(state, fake);
    const toolMsgs =
      (fake.state as ModelGatewayFakeState).requests[0]?.messages?.filter((m) => m.role === "tool") ??
      [];
    expect(toolMsgs).toHaveLength(5);
    expect(toolMsgs[4]?.content).toContain("too many tool calls");
    expect(next.toolCallCount).toBe(4);
  });

  it("with no retrieval endpoint, offers only submit_review", async () => {
    const fake = makeModelGatewayFake({ responses: [submitCall([])] });
    const next = await runTurn(baseState({ retrieval: undefined }), fake);
    const req = (fake.state as ModelGatewayFakeState).requests[0];
    expect(req?.tools?.map((t) => t.name)).toEqual(["submit_review"]);
    expect(next.done).toBe(true);
  });

  it("offers the retrieval tools + submit_review on a normal turn", async () => {
    const fake = makeModelGatewayFake({ responses: [submitCall([])] });
    await runTurn(baseState(), fake);
    const req = (fake.state as ModelGatewayFakeState).requests[0];
    expect(req?.tools?.map((t) => t.name)).toEqual([
      "hakiri_search",
      "hakiri_query",
      "submit_review",
    ]);
  });

  it("terminates when a json-mode model emits the findings object as text", async () => {
    const fake = makeModelGatewayFake({
      responses: [
        {
          toolCalls: [],
          text: JSON.stringify({
            findings: [
              { path: "a.ts", startLine: 1, endLine: 1, level: "warning", title: "t", message: "m" },
            ],
          }),
        },
      ],
    });
    const next = await runTurn(baseState({ retrieval: undefined }), fake);
    expect(next.done).toBe(true);
    expect(next.findings).toHaveLength(1);
  });

  it("ends the loop as a rate-limited error (→ skipped-quota) on a rate-limited model failure", async () => {
    const fake = makeModelGatewayFake({
      responses: [new ModelGatewayError({ model: "m", reason: "rate-limited", message: "429" })],
    });
    const next = await runTurn(baseState(), fake);
    expect(next.done).toBe(true);
    expect(next.error?.rateLimited).toBe(true);
  });

  it("bounds the returned state: evicts the OLDEST tool results, keeps the newest + the diff/user turn", async () => {
    const BIG = "z".repeat(400_000);
    const state = baseState({
      retrieval: undefined, // only submit_review offered; last msg is a tool result → no pending exec
      turn: 2,
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "THE-DIFF" },
        { role: "assistant", content: "", toolCalls: [{ id: "a0", name: "hakiri_search", arguments: {} }] },
        { role: "tool", content: BIG, toolCallId: "a0", name: "hakiri_search" }, // OLD → evictable
        { role: "assistant", content: "", toolCalls: [{ id: "a1", name: "hakiri_search", arguments: {} }] },
        { role: "tool", content: BIG, toolCallId: "a1", name: "hakiri_search" }, // NEWEST → protected
      ],
    });
    const fake = makeModelGatewayFake({ responses: [submitCall([])] });

    const next = await runTurn(state, fake);
    const msgs = next.messages;
    expect(msgs[3]?.content).toBe("[tool result dropped to bound workflow state size]");
    expect(msgs[5]?.content).toBe(BIG); // newest turn's result preserved
    expect(msgs[1]?.content).toBe("THE-DIFF"); // diff/user turn never touched
    expect(JSON.stringify(next.messages).length).toBeLessThanOrEqual(700_000);
  });
});

describe("runAgenticReview (full loop)", () => {
  it("forces submit on the final turn: only submit_review + a nudge, and finalize fails without a verdict", async () => {
    server.use(
      http.post(`${ENDPOINT}/mcp`, () => envelope({ columns: ["path", "snippet"], rows: [["a", "b"]] })),
    );
    // A model that NEVER submits — always asks to search.
    const fake = makeModelGatewayFake({ responses: [searchCall("x")] }); // last repeats
    const config = makeConfigFake({
      "pr-review.backend": "openrouter",
      "pr-review.openrouter.model": "openrouter/m",
      "pr-review.hakiri.endpoint": ENDPOINT,
    });
    const scm = makeScmFake({ diff: SAMPLE_DIFF });

    const result = await Effect.runPromise(
      runAgenticReview(INPUT).pipe(
        Effect.provide(Layer.mergeAll(fake.layer, config, scm.layer)),
      ),
    );

    // Exactly MAX_TURNS model calls (the loop cap).
    const reqs = (fake.state as ModelGatewayFakeState).requests;
    expect(reqs).toHaveLength(MAX_TURNS);
    // The final turn offered only submit_review and appended the nudge.
    const lastReq = reqs[MAX_TURNS - 1];
    expect(lastReq?.tools?.map((t) => t.name)).toEqual(["submit_review"]);
    expect(
      lastReq?.messages?.some((m) => m.role === "user" && m.content.includes("No more retrieval")),
    ).toBe(true);

    expect(result.status).toBe("failure");
    expect(result.noteBody).toContain("did not submit a verdict");
  });

  it("submits a verdict and finalizes to a success note with the agentic meta line", async () => {
    server.use(
      http.post(`${ENDPOINT}/mcp`, () =>
        envelope({ columns: ["path", "content"], rows: [["src/foo.ts", "export const helper = () => 1;"]] }),
      ),
    );
    const fake = makeModelGatewayFake({
      responses: [
        searchCall("helper", { inputTokens: 200, outputTokens: 40 }),
        submitCall(
          [{ path: "src/foo.ts", startLine: 6, endLine: 6, level: "warning", title: "T", message: "M" }],
          { inputTokens: 120, outputTokens: 25 },
        ),
      ],
    });
    const config = makeConfigFake({
      "pr-review.backend": "openrouter",
      "pr-review.openrouter.model": "openrouter/m",
      "pr-review.hakiri.endpoint": ENDPOINT,
    });
    const scm = makeScmFake({ diff: SAMPLE_DIFF });

    const result = await Effect.runPromise(
      runAgenticReview(INPUT).pipe(Effect.provide(Layer.mergeAll(fake.layer, config, scm.layer))),
    );

    expect(result.status).toBe("success");
    expect(result.output?.verdict).toBe("comment");
    expect(result.grounded).toBe(true);
    expect(result.usage).toEqual({ inputTokens: 320, outputTokens: 65 });
    expect(result.noteBody).toContain("agentic");
    expect(result.noteBody).toContain("2 turn(s)");
    expect(result.noteBody).toContain("1 retrieval call(s)");
  });
});

describe("finalizeAgentic", () => {
  it("renders a success note with the agentic meta line + retrieval-call count", () => {
    const state = baseState({
      done: true,
      turn: 3,
      toolCallCount: 2,
      cost: { inputTokens: 100, outputTokens: 20 },
      findings: [{ path: "a.ts", startLine: 1, endLine: 2, level: "warning", title: "T", message: "M" }],
    });
    const r = finalizeAgentic(INPUT, state);
    expect(r.status).toBe("success");
    expect(r.output?.verdict).toBe("comment");
    expect(r.noteBody).toContain("agentic");
    expect(r.noteBody).toContain("3 turn(s)");
    expect(r.noteBody).toContain("2 retrieval call(s)");
    expect(r.grounded).toBe(true);
  });

  it("notes 'no retrieval endpoint' when retrieval was not configured", () => {
    const state = baseState({
      retrieval: undefined,
      done: true,
      turn: 1,
      toolCallCount: 0,
      cost: { inputTokens: 10, outputTokens: 2 },
      findings: [],
    });
    const r = finalizeAgentic(INPUT, state);
    expect(r.noteBody).toContain("no retrieval endpoint");
    expect(r.grounded).toBe(false);
  });

  it("degrades to skipped-quota (posts nothing) but STILL reports the tokens earlier turns billed", () => {
    const state = baseState({
      done: true,
      cost: { inputTokens: 300, outputTokens: 60 },
      error: { rateLimited: true, message: "rate" },
    });
    const r = finalizeAgentic(INPUT, state);
    expect(r.status).toBe("skipped-quota");
    expect(r.noteBody).toBeNull();
    expect(r.output).toBeNull();
    // Real spend on the completed turns is preserved for the D1 row.
    expect(r.usage).toEqual({ inputTokens: 300, outputTokens: 60 });
  });

  it("renders a failure note on a non-rate error and reports the billed tokens", () => {
    const state = baseState({
      done: true,
      cost: { inputTokens: 120, outputTokens: 30 },
      error: { rateLimited: false, message: "boom" },
    });
    const r = finalizeAgentic(INPUT, state);
    expect(r.status).toBe("failure");
    expect(r.noteBody).toContain("boom");
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });
});

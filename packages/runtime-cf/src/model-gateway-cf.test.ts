// ModelGatewayLive tests — the Workers AI binding mapping.
//
// Stubs the `AiBinding` with a plain object that records the `run` call and
// returns canned `AiTextGenerationOutput`, then asserts the Layer maps it onto
// the `ModelGateway` contract: messages built from system+user, tools forwarded
// in the Workers-AI shape, gateway id passed through, and tool_calls / response
// mapped to `{ toolCalls, text }`. A thrown `run` → `ModelGatewayError`.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  type ModelCompletionRequest,
  modelGateway,
} from "@flare-dispatch/core";
import { type AiBinding, makeModelGatewayLive } from "./model-gateway-cf";

/** A recording `Ai` stub returning a fixed output. */
const stubAi = (
  output: {
    response?: string;
    tool_calls?: Array<{ name: string; arguments: unknown }>;
    // The chat-completion shape some catalog models (glm-*) return INSTEAD of a
    // top-level `response` — `choices[0].message.{content, tool_calls}`.
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          name?: string;
          arguments?: unknown;
          function?: { name?: string; arguments?: unknown };
        }>;
      };
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  },
): {
  ai: AiBinding;
  seen: { model?: string; inputs?: unknown; options?: unknown };
} => {
  const seen: { model?: string; inputs?: unknown; options?: unknown } = {};
  const ai: AiBinding = {
    run: (model, inputs, options) => {
      seen.model = model;
      seen.inputs = inputs;
      seen.options = options;
      return Promise.resolve(output);
    },
  };
  return { ai, seen };
};

const run = (
  ai: AiBinding,
  gatewayId: string | undefined,
  req: ModelCompletionRequest,
) =>
  Effect.runPromise(
    modelGateway
      .complete(req)
      .pipe(Effect.provide(makeModelGatewayLive(ai, gatewayId))),
  );

describe("makeModelGatewayLive", () => {
  it("maps a tool_calls response (object arguments) to toolCalls", async () => {
    const { ai, seen } = stubAi({
      tool_calls: [{ name: "report", arguments: { findings: [] } }],
    });
    const result = await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "you are a reviewer",
      user: "review this",
      maxTokens: 2048,
      tools: [
        { name: "report", description: "d", parameters: { type: "object" } },
      ],
    });

    expect(result.toolCalls).toEqual([
      { name: "report", arguments: { findings: [] } },
    ]);
    expect(result.text).toBe("");

    // The model id passes through verbatim (bare @cf/...).
    expect(seen.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    // Workers AI chat templates drop the system message when tools are present
    // — on the tools path the system instruction is folded into the user turn.
    expect((seen.inputs as { messages: unknown }).messages).toEqual([
      { role: "user", content: "you are a reviewer\n\nreview this" },
    ]);
    // tools are forwarded in the Workers-AI function-tool shape.
    expect((seen.inputs as { tools: unknown }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "report",
          description: "d",
          parameters: { type: "object" },
        },
      },
    ]);
    expect((seen.inputs as { max_tokens: number }).max_tokens).toBe(2048);
    // No gateway id → no options.
    expect(seen.options).toBeUndefined();
  });

  it("maps a text response to `text` and sends no tools in json mode", async () => {
    const { ai, seen } = stubAi({ response: "hello world" });
    const result = await run(ai, undefined, {
      model: "m",
      system: "s",
      user: "u",
    });
    expect(result.text).toBe("hello world");
    expect(result.toolCalls).toEqual([]);
    expect("tools" in (seen.inputs as object)).toBe(false);
    // No tools → the template honours the system role; keep it separate.
    expect((seen.inputs as { messages: unknown }).messages).toEqual([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]);
  });

  it("passes the AI Gateway id through as { gateway: { id } }", async () => {
    const { ai, seen } = stubAi({ response: "ok" });
    await run(ai, "numu-staging", { model: "m", system: "s", user: "u" });
    expect(seen.options).toEqual({ gateway: { id: "numu-staging" } });
  });

  it("forwards a jsonSchema as response_format (constrained decoding)", async () => {
    const { ai, seen } = stubAi({ response: '{"findings":[]}' });
    await run(ai, "g", {
      model: "@cf/zai-org/glm-5.2",
      system: "s",
      user: "u",
      jsonSchema: { type: "object", properties: { findings: {} } },
    });
    expect((seen.inputs as Record<string, unknown>).response_format).toEqual({
      type: "json_schema",
      json_schema: { type: "object", properties: { findings: {} } },
    });
  });

  it("omits response_format when no jsonSchema is set", async () => {
    const { ai, seen } = stubAi({ response: "ok" });
    await run(ai, "g", { model: "m", system: "s", user: "u" });
    expect(
      "response_format" in (seen.inputs as Record<string, unknown>),
    ).toBe(false);
  });

  it("fails ModelGatewayError when the binding throws", async () => {
    const ai: AiBinding = {
      run: () => Promise.reject(new Error("429 Too Many Requests")),
    };
    const exit = await Effect.runPromiseExit(
      modelGateway
        .complete({ model: "m", system: "s", user: "u" })
        .pipe(Effect.provide(makeModelGatewayLive(ai, undefined))),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("coerces a non-string `response` (some catalog models return parsed objects) to JSON text", async () => {
    // Some Workers AI models occasionally return `response` as a parsed
    // object instead of a string. Without coercion here, the downstream
    // engine's parseStructured fires `StructuredOutputInvalid: got object`
    // — a generic-sounding error that obscures the cause. The route must
    // hand parseStructured a string so it has something concrete to
    // JSON.parse + Schema-decode.
    const { ai } = stubAi({
      response: { findings: [] } as unknown as string,
    });
    const result = await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "s",
      user: "u",
    });
    expect(typeof result.text).toBe("string");
    expect(result.text).toBe('{"findings":[]}');
    expect(result.toolCalls).toEqual([]);
  });

  it("coerces a missing `response` to empty string (back-compat)", async () => {
    const { ai } = stubAi({});
    const result = await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "s",
      user: "u",
    });
    expect(result.text).toBe("");
  });

  it("surfaces the Workers AI usage block as inputTokens/outputTokens", async () => {
    const { ai } = stubAi({
      response: "ok",
      usage: { prompt_tokens: 14_230, completion_tokens: 1_872 },
    });
    const result = await run(ai, undefined, {
      model: "@cf/qwen/qwen2.5-coder-32b-instruct",
      system: "s",
      user: "u",
    });
    expect(result.inputTokens).toBe(14_230);
    expect(result.outputTokens).toBe(1_872);
  });

  it("leaves token fields unset when the model reports no usage (back-compat)", async () => {
    const { ai } = stubAi({ response: "ok" });
    const result = await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "s",
      user: "u",
    });
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  it("reads the chat-completion `choices[].message.content` when there is no top-level `response` (the glm shape)", async () => {
    // glm-4.7-flash returns ONLY the chat-completion shape — `choices[0].message
    // .content` with NO top-level `response`. Reading `response` alone dropped
    // its answer to "" → `StructuredOutputInvalid: empty` on every reviewer.
    // Confirmed against the live Workers AI API: glm has no `response` field,
    // llama has both. The route must read `content` as the fallback.
    const { ai } = stubAi({
      choices: [{ message: { content: '{"findings":[]}' } }],
    });
    const result = await run(ai, undefined, {
      model: "@cf/zai-org/glm-4.7-flash",
      system: "s",
      user: "u",
    });
    expect(result.text).toBe('{"findings":[]}');
    expect(result.toolCalls).toEqual([]);
  });

  it("reads chat-completion tool calls (OpenAI `function`-nested) from `choices`", async () => {
    const { ai } = stubAi({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { function: { name: "report", arguments: '{"findings":[]}' } },
            ],
          },
        },
      ],
    });
    const result = await run(ai, undefined, {
      model: "@cf/zai-org/glm-4.7-flash",
      system: "s",
      user: "u",
      tools: [{ name: "report", description: "d", parameters: { type: "object" } }],
    });
    expect(result.toolCalls).toEqual([
      { name: "report", arguments: '{"findings":[]}' },
    ]);
  });

  it("prefers the legacy top-level `response` when both shapes are present (llama)", async () => {
    // llama-3.3 returns BOTH `response` and `choices`; the legacy field wins so
    // existing behaviour is byte-identical.
    const { ai } = stubAi({
      response: "legacy text",
      choices: [{ message: { content: "choices text" } }],
    });
    const result = await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "s",
      user: "u",
    });
    expect(result.text).toBe("legacy text");
  });
});

// ---------------------------------------------------------------------------
// The anthropic/* universal route.

/** A recording gateway stub returning a fixed Anthropic Messages response. */
const stubGatewayAi = (
  body: unknown,
  status = 200,
): {
  ai: AiBinding;
  seen: { gatewayId?: string; request?: Record<string, unknown> };
} => {
  const seen: { gatewayId?: string; request?: Record<string, unknown> } = {};
  const ai: AiBinding = {
    run: () => Promise.reject(new Error("workers-ai route must not be used")),
    gateway: (gatewayId) => {
      seen.gatewayId = gatewayId;
      return {
        run: (data) => {
          seen.request = data as unknown as Record<string, unknown>;
          return Promise.resolve(
            new Response(JSON.stringify(body), { status }),
          );
        },
      };
    },
  };
  return { ai, seen };
};

describe("makeModelGatewayLive — anthropic universal route", () => {
  it("routes anthropic/* through gateway.run and maps tool_use blocks", async () => {
    const { ai, seen } = stubGatewayAi({
      content: [
        { type: "text", text: "thinking…" },
        { type: "tool_use", name: "report", input: { findings: [] } },
      ],
    });
    const result = await run(ai, "my-gateway", {
      model: "anthropic/claude-sonnet-4-6",
      system: "you are a reviewer",
      user: "review this",
      maxTokens: 1024,
      tools: [
        { name: "report", description: "d", parameters: { type: "object" } },
      ],
    });

    expect(result.toolCalls).toEqual([
      { name: "report", arguments: { findings: [] } },
    ]);
    expect(result.text).toBe("thinking…");

    expect(seen.gatewayId).toBe("my-gateway");
    expect(seen.request?.provider).toBe("anthropic");
    expect(seen.request?.endpoint).toBe("v1/messages");
    // Anthropic rejects a Messages call without its API version pin.
    expect(
      (seen.request!.headers as Record<string, string>)["anthropic-version"],
    ).toBe("2023-06-01");
    const query = seen.request?.query as Record<string, unknown>;
    // The `anthropic/` prefix is stripped — the provider gets its own naming.
    expect(query.model).toBe("claude-sonnet-4-6");
    expect(query.system).toBe("you are a reviewer");
    expect(query.messages).toEqual([{ role: "user", content: "review this" }]);
    expect(query.max_tokens).toBe(1024);
    // Tools map to Anthropic's input_schema shape with forced tool use.
    expect(query.tools).toEqual([
      { name: "report", description: "d", input_schema: { type: "object" } },
    ]);
    expect(query.tool_choice).toEqual({ type: "any" });
  });

  it("concatenates text blocks when no tools are sent (json mode)", async () => {
    const { ai, seen } = stubGatewayAi({
      content: [
        { type: "text", text: '{"findings"' },
        { type: "text", text: ":[]}" },
      ],
    });
    const result = await run(ai, "g", {
      model: "anthropic/claude-haiku-4-5",
      system: "s",
      user: "u",
    });
    expect(result.text).toBe('{"findings":[]}');
    expect(result.toolCalls).toEqual([]);
    const query = seen.request?.query as Record<string, unknown>;
    expect("tools" in query).toBe(false);
    // Anthropic requires max_tokens — defaulted when the caller didn't set one.
    expect(query.max_tokens).toBe(2048);
  });

  it("maps a non-2xx provider response to ModelGatewayError by status", async () => {
    const { ai } = stubGatewayAi({ error: { message: "overloaded" } }, 429);
    const exit = await Effect.runPromiseExit(
      modelGateway
        .complete({ model: "anthropic/claude-sonnet-4-6", system: "s", user: "u" })
        .pipe(Effect.provide(makeModelGatewayLive(ai, "g"))),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails with an operator-facing error when no gateway id is configured", async () => {
    const { ai } = stubGatewayAi({ content: [] });
    const exit = await Effect.runPromiseExit(
      modelGateway
        .complete({ model: "anthropic/claude-sonnet-4-6", system: "s", user: "u" })
        .pipe(Effect.provide(makeModelGatewayLive(ai, undefined))),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("forwards cf-aig-authorization when an auth token is set (authenticated gateway)", async () => {
    const { ai, seen } = stubGatewayAi({ content: [{ type: "text", text: "ok" }] });
    await Effect.runPromise(
      modelGateway
        .complete({ model: "anthropic/claude-sonnet-4-6", system: "s", user: "u" })
        .pipe(
          Effect.provide(makeModelGatewayLive(ai, "g", undefined, "tok_abc")),
        ),
    );
    expect(
      (seen.request!.headers as Record<string, string>)["cf-aig-authorization"],
    ).toBe("Bearer tok_abc");
  });

  it("omits cf-aig-authorization when no auth token is configured", async () => {
    const { ai, seen } = stubGatewayAi({ content: [{ type: "text", text: "ok" }] });
    await run(ai, "g", {
      model: "anthropic/claude-sonnet-4-6",
      system: "s",
      user: "u",
    });
    expect(
      "cf-aig-authorization" in (seen.request!.headers as Record<string, string>),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The deepseek/* universal route (OpenAI-compatible chat/completions).

describe("makeModelGatewayLive — deepseek universal route", () => {
  it("routes deepseek/* through gateway.run as OpenAI chat/completions and maps content → text", async () => {
    const { ai, seen } = stubGatewayAi({
      choices: [{ message: { content: '{"findings":[]}' } }],
      usage: { prompt_tokens: 321, completion_tokens: 12 },
    });
    const result = await run(ai, "my-gateway", {
      model: "deepseek/deepseek-reasoner",
      system: "you are a reviewer",
      user: "review this",
      maxTokens: 1024,
    });

    // json-mode (reasoning models): answer comes back as `text`, no tool calls.
    expect(result.text).toBe('{"findings":[]}');
    expect(result.toolCalls).toEqual([]);
    // usage maps onto the token fields.
    expect(result.inputTokens).toBe(321);
    expect(result.outputTokens).toBe(12);

    expect(seen.gatewayId).toBe("my-gateway");
    expect(seen.request?.provider).toBe("deepseek");
    expect(seen.request?.endpoint).toBe("chat/completions");
    const query = seen.request?.query as Record<string, unknown>;
    // The `deepseek/` prefix is stripped — the provider gets its own naming.
    expect(query.model).toBe("deepseek-reasoner");
    expect(query.max_tokens).toBe(1024);
    // OpenAI wire shape: system + user as `messages`, no top-level `system`.
    expect(query.messages).toEqual([
      { role: "system", content: "you are a reviewer" },
      { role: "user", content: "review this" },
    ]);
    // No tools sent in json mode.
    expect("tools" in query).toBe(false);
  });

  it("sets response_format json_object when a jsonSchema is present (no tools)", async () => {
    const { ai, seen } = stubGatewayAi({
      choices: [{ message: { content: '{"findings":[]}' } }],
    });
    await Effect.runPromise(
      modelGateway
        .complete({
          model: "deepseek/deepseek-reasoner",
          system: "s",
          user: "u",
          jsonSchema: { type: "object" },
        })
        .pipe(Effect.provide(makeModelGatewayLive(ai, "g"))),
    );
    const query = seen.request?.query as Record<string, unknown>;
    expect(query.response_format).toEqual({ type: "json_object" });
  });

  it("maps OpenAI tool_calls (JSON-string arguments) to toolCalls and defaults max_tokens", async () => {
    const { ai, seen } = stubGatewayAi({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                type: "function",
                function: { name: "report", arguments: '{"findings":[]}' },
              },
            ],
          },
        },
      ],
    });
    const result = await run(ai, "g", {
      model: "deepseek/deepseek-chat",
      system: "s",
      user: "u",
      tools: [
        { name: "report", description: "d", parameters: { type: "object" } },
      ],
    });

    // Arguments pass through verbatim as a JSON string — the engine parses it.
    expect(result.toolCalls).toEqual([
      { name: "report", arguments: '{"findings":[]}' },
    ]);
    // content === null → empty text (not the literal "null").
    expect(result.text).toBe("");
    const query = seen.request?.query as Record<string, unknown>;
    // Tools map to the OpenAI function-tool shape with forced tool use.
    expect(query.tools).toEqual([
      {
        type: "function",
        function: {
          name: "report",
          description: "d",
          parameters: { type: "object" },
        },
      },
    ]);
    expect(query.tool_choice).toBe("required");
    // DeepSeek accepts max_tokens — defaulted when the caller didn't set one.
    expect(query.max_tokens).toBe(2048);
  });

  it("maps a non-2xx provider response to ModelGatewayError by status", async () => {
    const { ai } = stubGatewayAi({ error: { message: "rate limited" } }, 429);
    const exit = await Effect.runPromiseExit(
      modelGateway
        .complete({ model: "deepseek/deepseek-reasoner", system: "s", user: "u" })
        .pipe(Effect.provide(makeModelGatewayLive(ai, "g"))),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails with an operator-facing error when no gateway id is configured", async () => {
    const { ai } = stubGatewayAi({ choices: [] });
    const exit = await Effect.runPromiseExit(
      modelGateway
        .complete({ model: "deepseek/deepseek-reasoner", system: "s", user: "u" })
        .pipe(Effect.provide(makeModelGatewayLive(ai, undefined))),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("forwards cf-aig-authorization when an auth token is set (authenticated gateway)", async () => {
    const { ai, seen } = stubGatewayAi({
      choices: [{ message: { content: "ok" } }],
    });
    await Effect.runPromise(
      modelGateway
        .complete({ model: "deepseek/deepseek-reasoner", system: "s", user: "u" })
        .pipe(
          Effect.provide(makeModelGatewayLive(ai, "g", undefined, "tok_xyz")),
        ),
    );
    expect(
      (seen.request!.headers as Record<string, string>)["cf-aig-authorization"],
    ).toBe("Bearer tok_xyz");
  });
});

// --- The Bedrock-via-AI-Gateway route ---------------------------------------

describe("makeModelGatewayLive — bedrock-via-AI-Gateway route", () => {
  /** A `fetch` stub that records the URL + headers + body and returns canned JSON. */
  const stubFetch = (
    payload: { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } } = {
      content: [{ type: "text", text: "review body" }],
      usage: { input_tokens: 100, output_tokens: 50 },
    },
  ): {
    fetchImpl: typeof fetch;
    seen: { url?: string; headers?: Record<string, string>; body?: string };
  } => {
    const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = init.headers as Record<string, string>;
      seen.body = init.body as string;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  };

  // Smuggle the fetch stub into the Bedrock route by monkey-patching globalThis.fetch
  // for the duration of one test. The shared helper defaults to the global fetch.
  const withFetch = async <T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl;
    try {
      return await fn();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = original;
    }
  };

  // Cast through unknown — the AiBinding stub doesn't matter on the bedrock route
  // (it's bypassed entirely), but the Layer factory still needs a value.
  const inertAi = ({} as unknown) as AiBinding;

  const awsCreds = {
    accessKeyId: "AKIA-TEST",
    secretAccessKey: "secret-test",
    sessionToken: "session-token-test",
    region: "us-east-1",
  };

  it("routes through the AI Gateway Bedrock URL with the AWS hostname signed", async () => {
    const { fetchImpl, seen } = stubFetch();
    const result = await withFetch(fetchImpl, () =>
      Effect.runPromise(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "you are a reviewer",
            user: "review this",
            aws: awsCreds,
          })
          .pipe(Effect.provide(makeModelGatewayLive(inertAi, "g", "acct123"))),
      ),
    );

    // URL pinned to the AI Gateway forwarder
    expect(seen.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/g/aws-bedrock/bedrock-runtime/us-east-1/model/us.anthropic.claude-opus-4-6-v1/invoke",
    );
    // SigV4 signs against the AWS hostname (host header), not the gateway
    expect(seen.headers!.host).toBe("bedrock-runtime.us-east-1.amazonaws.com");
    expect(seen.headers!.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA-TEST/);
    // x-amz-security-token forwards the STS session token
    expect(seen.headers!["x-amz-security-token"]).toBe("session-token-test");
    // Body shape is Anthropic-on-Bedrock with the version pin
    const body = JSON.parse(seen.body!) as {
      anthropic_version: string;
      system: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.system).toBe("you are a reviewer");
    expect(body.messages).toEqual([{ role: "user", content: "review this" }]);

    // Response mapped to {text, toolCalls:[], inputTokens, outputTokens}
    expect(result.text).toBe("review body");
    expect(result.toolCalls).toEqual([]);
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it("forwards cf-aig-authorization when an auth token is configured", async () => {
    const { fetchImpl, seen } = stubFetch();
    await withFetch(fetchImpl, () =>
      Effect.runPromise(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "s",
            user: "u",
            aws: awsCreds,
          })
          .pipe(
            Effect.provide(
              makeModelGatewayLive(inertAi, "g", "acct123", "secret-bearer"),
            ),
          ),
      ),
    );
    expect(seen.headers!["cf-aig-authorization"]).toBe("Bearer secret-bearer");
  });

  it("fails with an operator-facing error when req.aws is missing", async () => {
    const { fetchImpl } = stubFetch();
    const exit = await withFetch(fetchImpl, () =>
      Effect.runPromiseExit(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "s",
            user: "u",
          })
          .pipe(Effect.provide(makeModelGatewayLive(inertAi, "g", "acct123"))),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails when CLOUDFLARE_ACCOUNT_ID is not configured", async () => {
    const { fetchImpl } = stubFetch();
    const exit = await withFetch(fetchImpl, () =>
      Effect.runPromiseExit(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "s",
            user: "u",
            aws: awsCreds,
          })
          .pipe(Effect.provide(makeModelGatewayLive(inertAi, "g", undefined))),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("fails when AI_GATEWAY_ID is not configured", async () => {
    const { fetchImpl } = stubFetch();
    const exit = await withFetch(fetchImpl, () =>
      Effect.runPromiseExit(
        modelGateway
          .complete({
            model: "bedrock/us.anthropic.claude-opus-4-6-v1",
            system: "s",
            user: "u",
            aws: awsCreds,
          })
          .pipe(Effect.provide(makeModelGatewayLive(inertAi, undefined, "acct123"))),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});

// --- The OpenRouter direct route --------------------------------------------

describe("makeModelGatewayLive — openrouter direct route", () => {
  /** A `fetch` stub recording url/headers/body, returning a canned OpenAI response. */
  const stubFetch = (
    payload: unknown,
    status = 200,
  ): {
    fetchImpl: typeof fetch;
    seen: { url?: string; headers?: Record<string, string>; body?: string };
  } => {
    const seen: { url?: string; headers?: Record<string, string>; body?: string } = {};
    const fetchImpl = ((url: string, init: RequestInit) => {
      seen.url = url;
      seen.headers = init.headers as Record<string, string>;
      seen.body = init.body as string;
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    return { fetchImpl, seen };
  };

  const withFetch = async <T>(fetchImpl: typeof fetch, fn: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl;
    try {
      return await fn();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = original;
    }
  };

  const inertAi = {} as unknown as AiBinding;
  // The OPENROUTER_API_KEY is the 6th positional arg (after usageSink).
  const withKey = (key: string | undefined) =>
    makeModelGatewayLive(inertAi, undefined, undefined, undefined, undefined, key);

  it("POSTs OpenRouter with the bearer key, strips the prefix, maps content + cost + reasoning", async () => {
    const { fetchImpl, seen } = stubFetch({
      choices: [{ message: { content: '{"findings":[]}' } }],
      usage: {
        prompt_tokens: 9000,
        completion_tokens: 1200,
        cost: 0.00533,
        completion_tokens_details: { reasoning_tokens: 512 },
      },
    });
    const result = await withFetch(fetchImpl, () =>
      Effect.runPromise(
        modelGateway
          .complete({
            model: "openrouter/deepseek/deepseek-v4-pro",
            system: "you are a reviewer",
            user: "review this",
            jsonSchema: { type: "object" },
            maxTokens: 4096,
          })
          .pipe(Effect.provide(withKey("sk-or-secret"))),
      ),
    );

    // content → text; usage → tokens; OpenRouter extras → costUsd + reasoningTokens.
    expect(result.text).toBe('{"findings":[]}');
    expect(result.toolCalls).toEqual([]);
    expect(result.inputTokens).toBe(9000);
    expect(result.outputTokens).toBe(1200);
    expect(result.costUsd).toBe(0.00533);
    expect(result.reasoningTokens).toBe(512);

    // Direct endpoint, bearer auth (key present in the header, never logged elsewhere).
    expect(seen.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(seen.headers?.authorization).toBe("Bearer sk-or-secret");
    const body = JSON.parse(seen.body!) as Record<string, unknown>;
    // The `openrouter/` prefix is stripped — OpenRouter gets `deepseek/deepseek-v4-pro`.
    expect(body.model).toBe("deepseek/deepseek-v4-pro");
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([
      { role: "system", content: "you are a reviewer" },
      { role: "user", content: "review this" },
    ]);
    // json/prompt mode — response_format set, NO tools sent.
    expect(body.response_format).toEqual({ type: "json_object" });
    expect("tools" in body).toBe(false);
    // usage accounting opted in (so cost + reasoning come back).
    expect(body.usage).toEqual({ include: true });
  });

  it("fails auth-failed when OPENROUTER_API_KEY is absent (never reaches the network)", async () => {
    let called = false;
    const fetchImpl = (() => {
      called = true;
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as unknown as typeof fetch;
    const exit = await withFetch(fetchImpl, () =>
      Effect.runPromiseExit(
        modelGateway
          .complete({ model: "openrouter/deepseek/deepseek-v4-pro", system: "s", user: "u" })
          .pipe(Effect.provide(withKey(undefined))),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(called).toBe(false);
  });

  it("maps a non-2xx OpenRouter response to ModelGatewayError by status", async () => {
    const { fetchImpl } = stubFetch({ error: { message: "insufficient credits" } }, 402);
    const exit = await withFetch(fetchImpl, () =>
      Effect.runPromiseExit(
        modelGateway
          .complete({ model: "openrouter/deepseek/deepseek-v4-pro", system: "s", user: "u" })
          .pipe(Effect.provide(withKey("sk-or-secret"))),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });

  // --- Agentic multi-turn (messages transcript + tools) --------------------

  it("maps an agentic transcript + tools faithfully (messages precedence, wire tool_calls, tool role, tool_choice auto)", async () => {
    const { fetchImpl, seen } = stubFetch({
      choices: [{ message: { content: "", tool_calls: [] } }],
    });
    await withFetch(fetchImpl, () =>
      Effect.runPromise(
        modelGateway
          .complete({
            model: "openrouter/deepseek/deepseek-v4-pro",
            // system/user are IGNORED when messages is present.
            system: "ignored",
            user: "ignored",
            jsonSchema: { type: "object" },
            messages: [
              { role: "system", content: "you are a reviewer" },
              { role: "user", content: "review this diff" },
              {
                role: "assistant",
                content: "",
                toolCalls: [
                  { id: "call_abc", name: "hakiri_search", arguments: { query: "helper" } },
                ],
              },
              {
                role: "tool",
                toolCallId: "call_abc",
                name: "hakiri_search",
                content: "search result text",
              },
            ],
            tools: [
              { name: "hakiri_search", description: "search", parameters: { type: "object" } },
              { name: "submit_review", description: "submit", parameters: { type: "object" } },
            ],
            maxTokens: 4096,
          })
          .pipe(Effect.provide(withKey("sk-or-secret"))),
      ),
    );

    const body = JSON.parse(seen.body!) as Record<string, unknown>;
    // messages take precedence over system/user, mapped to the OpenAI wire shape —
    // assistant tool_calls carry the id + stringified arguments; the tool result
    // pairs back by tool_call_id.
    expect(body.messages).toEqual([
      { role: "system", content: "you are a reviewer" },
      { role: "user", content: "review this diff" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_abc",
            type: "function",
            function: { name: "hakiri_search", arguments: '{"query":"helper"}' },
          },
        ],
      },
      { role: "tool", content: "search result text", tool_call_id: "call_abc", name: "hakiri_search" },
    ]);
    // tools forwarded in the OpenAI function shape; the model is free to choose.
    expect(body.tools).toEqual([
      { type: "function", function: { name: "hakiri_search", description: "search", parameters: { type: "object" } } },
      { type: "function", function: { name: "submit_review", description: "submit", parameters: { type: "object" } } },
    ]);
    expect(body.tool_choice).toBe("auto");
    // response_format is suppressed while tools are offered (mutually exclusive).
    expect("response_format" in body).toBe(false);
    // usage accounting still opted in.
    expect(body.usage).toEqual({ include: true });
  });

  it("preserves the provider tool-call id on the result (for transcript pairing)", async () => {
    const { fetchImpl } = stubFetch({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_xyz", type: "function", function: { name: "submit_review", arguments: '{"findings":[]}' } },
            ],
          },
        },
      ],
    });
    const result = await withFetch(fetchImpl, () =>
      Effect.runPromise(
        modelGateway
          .complete({ model: "openrouter/x", system: "s", user: "u" })
          .pipe(Effect.provide(withKey("k"))),
      ),
    );
    expect(result.toolCalls).toEqual([
      { name: "submit_review", arguments: '{"findings":[]}', id: "call_xyz" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Agentic multi-turn transcript on the Workers AI route.

describe("makeModelGatewayLive — agentic transcript (workers-ai)", () => {
  it("maps a transcript through ai.run and folds system into the first user turn when tools are present", async () => {
    const { ai, seen } = stubAi({ response: "", tool_calls: [] });
    await run(ai, undefined, {
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      system: "unused",
      user: "unused",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "hakiri_search", arguments: { query: "q" } }],
        },
        { role: "tool", toolCallId: "c1", name: "hakiri_search", content: "RESULT" },
      ],
      tools: [{ name: "submit_review", description: "d", parameters: { type: "object" } }],
    });

    // The Workers AI tools quirk (system dropped when tools present) applies to
    // the transcript path: system is folded into the first user turn.
    expect((seen.inputs as { messages: unknown }).messages).toEqual([
      { role: "user", content: "SYS\n\nUSER" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "hakiri_search", arguments: '{"query":"q"}' } },
        ],
      },
      { role: "tool", content: "RESULT", tool_call_id: "c1", name: "hakiri_search" },
    ]);
    // tools forwarded in the Workers AI function shape.
    expect((seen.inputs as { tools: unknown }).tools).toEqual([
      { type: "function", function: { name: "submit_review", description: "d", parameters: { type: "object" } } },
    ]);
  });

  it("keeps the system role verbatim on a transcript with no tools", async () => {
    const { ai, seen } = stubAi({ response: '{"findings":[]}' });
    await run(ai, undefined, {
      model: "m",
      system: "unused",
      user: "unused",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
    });
    expect((seen.inputs as { messages: unknown }).messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
  });
});

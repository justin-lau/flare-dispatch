// Backend-selection unit tests — the operator config contract.
//
// `resolveBackend` reads a `config.get`-shaped accessor; here we back it with a
// plain in-memory map so the selection logic is tested without the DSL. No API
// key is read — the Workers AI binding (the `modelGateway` backend) is the auth.
//
// Backends name a model ROUTE, not an agentic tool: `workers-ai` | `anthropic` |
// `bedrock`. The former `opencode` / `reasonix` labels were misnomers (nothing
// spawned those tools) and are GONE — a reasoning model is just `workers-ai`
// with `mode: "json"`. The legacy-name regression guard below pins that.

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  BACKEND_KEYS,
  DEFAULT_BACKEND,
  backendConfigKey,
  namespacedKey,
  namespacedKeys,
  parseBackend,
  parseMaxDiffChars,
  parseMaxTokens,
  parseMode,
  promptKey,
  resolveBackend,
} from "./backend.js";

/** A `config.get`-shaped accessor over a plain map. */
const getter =
  (store: Record<string, string>) =>
  (key: string): Effect.Effect<string | undefined> =>
    Effect.succeed(store[key]);

describe("parseBackend", () => {
  it("passes through known backends", () => {
    expect(parseBackend("workers-ai")).toBe("workers-ai");
    expect(parseBackend("anthropic")).toBe("anthropic");
    expect(parseBackend("bedrock")).toBe("bedrock");
    expect(parseBackend("openrouter")).toBe("openrouter");
  });
  it("falls back to the default for unknown / unset", () => {
    expect(parseBackend(undefined)).toBe(DEFAULT_BACKEND);
    expect(parseBackend("openai")).toBe(DEFAULT_BACKEND);
  });
  it("does NOT recognize the retired opencode/reasonix labels (hard rename)", () => {
    // These were never agentic tools — only model-route misnomers. Post-rename
    // they are unknown values and fall back to the default; they do not alias.
    expect(parseBackend("opencode")).toBe(DEFAULT_BACKEND);
    expect(parseBackend("reasonix")).toBe(DEFAULT_BACKEND);
  });
});

describe("parseMode", () => {
  it("passes through known modes", () => {
    expect(parseMode("tools", "json")).toBe("tools");
    expect(parseMode("json", "tools")).toBe("json");
  });
  it("falls back to the supplied default for unknown / unset", () => {
    expect(parseMode(undefined, "json")).toBe("json");
    expect(parseMode("structured", "tools")).toBe("tools");
  });
});

describe("parseMaxDiffChars", () => {
  it("parses a positive integer override", () => {
    expect(parseMaxDiffChars("100000", 60_000)).toBe(100_000);
  });
  it("falls back on unset / blank / non-numeric / non-positive", () => {
    expect(parseMaxDiffChars(undefined, 60_000)).toBe(60_000);
    expect(parseMaxDiffChars("  ", 60_000)).toBe(60_000);
    expect(parseMaxDiffChars("100k", 60_000)).toBe(60_000);
    expect(parseMaxDiffChars("1.5", 60_000)).toBe(60_000);
    expect(parseMaxDiffChars("0", 60_000)).toBe(60_000);
    expect(parseMaxDiffChars("-5", 60_000)).toBe(60_000);
  });
  it("clamps to [1_000, 1_000_000]", () => {
    expect(parseMaxDiffChars("500", 60_000)).toBe(1_000);
    expect(parseMaxDiffChars("9999999", 60_000)).toBe(1_000_000);
  });
});

describe("parseMaxTokens", () => {
  it("parses a positive integer override", () => {
    expect(parseMaxTokens("16000", 8_192)).toBe(16_000);
  });
  it("falls back on unset / blank / non-numeric / non-positive", () => {
    expect(parseMaxTokens(undefined, 8_192)).toBe(8_192);
    expect(parseMaxTokens("8k", 8_192)).toBe(8_192);
    expect(parseMaxTokens("0", 8_192)).toBe(8_192);
  });
  it("clamps to [256, 32_768]", () => {
    expect(parseMaxTokens("10", 8_192)).toBe(256);
    expect(parseMaxTokens("99999", 8_192)).toBe(32_768);
  });
});

describe("resolveBackend", () => {
  it("resolves the default backend (workers-ai) from config — no API key", async () => {
    const store = {
      [BACKEND_KEYS["workers-ai"].modelKey]:
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("workers-ai");
    expect(resolved.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    // workers-ai defaults to the tool-calling path.
    expect(resolved.mode).toBe("tools");
    // Catalog models get a catalog-context-sized diff cap.
    expect(resolved.maxDiffChars).toBe(60_000);
  });

  it("honours a CONFIG_KV maxDiffChars override (big-context catalog model)", async () => {
    const store = {
      [BACKEND_KEYS["workers-ai"].modelKey]: "@cf/zai-org/glm-5.2",
      [BACKEND_KEYS["workers-ai"].maxDiffCharsKey]: "100000",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.maxDiffChars).toBe(100_000);
  });

  it("resolves the default token budget and honours a maxTokens override", async () => {
    const base = {
      [BACKEND_KEYS["workers-ai"].modelKey]: "@cf/zai-org/glm-5.2",
    };
    const def = await Effect.runPromise(resolveBackend(getter(base)));
    // workers-ai default — reasoning headroom.
    expect(def.maxTokens).toBe(8_192);

    const overridden = await Effect.runPromise(
      resolveBackend(
        getter({ ...base, [BACKEND_KEYS["workers-ai"].maxTokensKey]: "16000" }),
      ),
    );
    expect(overridden.maxTokens).toBe(16_000);
  });

  it("resolves a reasoning model (workers-ai + mode=json, @cf distill)", async () => {
    const store = {
      [BACKEND_KEYS["workers-ai"].modelKey]:
        "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      [BACKEND_KEYS["workers-ai"].modeKey]: "json",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("workers-ai");
    expect(resolved.model).toBe(
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    );
    // Pinned json — DeepSeek-class models honour no tool-calls.
    expect(resolved.mode).toBe("json");
  });

  it("resolves the real hosted DeepSeek reasoner (workers-ai + deepseek/ prefix)", async () => {
    // The model id is opaque to the backend resolver — it travels to the
    // modelGateway, where the `deepseek/` prefix selects the universal-endpoint
    // route to the real hosted reasoner (vs the weaker `@cf/...` distill).
    const store = {
      [BACKEND_KEYS["workers-ai"].modelKey]: "deepseek/deepseek-reasoner",
      [BACKEND_KEYS["workers-ai"].modeKey]: "json",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("workers-ai");
    expect(resolved.model).toBe("deepseek/deepseek-reasoner");
    expect(resolved.mode).toBe("json");
  });

  it("resolves the anthropic backend (BYOK via AI Gateway)", async () => {
    const store = {
      "pr-review.backend": "anthropic",
      [BACKEND_KEYS.anthropic.modelKey]: "anthropic/claude-sonnet-4-6",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("anthropic");
    expect(resolved.model).toBe("anthropic/claude-sonnet-4-6");
    // Claude honours forced tool use — default to the tool-calling path.
    expect(resolved.mode).toBe("tools");
    // Frontier context window → a far larger diff cap than the catalog's.
    expect(resolved.maxDiffChars).toBe(240_000);
  });

  it("resolves the openrouter backend (direct key, default mode = json, large diff cap)", async () => {
    const store = {
      "pr-review.backend": "openrouter",
      [BACKEND_KEYS.openrouter.modelKey]: "openrouter/deepseek/deepseek-v4-pro",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("openrouter");
    expect(resolved.model).toBe("openrouter/deepseek/deepseek-v4-pro");
    // Frontier reasoning model — no tool-calling; json/prompt mode by default.
    expect(resolved.mode).toBe("json");
    // Large context → anthropic-sized diff cap.
    expect(resolved.maxDiffChars).toBe(240_000);
  });

  it("honours an explicit per-backend mode override", async () => {
    const store = {
      [BACKEND_KEYS["workers-ai"].modelKey]: "m",
      [BACKEND_KEYS["workers-ai"].modeKey]: "json",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.mode).toBe("json");
  });

  it("falls back to the backend default for an unrecognized mode value", async () => {
    const store = {
      [BACKEND_KEYS["workers-ai"].modelKey]: "m",
      [BACKEND_KEYS["workers-ai"].modeKey]: "structured",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.mode).toBe("tools");
  });

  it("fails with BackendUnconfigured naming the missing model key", async () => {
    const exit = await Effect.runPromiseExit(resolveBackend(getter({})));
    expect(exit._tag).toBe("Failure");
  });

  it("resolves bedrock with model + roleArn + region (default mode = json)", async () => {
    const store = {
      "pr-review.backend": "bedrock",
      [BACKEND_KEYS.bedrock.modelKey]:
        "bedrock/us.anthropic.claude-opus-4-6-v1",
      [BACKEND_KEYS.bedrock.roleArnKey as string]:
        "arn:aws:iam::123456789012:role/PrReviewBedrock",
      [BACKEND_KEYS.bedrock.regionKey as string]: "us-west-2",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.backend).toBe("bedrock");
    expect(resolved.model).toBe("bedrock/us.anthropic.claude-opus-4-6-v1");
    expect(resolved.mode).toBe("json");
    expect(resolved.region).toBe("us-west-2");
    expect(resolved.roleArn).toBe(
      "arn:aws:iam::123456789012:role/PrReviewBedrock",
    );
  });

  it("bedrock — region defaults to us-east-1 when the region key is unset", async () => {
    const store = {
      "pr-review.backend": "bedrock",
      [BACKEND_KEYS.bedrock.modelKey]:
        "bedrock/us.anthropic.claude-opus-4-6-v1",
      [BACKEND_KEYS.bedrock.roleArnKey as string]:
        "arn:aws:iam::123456789012:role/PrReviewBedrock",
    };
    const resolved = await Effect.runPromise(resolveBackend(getter(store)));
    expect(resolved.region).toBe("us-east-1");
  });

  it("bedrock — fails with BackendUnconfigured when roleArn is unset", async () => {
    const store = {
      "pr-review.backend": "bedrock",
      [BACKEND_KEYS.bedrock.modelKey]:
        "bedrock/us.anthropic.claude-opus-4-6-v1",
    };
    const exit = await Effect.runPromiseExit(resolveBackend(getter(store)));
    expect(exit._tag).toBe("Failure");
  });
});

describe("namespaced config (downstream recipe reuse)", () => {
  it("derives per-namespace keys without colliding with pr-review", () => {
    expect(namespacedKey("spec-drift")("repos")).toBe("spec-drift.repos");
    expect(backendConfigKey("spec-drift")).toBe("spec-drift.backend");
    expect(promptKey("spec-drift")).toBe("spec-drift.prompt");
    expect(namespacedKeys("ci-triage")["workers-ai"].modelKey).toBe(
      "ci-triage.workers-ai.model",
    );
    // The default namespace's keys are unchanged (pr-review compatibility).
    expect(BACKEND_KEYS["workers-ai"].modelKey).toBe(
      "pr-review.workers-ai.model",
    );
  });

  it("resolveBackend reads the given namespace's keys", async () => {
    const store = {
      "spec-drift.backend": "workers-ai",
      "spec-drift.workers-ai.model":
        "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "spec-drift.workers-ai.mode": "json",
      // A pr-review key must NOT leak into the spec-drift resolution.
      "pr-review.workers-ai.model": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    };
    const resolved = await Effect.runPromise(
      resolveBackend(getter(store), { namespace: "spec-drift" }),
    );
    expect(resolved.backend).toBe("workers-ai");
    expect(resolved.model).toBe(
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
    );
    expect(resolved.mode).toBe("json");
  });
});

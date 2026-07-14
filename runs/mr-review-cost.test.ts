// Unit tests for the PURE mr-review cost accounting (pricing table, CONFIG_KV
// override parsing, USD → neuron math, and the footer's honest degradation).

import { describe, expect, it } from "vitest";
import {
  costFooter,
  costOf,
  DEFAULT_PRICING,
  parsePricingOverride,
  pricingKey,
  resolvePricing,
} from "./mr-review-cost";

describe("parsePricingOverride", () => {
  it("parses a well-formed `<in>,<out>` pair (with surrounding whitespace)", () => {
    expect(parsePricingOverride("0.66,1.0")).toEqual([0.66, 1.0]);
    expect(parsePricingOverride(" 0.045 , 0.38 ")).toEqual([0.045, 0.38]);
  });

  it("rejects malformed values → undefined (falls back to the built-in table)", () => {
    expect(parsePricingOverride(undefined)).toBeUndefined();
    expect(parsePricingOverride("")).toBeUndefined();
    expect(parsePricingOverride("0.66")).toBeUndefined(); // wrong arity
    expect(parsePricingOverride("0.66,1.0,extra")).toBeUndefined();
    expect(parsePricingOverride("cheap,dear")).toBeUndefined(); // non-numeric
    expect(parsePricingOverride("-1,2")).toBeUndefined(); // negative
  });
});

describe("resolvePricing", () => {
  it("prefers the operator override over the built-in table", () => {
    expect(resolvePricing("@cf/qwen/qwen2.5-coder-32b-instruct", [9, 9])).toEqual([9, 9]);
  });
  it("falls back to the built-in table when no override", () => {
    expect(resolvePricing("@cf/qwen/qwen2.5-coder-32b-instruct", undefined)).toEqual(
      DEFAULT_PRICING["@cf/qwen/qwen2.5-coder-32b-instruct"],
    );
  });
  it("returns undefined for an unknown model with no override", () => {
    expect(resolvePricing("@cf/unknown/model", undefined)).toBeUndefined();
  });
});

describe("costOf", () => {
  it("USD = tokens/1e6 · rate; neurons = usd / 0.000011 (rounded)", () => {
    // 14230 in @ $0.66/M + 1872 out @ $1.00/M = 0.0112638
    const { usd, neurons } = costOf({ inputTokens: 14230, outputTokens: 1872 }, [0.66, 1.0]);
    expect(usd).toBeCloseTo(0.0112638, 7);
    expect(neurons).toBe(1024); // 0.0112638 / 0.000011 ≈ 1023.98
  });
});

describe("pricingKey", () => {
  it("namespaces under pr-review.pricing.<model> (shared pr-review config)", () => {
    expect(pricingKey("@cf/qwen/qwen2.5-coder-32b-instruct")).toBe(
      "pr-review.pricing.@cf/qwen/qwen2.5-coder-32b-instruct",
    );
  });
});

describe("costFooter", () => {
  const usage = { inputTokens: 14230, outputTokens: 1872 };

  it("full line — model · tokens · neurons · USD (matches the spec example)", () => {
    expect(
      costFooter({
        model: "@cf/qwen/qwen2.5-coder-32b-instruct",
        usage,
        pricing: [0.66, 1.0],
      }),
    ).toBe(
      "⚙️ @cf/qwen/qwen2.5-coder-32b-instruct · 14,230 in + 1,872 out tokens · ~1,024 neurons · ≈$0.0113",
    );
  });

  it("known usage but NO price → token counts only (never invents a cost)", () => {
    expect(costFooter({ model: "@cf/unknown/model", usage, pricing: undefined })).toBe(
      "⚙️ @cf/unknown/model · 14,230 in + 1,872 out tokens",
    );
  });

  it("no usage at all → null (omit the footer entirely, never guess)", () => {
    expect(
      costFooter({ model: "@cf/any/model", usage: { inputTokens: 0, outputTokens: 0 }, pricing: [1, 1] }),
    ).toBeNull();
  });
});

// Per-run cost accounting for `mr-review` — a small, PURE pricing + footer
// module (no Effect, no bindings) so the math is unit-testable in plain Node.
//
// Workers AI bills in "neurons": an abstract compute unit, $0.011 per 1,000
// neurons on the paid plan (the free plan grants a daily 10k-neuron allowance).
// Most catalog models ALSO report token usage on the response — the model
// gateway now surfaces it (inputTokens / outputTokens). We turn tokens → USD via
// a per-model $/M-token table, then USD → neurons so the footer speaks the unit
// the operator's Cloudflare dashboard bills in.
//
//   neurons = usd / 0.000011              ( $0.011 / 1000 )
//   usd     = inTok/1e6 * inRate + outTok/1e6 * outRate
//
// The footer degrades honestly: a model with NO reported usage renders no footer
// at all (we never guess token counts); a model with usage but no known price
// renders the token counts alone (no USD / neuron figures invented).

/** A model's price, per MILLION tokens: `[inputPerM, outputPerM]` USD. */
export type ModelPricing = readonly [inputPerM: number, outputPerM: number];

/** Aggregated token usage across a run's (possibly multi-agent) model fan-out. */
export type CostUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
};

/**
 * Published Workers AI $/M-token rates for the models this PoC uses. Overridable
 * per-model via CONFIG_KV `pr-review.pricing.<model>` = `"<in>,<out>"` (see
 * {@link parsePricingOverride}) so a rate change needs no redeploy. A model
 * absent here AND absent from config renders token-only (no USD).
 */
export const DEFAULT_PRICING: Readonly<Record<string, ModelPricing>> = {
  "@cf/qwen/qwen2.5-coder-32b-instruct": [0.66, 1.0],
  "@cf/meta/llama-3.1-8b-instruct-fast": [0.045, 0.38],
  "@cf/mistralai/mistral-small-3.1-24b-instruct": [0.35, 0.56],
  // Likely next defaults after the bake-off (catalog ids verified against the
  // @cloudflare/workers-types AI catalog).
  "@cf/openai/gpt-oss-120b": [0.35, 0.75],
  "@cf/openai/gpt-oss-20b": [0.2, 0.3],
};

/** USD per neuron — Workers AI bills $0.011 per 1,000 neurons. */
export const USD_PER_NEURON = 0.000011;

/** The CONFIG_KV key an operator sets to override a model's price. */
export const pricingKey = (model: string): string => `pr-review.pricing.${model}`;

/**
 * Parse a CONFIG_KV pricing override — `"<inPerM>,<outPerM>"` (e.g. `"0.66,1.0"`).
 * Returns `undefined` for any malformed value (wrong arity, non-finite, negative)
 * so a fat-fingered override silently falls back to the built-in table rather
 * than rendering a nonsense price.
 */
export const parsePricingOverride = (raw: string | undefined): ModelPricing | undefined => {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 2) return undefined;
  const [inRate, outRate] = parts as [number, number];
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate) || inRate < 0 || outRate < 0) {
    return undefined;
  }
  return [inRate, outRate];
};

/** Resolve a model's price — the operator override wins over the built-in table. */
export const resolvePricing = (
  model: string,
  override: ModelPricing | undefined,
): ModelPricing | undefined => override ?? DEFAULT_PRICING[model];

/** Convert an aggregated usage + price into USD + neurons. */
export const costOf = (
  usage: CostUsage,
  pricing: ModelPricing,
): { readonly usd: number; readonly neurons: number } => {
  const usd = (usage.inputTokens / 1e6) * pricing[0] + (usage.outputTokens / 1e6) * pricing[1];
  return { usd, neurons: Math.round(usd / USD_PER_NEURON) };
};

const grouped = (n: number): string => Math.round(n).toLocaleString("en-US");

/**
 * Render the per-run cost footer line — or `null` to omit it entirely. Shape:
 *
 *   ⚙️ @cf/qwen/qwen2.5-coder-32b-instruct · 14,230 in + 1,872 out tokens · ~1,024 neurons · ≈$0.0113
 *
 * Degradation:
 *   * no usage at all (both counts ≤ 0) → `null` (no footer — never guess).
 *   * usage but no known price          → token counts only (no USD/neurons).
 */
export const costFooter = (args: {
  readonly model: string;
  readonly usage: CostUsage;
  readonly pricing: ModelPricing | undefined;
}): string | null => {
  const { model, usage, pricing } = args;
  if (usage.inputTokens <= 0 && usage.outputTokens <= 0) return null;

  const tokens = `${grouped(usage.inputTokens)} in + ${grouped(usage.outputTokens)} out tokens`;
  if (pricing === undefined) return `⚙️ ${model} · ${tokens}`;

  const { usd, neurons } = costOf(usage, pricing);
  return `⚙️ ${model} · ${tokens} · ~${grouped(neurons)} neurons · ≈$${usd.toFixed(4)}`;
};

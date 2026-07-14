// @flare-dispatch/review-agent — public API.
//
// A provider-agnostic, Worker-side code-review engine that calls a model
// through the `modelGateway` capability (`@flare-dispatch/core`) — backed by the
// Cloudflare Workers AI binding via an AI Gateway, so NO model API key is
// configured (the binding is the auth). The `pr-review` run composes these into
// a real review:
//
//   import {
//     resolveBackend,
//     riskTier, reviewDomain, coordinate,
//     stripDiffNoise, ReviewOutput, type Finding,
//   } from "@flare-dispatch/review-agent";
//
// Backend selection + the operator config contract live in `backend.ts`; the
// model-calling engine in `engine.ts`; the shared wire schemas in `schemas.ts`.

export {
  type Finding,
  Finding as FindingSchema,
  type Tier,
  Tier as TierSchema,
  type Verdict,
  Verdict as VerdictSchema,
  type CoordinatedReview,
  CoordinatedReview as CoordinatedReviewSchema,
  type ReviewOutput,
  ReviewOutput as ReviewOutputSchema,
} from "./schemas.js";

export {
  ModelCallFailed,
  BackendUnconfigured,
  StructuredOutputInvalid,
  type ReviewEngineError,
} from "./errors.js";

export {
  BACKENDS,
  type Backend,
  REVIEW_MODES,
  type ReviewMode,
  DEFAULT_BACKEND,
  DEFAULT_NAMESPACE,
  BACKEND_CONFIG_KEY,
  BACKEND_KEYS,
  type BackendKeyDescriptor,
  namespacedKeys,
  namespacedKey,
  backendConfigKey,
  promptKey,
  guidelinesKey,
  type ResolvedBackend,
  parseBackend,
  parseMode,
  resolveBackend,
  classifyModelError,
} from "./backend.js";

export {
  extractJsonText,
  extractJsonCandidates,
  stripThinkBlocks,
  stripCodeFences,
} from "./json-extract.js";

export {
  DEFAULT_REVIEW_SYSTEM_PROMPT,
  composeSystemPrompt,
  type CompleteStructuredInput,
  completeStructured,
  type ReviewDomainInput,
  reviewDomain,
  renderDomainBody,
  type CoordinateInput,
  coordinate,
  coordinateReview,
  type RiskTierInput,
  RISK_THRESHOLDS,
  riskTier,
  classifyRisk,
} from "./engine.js";

export { stripDiffNoise, capDiff, MAX_DIFF_CHARS } from "./diff.js";

export {
  sanitizeModelText,
  encodeFindingPath,
  findingLoc,
  tableCell,
} from "./comment-sanitize.js";

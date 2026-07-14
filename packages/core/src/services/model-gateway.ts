// @flare-dispatch/core — the `modelGateway` capability (ask a model).
//
// A provider-agnostic "ask a model one turn" capability. `complete` sends a
// system + user message (optionally with a tool the model may call) and returns
// the model's tool calls and/or free text. It is deliberately NOT "Workers AI"
// or "/chat/completions" — those are *backends*. The live Layer
// (`@flare-dispatch/runtime-cf`'s `makeModelGatewayLive`) is backed by the
// Cloudflare Workers AI binding (`env.AI`) routed through an AI Gateway; a
// fake (`@flare-dispatch/core/testing`'s `makeModelGatewayFake`) returns canned
// outputs. The interface is the seam: an OpenAI / Bedrock / Ollama Layer can
// back the same Tag without any engine change.
//
// --- Why a capability, not an HTTP client ------------------------------------
//
// The earlier engine POSTed to an OpenAI-compatible `/chat/completions`
// endpoint over `HttpClient`, which required a per-backend API key (the gateway
// was the auth). Routing through the Workers AI *binding* makes the binding the
// auth — Workers AI is account-billed, no key travels with the request — so the
// engine no longer carries a base url or secret. It just yields this Tag, the
// way it already yields `config` / `sandbox`, and the runtime provides it.
//
// Spec: specs/03-dsl.md § Capabilities.

import { Context, Effect, Schema } from "effect";

/**
 * A tool the model may call. `parameters` is a JSON Schema (draft-07) object
 * describing the tool's arguments — provider-agnostic, the same shape every
 * tool-calling API accepts under one name or another.
 */
export type ModelTool = {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool's arguments. */
  readonly parameters: unknown;
};

/** One tool call the model emitted. */
export type ModelToolCall = {
  readonly name: string;
  /**
   * The tool's arguments. Provider-shaped: some backends return a JSON *string*
   * (OpenAI), others a parsed *object* (Workers AI). The caller normalizes —
   * the capability passes whatever the backend returned through verbatim.
   */
  readonly arguments: unknown;
};

/** A single-turn model request. */
export type ModelCompletionRequest = {
  /**
   * The model id with a backend prefix the gateway dispatches on:
   *
   *   `@cf/...`             — Workers AI catalog (default when no prefix)
   *   `anthropic/<model>`   — Anthropic Messages API via AI Gateway BYOK
   *   `bedrock/<model>`     — AWS Bedrock InvokeModel via AI Gateway
   */
  readonly model: string;
  /** The system-role instruction. */
  readonly system: string;
  /** The user-role message. */
  readonly user: string;
  /**
   * Tools the model may call. When present, the backend is asked to call one
   * (forced tool choice where the provider supports it). Absent → a plain text
   * completion; read `text`.
   */
  readonly tools?: ReadonlyArray<ModelTool>;
  /** Optional max output tokens. */
  readonly maxTokens?: number;
  /** Optional sampling temperature. */
  readonly temperature?: number;
  /**
   * Optional JSON Schema (draft-07 object) for constrained decoding. When set, a
   * backend that supports guided generation forwards it as `response_format` so
   * the model emits schema-valid JSON by construction; backends that don't
   * support it ignore the field. Used by the json-mode review path.
   */
  readonly jsonSchema?: unknown;
  /**
   * AWS credentials + region — required for `bedrock/*` model ids only.
   * Per-execution: short-lived STS creds minted by `awsAssumeRole` inside the
   * run, threaded here so the Bedrock route can SigV4-sign without holding any
   * deploy-time AWS keys. Other backends ignore this field.
   */
  readonly aws?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken: string;
    readonly region: string;
  };
};

/** What a completion yields — tool calls and/or free text. */
export type ModelCompletionResult = {
  /** The model's tool calls (empty when it answered with text). */
  readonly toolCalls: ReadonlyArray<ModelToolCall>;
  /** The model's free-text answer (empty when it answered with a tool call). */
  readonly text: string;
  /**
   * Optional token-usage telemetry. Backends that surface a usage block
   * (Bedrock, Anthropic) populate these; backends that don't (Workers AI
   * catalog) leave them undefined. Caller-side: log them when present, never
   * gate on them.
   */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /**
   * Optional provider-reported EXACT charge in USD. Some backends (e.g.
   * OpenRouter with usage accounting) return the real dollar cost of the call;
   * a caller doing cost attribution should prefer this over a per-M-token
   * estimate. Backends without a cost figure leave it undefined.
   */
  readonly costUsd?: number;
  /**
   * Optional count of reasoning/thinking tokens a reasoning model spent before
   * the final answer (e.g. OpenRouter's `completion_tokens_details.reasoning_tokens`).
   * Informational only; undefined when the backend doesn't report it.
   */
  readonly reasoningTokens?: number;
};

/**
 * The model call failed at the *backend* — a transport/auth/rate/timeout
 * failure or an unusable response. Provider-agnostic (no HTTP status, no
 * `/chat/completions`): the engine maps it to its own `ModelCallFailed`. A
 * model that simply *declined to call a tool* is NOT a failure — that surfaces
 * as an empty `toolCalls` in a successful result.
 */
export class ModelGatewayError extends Schema.TaggedError<ModelGatewayError>()(
  "ModelGatewayError",
  {
    /** The model id, for the operator-facing reason string. */
    model: Schema.String,
    reason: Schema.Literal(
      "auth-failed",
      "rate-limited",
      "bad-response",
      "timeout",
      "unknown",
    ),
    message: Schema.String,
  },
) {}

/** The service contract a runtime Layer implements. */
export interface ModelGatewayService {
  readonly complete: (
    req: ModelCompletionRequest,
  ) => Effect.Effect<ModelCompletionResult, ModelGatewayError>;
}

/** Context.Tag — the model-gateway dependency a model-calling run/engine carries. */
export class ModelGateway extends Context.Tag(
  "@flare-dispatch/core/ModelGateway",
)<ModelGateway, ModelGatewayService>() {}

/**
 * The `modelGateway` accessor namespace — reads the service from context and
 * delegates, so a caller writes `modelGateway.complete(...)` rather than the
 * explicit `Effect.flatMap(ModelGateway, ...)`.
 */
export const modelGateway = {
  complete: (req: ModelCompletionRequest) =>
    Effect.flatMap(ModelGateway, (s) => s.complete(req)),
} as const;

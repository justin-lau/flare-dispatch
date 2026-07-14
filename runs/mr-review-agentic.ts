// Agentic (multi-turn, tool-calling) reviewer for `mr-review` — the A/B arm to
// the single-shot reviewer (runs/mr-review.ts) and its pre-injected grounding
// (runs/mr-review-grounding.ts).
//
// Where single-shot bakes a fixed grounding block into the diff and asks the
// model ONCE, the agentic reviewer lets the model DRIVE its own retrieval: it may
// call hakiri tools mid-review across several turns (search / SQL over the repo's
// main-branch files) before submitting a verdict. The turns are serializable so
// the GitLab Workflow can drive them STEP-PER-TURN — each turn a durable, memoized
// step, so a transient failure at turn 6 never re-bills turns 1–5.
//
// The module is three serializable-state functions the Workflow (or the in-Effect
// `runAgenticReview` driver, used by tests) composes:
//
//   initAgenticReview(input) -> AgenticState   fetch+cap the diff, build the
//                                               system prompt + first user turn,
//                                               resolve backend + retrieval config.
//   runAgenticTurn(state)    -> AgenticState    execute pending tool calls, call
//                                               the model, append the assistant
//                                               turn, accumulate usage, maybe
//                                               terminate.
//   finalizeAgentic(input, state) -> MrComputeResult   render the note (SAME
//                                               renderer + cost footer the
//                                               single-shot path uses).
//
// Agentic mode ALWAYS uses the single generalist reviewer (never the multi
// fan-out). Native tool-calling support is openrouter + workers-ai only (the
// model gateway flattens the transcript for other backends — see model-gateway-cf.ts).

import { Effect, Either, JSONSchema, Option, Schema } from "effect";
import {
  config,
  type Config,
  type ModelCompletionResult,
  type ModelMessage,
  modelGateway,
  type ModelGateway,
  type ModelTool,
  type ModelToolCall,
  scm,
  type Scm,
  ScmError,
} from "@flare-dispatch/core";
import {
  BackendUnconfigured,
  capDiff,
  composeSystemPrompt,
  coordinateReview,
  DEFAULT_NAMESPACE,
  type Finding,
  FindingSchema,
  guidelinesKey,
  ModelCallFailed,
  renderDomainBody,
  resolveBackend,
  riskTier,
  stripDiffNoise,
  type Tier,
} from "@flare-dispatch/review-agent";
import {
  type CostUsage,
  costFooter,
  type ModelPricing,
  parsePricingOverride,
  pricingKey,
  resolvePricing,
} from "./mr-review-cost";
import {
  failureNote,
  type MrComputeResult,
  type MrReviewInput,
  refFor,
  renderReviewComment,
} from "./mr-review";
import {
  type GroundingConfig,
  makeHakiriCall,
  toolText,
} from "./mr-review-grounding";

/** Config namespace — SHARED with pr-review / mr-review so operators configure one place. */
const NS = DEFAULT_NAMESPACE;

/** Max model turns before the reviewer is forced to submit. On the last turn only
 *  `submit_review` is offered (no retrieval) and a final nudge is appended. */
export const MAX_TURNS = 8;
/** Retrieval tool calls actually executed per turn — excess get a "consolidate" error. */
const TOOL_CALLS_PER_TURN = 4;
/** Per-tool-result char cap (with a `[truncated]` marker) — keeps the transcript bounded. */
const TOOL_RESULT_MAX_CHARS = 12_000;
/** `context.search` hits per hakiri_search call. */
const SEARCH_LIMIT = 3;

// ---------------------------------------------------------------------------
// Tools offered to the model.

/** The `submit_review` argument shape — mirrors the engine's DomainOutput. */
const SubmitReviewSchema = Schema.Struct({ findings: Schema.Array(FindingSchema) });

/** A JSON Schema (draft-07) for a schema's tool parameters — minus the `$schema` meta key. */
const toolParameters = (schema: Schema.Schema<unknown, unknown>): unknown => {
  const js = JSONSchema.make(schema) as unknown as Record<string, unknown>;
  const { $schema: _drop, ...rest } = js;
  return rest;
};

const hakiriSearchTool: ModelTool = {
  name: "hakiri_search",
  description:
    "Full-text search the repository's main-branch files for code relevant to the change. Returns up to 3 ranked snippets with their file paths. Use it to find call sites, related helpers, types, and surrounding code the diff does not show.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "keywords or an identifier to search for" },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const hakiriQueryTool: ModelTool = {
  name: "hakiri_query",
  description:
    "Run a read-only SQL query over the repository's main-branch files. The table `repo_files` has columns path, name, ext, size, content, deleted — ALWAYS filter `not deleted`. Use it to read a whole file the diff touches, e.g. `select content from repo_files where path = 'src/foo.ts' and not deleted`.",
  parameters: {
    type: "object",
    properties: {
      sql: { type: "string", description: "a read-only SQL SELECT over repo_files" },
    },
    required: ["sql"],
    additionalProperties: false,
  },
};

const submitReviewTool: ModelTool = {
  name: "submit_review",
  description:
    "Submit your final review. Provide the `findings` array (empty when the change is clean); each finding is anchored to a file + line range present in the diff. Calling this ENDS the review.",
  parameters: toolParameters(SubmitReviewSchema as unknown as Schema.Schema<unknown, unknown>),
};

/** The agentic reviewer's base system instruction (before operator guidelines). */
const AGENTIC_REVIEW_SYSTEM_PROMPT = `You are a senior code reviewer performing an AGENTIC review of a single merge-request diff.

You may call retrieval tools to inspect the surrounding code on the repository's main branch BEFORE deciding:
  - hakiri_search(query): full-text search for relevant code (call sites, helpers, types).
  - hakiri_query(sql): read whole files via SQL over the \`repo_files\` table (columns path/name/ext/size/content/deleted — ALWAYS filter \`not deleted\`).

Investigate only what you need — a few targeted calls, not exhaustive crawling. When you have enough context, call submit_review exactly once with your findings (an empty array is valid when the change is clean). Anchor every finding to a real file path and line range present in the diff. Prefer a small number of high-signal findings. Do not respond with prose — a tool call is your output.`;

/** Appended on the final turn when retrieval is no longer offered. */
const FINAL_TURN_NUDGE =
  "No more retrieval is available — submit your review now by calling submit_review (an empty findings array is valid), or reply with only the raw findings JSON object.";

// ---------------------------------------------------------------------------
// Serializable state.

/** A terminal error carried in the state (the loop never throws — it records here). */
export type AgenticError = {
  /** A rate-limited model failure → skipped-quota degradation (post nothing). */
  readonly rateLimited: boolean;
  /** Operator-facing reason, rendered into the failure note. */
  readonly message: string;
};

/**
 * The plain-JSON state the Workflow persists between turn steps. Backend/pricing/
 * tier are resolved ONCE in init and carried here so each turn is self-contained
 * (a Ref-based meter can't cross Workflow invocations — cost sums in the state).
 */
export type AgenticState = {
  /** The running transcript sent to the model each turn. */
  readonly messages: ReadonlyArray<ModelMessage>;
  /** How many model turns have completed. */
  readonly turn: number;
  /** Accumulated usage across turns (plain addition — the Ref meter can't span steps). */
  readonly cost: CostUsage;
  /** Terminal flag — the driver stops looping once set. */
  readonly done: boolean;
  /** The submitted findings (present once the model called submit_review / emitted JSON). */
  readonly findings?: ReadonlyArray<Finding>;
  /** A terminal error (model failure / bad submission) — mutually exclusive with findings. */
  readonly error?: AgenticError;
  /** Resolved model id (for the cost footer + pricing). */
  readonly model: string;
  /** Resolved backend name (informational). */
  readonly backend: string;
  /** Per-turn output-token budget. */
  readonly maxTokens: number;
  /** The risk tier (pure heuristic on the diff) — stitched onto the output. */
  readonly tier: Tier;
  /** Resolved hakiri retrieval config — `undefined` disables the retrieval tools. */
  readonly retrieval?: GroundingConfig;
  /** Resolved price (operator override over the table) — for the cost footer. */
  readonly pricing?: ModelPricing;
  /** Cumulative retrieval tool calls actually executed (for the footer + grounded flag). */
  readonly toolCallCount: number;
};

// ---------------------------------------------------------------------------
// init.

/**
 * Build the initial agentic state: resolve the backend, fetch + cap the diff,
 * compose the system prompt + first user turn (single "general" domain), and
 * resolve retrieval + pricing config. Never fails — a resolve/fetch error is
 * caught into a terminal error state (mirroring mrReviewCompute's boundary), so
 * the Workflow's init step never throws.
 */
export const initAgenticReview = (
  input: MrReviewInput,
): Effect.Effect<AgenticState, never, Config | Scm> =>
  Effect.gen(function* () {
    const resolved = yield* resolveBackend((key) => config.get(key), { namespace: NS });

    const rawDiff = yield* scm.fetchDiff(refFor(input));
    const diff = capDiff(stripDiffNoise(rawDiff), resolved.maxDiffChars);
    const tier = yield* riskTier({ diff });

    const guidelines = (yield* config.get(guidelinesKey(NS)))?.trim();
    const systemPrompt = composeSystemPrompt({
      base: AGENTIC_REVIEW_SYSTEM_PROMPT,
      ...(guidelines !== undefined && guidelines !== "" ? { guidelines } : {}),
    });
    const userBody = renderDomainBody({
      agent: "general",
      diff,
      tier,
      model: resolved.model,
      backend: resolved.backend,
    });

    const retrieval = yield* resolveRetrieval();
    const pricing = resolvePricing(
      resolved.model,
      parsePricingOverride(yield* config.get(pricingKey(resolved.model))),
    );

    return {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userBody },
      ],
      turn: 0,
      cost: { inputTokens: 0, outputTokens: 0 },
      done: false,
      model: resolved.model,
      backend: resolved.backend,
      maxTokens: resolved.maxTokens,
      tier,
      ...(retrieval !== undefined ? { retrieval } : {}),
      ...(pricing !== undefined ? { pricing } : {}),
      toolCallCount: 0,
    } satisfies AgenticState;
  }).pipe(Effect.catchAll((err) => Effect.succeed(errorState(describeError(err)))));

/** A terminal state carrying an init/setup error (no model resolved). */
const errorState = (message: string): AgenticState => ({
  messages: [],
  turn: 0,
  cost: { inputTokens: 0, outputTokens: 0 },
  done: true,
  error: { rateLimited: false, message },
  model: "",
  backend: "",
  maxTokens: 0,
  tier: "trivial",
  toolCallCount: 0,
});

/** Resolve hakiri retrieval config from CONFIG_KV — `undefined` (no endpoint) →
 *  agentic runs with only `submit_review` offered (no retrieval tools). */
const resolveRetrieval = (): Effect.Effect<GroundingConfig | undefined, never, Config> =>
  Effect.gen(function* () {
    const endpoint = (yield* config.get("pr-review.hakiri.endpoint"))?.trim();
    if (endpoint === undefined || endpoint === "") return undefined;
    const token = (yield* config.get("pr-review.hakiri.token"))?.trim();
    return { endpoint, ...(token !== undefined && token !== "" ? { token } : {}) };
  });

// ---------------------------------------------------------------------------
// turn.

/**
 * Advance one turn: (i) execute any pending tool calls the previous assistant
 * message emitted, appending their results; (ii) call the model with the full
 * transcript + the offered tools; (iii) append the assistant turn + accumulate
 * usage, and terminate when it submits a review (a `submit_review` call, or —
 * for json-mode models — assistant text that parses as the findings object).
 * Never fails: a model error is caught into the state's terminal `error`.
 */
export const runAgenticTurn = (
  state: AgenticState,
): Effect.Effect<AgenticState, never, ModelGateway> =>
  Effect.gen(function* () {
    if (state.done) return state;

    // (i) Execute pending retrieval tool calls from the previous assistant turn.
    const last = state.messages[state.messages.length - 1];
    let messages: ReadonlyArray<ModelMessage> = state.messages;
    let toolCallCount = state.toolCallCount;
    if (
      last !== undefined &&
      last.role === "assistant" &&
      last.toolCalls !== undefined &&
      last.toolCalls.length > 0
    ) {
      const { toolResults, executed } = yield* executePendingToolCalls(
        last.toolCalls,
        state.retrieval,
      );
      messages = [...messages, ...toolResults];
      toolCallCount += executed;
    }

    // On the final turn, offer ONLY submit_review (no retrieval) + a nudge. With
    // no retrieval endpoint at all, submit_review is the only tool every turn.
    const isFinalTurn = state.turn >= MAX_TURNS - 1;
    const hasRetrieval = state.retrieval !== undefined;
    if (isFinalTurn) {
      messages = [...messages, { role: "user", content: FINAL_TURN_NUDGE }];
    }
    const tools =
      isFinalTurn || !hasRetrieval
        ? [submitReviewTool]
        : [hakiriSearchTool, hakiriQueryTool, submitReviewTool];

    // (ii) Call the model — `messages` takes precedence over system/user.
    const result = yield* modelGateway
      .complete({ model: state.model, system: "", user: "", messages, tools, maxTokens: state.maxTokens })
      .pipe(Effect.either);

    if (Either.isLeft(result)) {
      const e = result.left;
      return {
        ...state,
        messages,
        toolCallCount,
        turn: state.turn + 1,
        done: true,
        error: {
          rateLimited: e.reason === "rate-limited",
          message: `model call failed (${e.reason}): ${e.message}`,
        },
      };
    }
    const res = result.right;

    // (iii) Append the assistant turn (synthesizing ids for tool calls the
    // provider didn't id) + accumulate usage.
    const assistantToolCalls: ReadonlyArray<ModelToolCall> = res.toolCalls.map((tc, i) => ({
      ...tc,
      id: tc.id ?? `call_${state.turn}_${i}`,
    }));
    const assistantMessage: ModelMessage = {
      role: "assistant",
      content: res.text ?? "",
      ...(assistantToolCalls.length > 0 ? { toolCalls: assistantToolCalls } : {}),
    };
    const next: AgenticState = {
      ...state,
      messages: [...messages, assistantMessage],
      cost: accumulateCost(state.cost, res),
      toolCallCount,
      turn: state.turn + 1,
    };

    // Terminate on submit_review (parse its args), else on json-mode findings text.
    const submit = assistantToolCalls.find((tc) => tc.name === "submit_review");
    if (submit !== undefined) {
      return Option.match(parseFindings(submit.arguments), {
        onSome: (findings) => ({ ...next, done: true, findings }),
        onNone: () => ({
          ...next,
          done: true,
          error: {
            rateLimited: false,
            message: "submit_review arguments did not match the findings schema",
          },
        }),
      });
    }
    if (assistantToolCalls.length === 0) {
      const parsed = parseFindingsFromText(res.text ?? "");
      if (Option.isSome(parsed)) return { ...next, done: true, findings: parsed.value };
    }
    return next;
  });

/**
 * Execute the retrieval tool calls a turn's assistant emitted — EVERY call gets a
 * matching `tool`-role result (the OpenAI wire requires it), even the excess/failed
 * ones (as error text). Best-effort: an HTTP/timeout failure yields an error
 * STRING result, never a failed Effect (the model then continues diff-only — that
 * IS the degradation path). Caps {@link TOOL_CALLS_PER_TURN} executed per turn.
 */
const executePendingToolCalls = (
  calls: ReadonlyArray<ModelToolCall>,
  retrieval: GroundingConfig | undefined,
): Effect.Effect<{ readonly toolResults: ReadonlyArray<ModelMessage>; readonly executed: number }> =>
  Effect.promise(async () => {
    const call = retrieval !== undefined ? makeHakiriCall(retrieval) : undefined;
    const toolResults: ModelMessage[] = [];
    let executed = 0;
    let budget = TOOL_CALLS_PER_TURN;
    for (const tc of calls) {
      // submit_review is terminal — never executed here (a submit would have ended
      // the loop at the response site).
      if (tc.name === "submit_review") continue;

      let content: string;
      if (tc.name !== "hakiri_search" && tc.name !== "hakiri_query") {
        content = `error: unknown tool "${tc.name}"`;
      } else if (call === undefined) {
        content = "error: no retrieval endpoint is configured; proceed with the diff alone";
      } else if (budget <= 0) {
        content = "error: too many tool calls this turn — consolidate and retry with fewer";
      } else {
        budget -= 1;
        content = await runOneRetrieval(call, tc);
        executed += 1;
      }
      toolResults.push({
        role: "tool",
        content: truncate(content),
        ...(tc.id !== undefined ? { toolCallId: tc.id } : {}),
        name: tc.name,
      });
    }
    return { toolResults, executed };
  });

/** Execute ONE retrieval call — never throws (any failure → an error string). */
const runOneRetrieval = async (
  call: (name: string, argument: Record<string, unknown>) => Promise<unknown>,
  tc: ModelToolCall,
): Promise<string> => {
  try {
    const args = readArgs(tc.arguments);
    if (tc.name === "hakiri_search") {
      const query = String(args.query ?? "");
      return toolText(await call("context.search", { query, limit: SEARCH_LIMIT })) || "(no results)";
    }
    const sql = String(args.sql ?? "");
    return toolText(await call("context.query", { sql })) || "(no rows)";
  } catch (e) {
    return `error: hakiri call failed — ${e instanceof Error ? e.message : String(e)}`;
  }
};

// ---------------------------------------------------------------------------
// finalize.

/**
 * Map the terminal agentic state onto the SAME {@link MrComputeResult} shape the
 * single-shot path produces — reusing {@link renderReviewComment} + {@link costFooter}.
 * Rate-limited → skipped-quota (post nothing); any other error → a failure note;
 * else coordinate the findings and render the note with an agentic meta line
 * (mode · turns used · retrieval-call count) appended below the cost footer.
 */
export const finalizeAgentic = (
  input: MrReviewInput,
  state: AgenticState,
): MrComputeResult => {
  if (state.error?.rateLimited === true) {
    return { status: "skipped-quota", output: null, noteBody: null, usage: null, grounded: false };
  }
  if (state.error !== undefined) {
    return {
      status: "failure",
      output: null,
      noteBody: failureNote(state.error.message),
      usage: null,
      grounded: false,
    };
  }
  if (state.findings === undefined) {
    return {
      status: "failure",
      output: null,
      noteBody: failureNote(`agentic review did not submit a verdict within ${MAX_TURNS} turns`),
      usage: null,
      grounded: false,
    };
  }

  const output = { ...coordinateReview({ findings: state.findings }), tier: state.tier };
  const cost = costFooter({ model: state.model, usage: state.cost, pricing: state.pricing });
  const retrievalNote = state.retrieval === undefined ? " · no retrieval endpoint" : "";
  const metaLine = `🔁 agentic · ${state.turn} turn(s) · ${state.toolCallCount} retrieval call(s)${retrievalNote}`;
  const footer = cost !== null ? `${cost}\n${metaLine}` : metaLine;

  return {
    status: "success",
    output,
    noteBody: renderReviewComment(input, output, footer),
    usage: state.cost,
    grounded: state.toolCallCount > 0,
  };
};

// ---------------------------------------------------------------------------
// The in-Effect driver — loops init → turns → finalize. The GitLab Workflow
// mirrors this with `step.do` per turn (durable, memoized); tests drive this.

/**
 * Run the whole agentic review in one Effect (init, up to {@link MAX_TURNS}
 * turns, finalize). The Workflow does NOT call this — it runs the turn functions
 * as separate durable steps — but it shares the exact same primitives, so this
 * driver and the Workflow loop stay in lockstep.
 */
export const runAgenticReview = (
  input: MrReviewInput,
): Effect.Effect<MrComputeResult, never, Config | ModelGateway | Scm> =>
  Effect.gen(function* () {
    let state = yield* initAgenticReview(input);
    for (let i = 0; i < MAX_TURNS && !state.done; i++) {
      state = yield* runAgenticTurn(state);
    }
    return finalizeAgentic(input, state);
  });

// ---------------------------------------------------------------------------
// Helpers (pure).

/** Read a tool call's provider-shaped arguments (object or JSON string) to an object. */
const readArgs = (args: unknown): Record<string, unknown> => {
  const value = typeof args === "string" ? safeJson(args) : args;
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
};

/** `JSON.parse` or `undefined` on failure. */
const safeJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** Truncate an over-long tool result with a visible marker. */
const truncate = (s: string): string =>
  s.length > TOOL_RESULT_MAX_CHARS ? `${s.slice(0, TOOL_RESULT_MAX_CHARS)}\n[truncated]` : s;

/** Parse a `submit_review` tool call's arguments to findings, or `none`. */
const parseFindings = (args: unknown): Option.Option<ReadonlyArray<Finding>> => {
  const value = typeof args === "string" ? safeJson(args) : args;
  if (value === undefined) return Option.none();
  const decoded = Schema.decodeUnknownEither(SubmitReviewSchema)(value);
  return Either.isRight(decoded) ? Option.some(decoded.right.findings) : Option.none();
};

/** Parse assistant free text (json-mode models) as the findings object, or `none`. */
const parseFindingsFromText = (text: string): Option.Option<ReadonlyArray<Finding>> => {
  const value = safeJson(text.trim());
  if (value === undefined) return Option.none();
  const decoded = Schema.decodeUnknownEither(SubmitReviewSchema)(value);
  return Either.isRight(decoded) ? Option.some(decoded.right.findings) : Option.none();
};

/** Sum optional numbers, staying `undefined` only when BOTH are absent. */
const addOptional = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);

/** Accumulate one call's usage into the running total (mirrors mr-review metering). */
const accumulateCost = (u: CostUsage, res: ModelCompletionResult): CostUsage => {
  const costUsd = addOptional(u.costUsd, res.costUsd);
  const reasoningTokens = addOptional(u.reasoningTokens, res.reasoningTokens);
  return {
    inputTokens: u.inputTokens + (res.inputTokens ?? 0),
    outputTokens: u.outputTokens + (res.outputTokens ?? 0),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
};

/** Describe an init/setup error for the failure note. */
const describeError = (err: unknown): string => {
  if (err instanceof BackendUnconfigured) {
    return `backend "${err.backend}" is misconfigured — set ${err.missing}`;
  }
  if (err instanceof ModelCallFailed) {
    return `model call failed (${err.reason}): ${err.message}`;
  }
  if (err instanceof ScmError) {
    return `GitLab (${err.provider}) request failed (${err.reason}): ${err.message}`;
  }
  return err instanceof Error ? err.message : JSON.stringify(err);
};

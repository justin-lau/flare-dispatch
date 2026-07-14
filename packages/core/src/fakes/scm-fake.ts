// @flare-dispatch/core — Scm fake (provider-neutral source control).
//
// In-memory fake of the `scm` capability, mirroring `makeModelGatewayFake`:
// `fetchDiff` returns a canned diff and records the `ChangeRef`; `postReview`
// records the note and succeeds. A test asserts on the recorded calls to prove
// the review fetched the diff and posted exactly one note.
//
// A test that wants `scm` to FAIL with `ScmError` constructs its own failing
// `Scm` Layer — the fake is the green-path simulator (same posture as the
// Github fake).

import { Effect, Layer } from "effect";
import {
  type ChangeRef,
  type ReviewNote,
  Scm,
  type ScmService,
} from "../services/scm";

/** Inspectable record of every Scm fake call. */
export type ScmFakeState = {
  /** Every `fetchDiff` ref, in order. */
  readonly fetchDiffCalls: ChangeRef[];
  /** Every `postReview` note, in order — lets a test assert a note posted. */
  readonly postReviewCalls: ReviewNote[];
};

export type ScmFakeOptions = {
  /** Canned diff every `fetchDiff` returns. Default: a tiny one-file diff. */
  readonly diff?: string;
};

/** Default canned diff — a minimal, valid one-file unified diff. */
const DEFAULT_DIFF =
  "diff --git a/src/x.ts b/src/x.ts\n" +
  "--- a/src/x.ts\n" +
  "+++ b/src/x.ts\n" +
  "@@ -1 +1 @@\n" +
  "-const x = 1;\n" +
  "+const x = 2;\n";

/**
 * Build an Scm fake plus an inspectable state handle. `fetchDiff` records the
 * ref and returns the canned diff; `postReview` records the note and succeeds.
 */
export const makeScmFake = (
  opts: ScmFakeOptions = {},
): { layer: Layer.Layer<Scm>; state: ScmFakeState } => {
  const state: ScmFakeState = { fetchDiffCalls: [], postReviewCalls: [] };
  const diff = opts.diff ?? DEFAULT_DIFF;

  const service: ScmService = {
    fetchDiff: (ref) =>
      Effect.sync(() => {
        state.fetchDiffCalls.push(ref);
        return diff;
      }),
    postReview: (note) =>
      Effect.sync(() => {
        state.postReviewCalls.push(note);
      }),
  };

  return { layer: Layer.succeed(Scm, service), state };
};

/** A ready-to-use Scm fake Layer — canned diff, records calls. */
export const ScmFake: Layer.Layer<Scm> = makeScmFake().layer;

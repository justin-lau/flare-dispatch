// @flare-dispatch/review-agent — model-output sanitizers for review comments.
//
// The security-relevant helpers that neutralize model-authored text before it
// renders in a PUBLIC review comment (a GitHub PR review, a GitLab MR note). The
// diff is attacker-controllable on a hostile change and feeds the model, so a
// finding's `title` / `message` / `path` could carry `@mention` pings, raw HTML,
// or markdown break-outs. Control flow is already safe — the verdict derives
// only from the schema-constrained `level` — this is presentation hardening.
//
// Extracted here (from `runs/pr-review.ts`'s private copies) so a second review
// run — `runs/mr-review.ts` (GitLab) — shares ONE audited implementation rather
// than a divergent copy. `pr-review` keeps its own byte-identical copies for now
// so the GitHub path stays untouched; a follow-up (specs/11-gitlab-poc.md) folds
// it onto these. The PROVIDER-SPECIFIC bit — the blob-URL fragment shape
// (`#L10-L12` on GitHub vs `#L10-12` on GitLab) — stays at each call site; only
// the provider-agnostic sanitize + path-encode live here.

import type { Finding } from "./schemas.js";

/** Max chars of model text that render in a comment cell/line. */
const SANITIZE_MAX = 500;

// U+200B zero-width space — inserted after `@` it breaks GitHub/GitLab @mention
// autolinking without visibly altering the text. Built from a code point so the
// source stays ASCII-only.
const ZWSP = String.fromCharCode(0x200b);

/**
 * Neutralize model-authored text before it renders in a public review comment:
 * collapse to one line, drop angle brackets, defang backticks + `@`, and bound
 * the length. Byte-parity with `runs/pr-review.ts`'s private `sanitizeModelText`.
 */
export const sanitizeModelText = (s: string): string =>
  s
    .replace(/[\r\n]+/g, " ")
    .replace(/[<>]/g, "")
    .replace(/`/g, "'")
    .replace(/@(?=[\w-])/g, `@${ZWSP}`)
    .slice(0, SANITIZE_MAX);

/**
 * The sanitized, URL-encoded path of a finding — the PROVIDER-AGNOSTIC core of a
 * blob URL. Each segment is sanitized then `encodeURIComponent`'d (plus manual
 * paren-encoding — `encodeURIComponent` leaves `()` alone, and a bare `)` would
 * terminate the markdown link). The caller prepends the provider's blob-URL base
 * and appends the provider's line fragment.
 */
export const encodeFindingPath = (path: string): string =>
  sanitizeModelText(path)
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29");

/**
 * `path:line` display text for a finding's location. Square brackets are stripped
 * on top of {@link sanitizeModelText} — the text renders inside `[…](url)` link
 * syntax, where a `]` would break out of the link.
 */
export const findingLoc = (f: Finding): string => {
  const path = sanitizeModelText(f.path).replace(/[[\]]/g, "");
  return f.startLine === f.endLine
    ? `${path}:${f.startLine}`
    : `${path}:${f.startLine}-${f.endLine}`;
};

/** Sanitized text safe inside a markdown table cell — an unescaped `|` would
 *  split the row. */
export const tableCell = (s: string): string =>
  sanitizeModelText(s).replace(/\|/g, "\\|");

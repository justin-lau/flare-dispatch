// Unit tests for the shared review-comment sanitizers.

import { describe, expect, it } from "vitest";
import { encodeFindingPath, findingLoc, sanitizeModelText, tableCell } from "./comment-sanitize.js";
import type { Finding } from "./schemas.js";

const finding = (over: Partial<Finding>): Finding => ({
  path: "src/x.ts",
  startLine: 1,
  endLine: 1,
  level: "notice",
  title: "t",
  message: "m",
  ...over,
});

describe("sanitizeModelText", () => {
  it("collapses newlines, strips angle brackets, defangs backticks", () => {
    expect(sanitizeModelText("a\n<b>`c`")).toBe("a b'c'");
  });
  it("defangs @mentions with a zero-width space", () => {
    const out = sanitizeModelText("@evil");
    expect(out.startsWith("@")).toBe(true);
    expect(out).not.toBe("@evil");
    expect(out.charCodeAt(1)).toBe(0x200b);
  });
  it("bounds length to 500 chars", () => {
    expect(sanitizeModelText("x".repeat(1000))).toHaveLength(500);
  });
});

describe("encodeFindingPath", () => {
  it("strips leading slashes, encodes segments, encodes parens", () => {
    expect(encodeFindingPath("/a b/c(d).ts")).toBe("a%20b/c%28d%29.ts");
  });
  it("neutralizes a path traversal / markdown break-out attempt", () => {
    // Angle brackets stripped by sanitize; the rest URL-encoded so it can't
    // break out of the markdown link.
    const out = encodeFindingPath("../<script>/x)y.ts");
    expect(out).not.toContain("<");
    expect(out).not.toContain(")");
    expect(out).toContain("%29");
  });
});

describe("findingLoc", () => {
  it("renders path:line for a single line and path:start-end for a range", () => {
    expect(findingLoc(finding({ path: "a.ts", startLine: 3, endLine: 3 }))).toBe("a.ts:3");
    expect(findingLoc(finding({ path: "a.ts", startLine: 3, endLine: 5 }))).toBe("a.ts:3-5");
  });
  it("strips square brackets (link break-out)", () => {
    expect(findingLoc(finding({ path: "a[x].ts", startLine: 1, endLine: 1 }))).toBe("ax.ts:1");
  });
});

describe("tableCell", () => {
  it("escapes pipes on top of sanitize", () => {
    expect(tableCell("a|b")).toBe("a\\|b");
  });
});

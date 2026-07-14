// Tests for mr-review retrieval grounding: the PURE query/parse/compose core
// (no network) and the effectful `fetchContext` against an msw-mocked MCP
// endpoint (the `{result:{content:[{text:"<json>"}]}}` shape).

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assembleContext,
  changedPaths,
  composeGroundedInput,
  deriveQueries,
  fetchContext,
  MAX_CONTEXT_CHARS,
  parseSearchRows,
} from "./mr-review-grounding";

const DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,2 +1,4 @@",
  " const x = 1;",
  "+import { helper } from './helper';",
  "+export const run = () => helper(compute(x));",
  "-const old = 1;",
  "diff --git a/src/bar.ts b/src/renamed.ts",
  "--- a/src/bar.ts",
  "+++ b/src/renamed.ts",
  "@@ -1 +1 @@",
  "+return doThing();",
].join("\n");

describe("changedPaths", () => {
  it("collects the new-side (b/) paths, including a rename target", () => {
    expect(changedPaths(DIFF)).toEqual(["src/foo.ts", "src/renamed.ts"]);
  });
  it("empty diff → no paths", () => {
    expect(changedPaths("")).toEqual([]);
  });
});

describe("deriveQueries", () => {
  it("extracts basenames, imported specifiers, and called identifiers", () => {
    const q = deriveQueries(DIFF);
    expect(q).toContain("foo.ts");
    expect(q).toContain("renamed.ts");
    expect(q).toContain("helper"); // both the import specifier basename and call
    expect(q).toContain("compute"); // called identifier on an added line
    expect(q).toContain("doThing");
  });
  it("drops keywords and short names, and caps at 6", () => {
    const q = deriveQueries(DIFF);
    expect(q).not.toContain("return"); // keyword
    expect(q.length).toBeLessThanOrEqual(6);
  });
  it("only looks at ADDED lines (not the removed `-const old`)", () => {
    expect(deriveQueries(DIFF)).not.toContain("old");
  });
});

describe("parseSearchRows", () => {
  it("projects {columns,rows} to {path,text} via the snippet column", () => {
    const text = JSON.stringify({
      columns: ["path", "snippet", "score"],
      rows: [
        ["src/a.ts", "const a = 1;", 0.9],
        ["src/b.ts", "const b = 2;", 0.8],
      ],
    });
    expect(parseSearchRows(text)).toEqual([
      { path: "src/a.ts", text: "const a = 1;" },
      { path: "src/b.ts", text: "const b = 2;" },
    ]);
  });
  it("falls back to the `content` column when there is no `snippet`", () => {
    const text = JSON.stringify({ columns: ["path", "content"], rows: [["x.ts", "body"]] });
    expect(parseSearchRows(text)).toEqual([{ path: "x.ts", text: "body" }]);
  });
  it("malformed / non-tabular payloads → []", () => {
    expect(parseSearchRows("not json")).toEqual([]);
    expect(parseSearchRows(JSON.stringify({ nope: 1 }))).toEqual([]);
    expect(parseSearchRows(JSON.stringify({ columns: ["x"], rows: [["y"]] }))).toEqual([]); // no path col
  });
});

describe("composeGroundedInput", () => {
  it("labels the context block as NOT part of the change and keeps the diff intact", () => {
    const out = composeGroundedInput("### ctx", "the-diff-body");
    expect(out).toContain("NOT part of the change");
    expect(out).toContain("### ctx");
    expect(out).toContain("## The merge-request diff under review");
    expect(out).toContain("the-diff-body");
    // the diff sits AFTER the context block
    expect(out.indexOf("### ctx")).toBeLessThan(out.indexOf("the-diff-body"));
  });
});

describe("assembleContext", () => {
  it("dedups by path (first occurrence wins) and fences each block", () => {
    const out = assembleContext([
      { path: "a.ts", text: "FULL" },
      { path: "a.ts", text: "snippet-should-lose" },
      { path: "b.ts", text: "other" },
    ]);
    expect(out).toContain("### a.ts");
    expect(out).toContain("FULL");
    expect(out).not.toContain("snippet-should-lose");
    expect(out).toContain("### b.ts");
  });
  it("caps total injected context near MAX_CONTEXT_CHARS", () => {
    const big = "x".repeat(MAX_CONTEXT_CHARS);
    const out = assembleContext([
      { path: "a.ts", text: big },
      { path: "b.ts", text: big },
    ]);
    // the second block would blow the cap → only the first lands
    expect(out).toContain("### a.ts");
    expect(out).not.toContain("### b.ts");
  });
});

// --- fetchContext against an msw-mocked MCP endpoint -------------------------

const ENDPOINT = "https://hakiri.test";
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/** Wrap a `{columns,rows}` table in the MCP tool-call envelope. */
const envelope = (table: unknown) =>
  HttpResponse.json({ result: { content: [{ text: JSON.stringify(table) }] } });

describe("fetchContext", () => {
  it("queries file contents + search hits, forwards the bearer token, assembles context", async () => {
    const seenAuth: string[] = [];
    const calledTools: string[] = [];
    server.use(
      http.post(`${ENDPOINT}/mcp`, async ({ request }) => {
        seenAuth.push(request.headers.get("authorization") ?? "");
        const body = (await request.json()) as {
          params: { name: string; arguments: Record<string, unknown> };
        };
        calledTools.push(body.params.name);
        if (body.params.name === "context.query") {
          // full contents of the changed file
          return envelope({
            columns: ["path", "content"],
            rows: [["src/foo.ts", "export const helper = () => 1;"]],
          });
        }
        // context.search → a snippet on a DIFFERENT path
        return envelope({
          columns: ["path", "snippet"],
          rows: [["src/other.ts", "callsite of helper"]],
        });
      }),
    );

    const out = await Effect.runPromise(
      fetchContext({
        config: { endpoint: ENDPOINT, token: "secret" },
        queries: ["helper"],
        paths: ["src/foo.ts"],
      }),
    );

    expect(out).toContain("### src/foo.ts");
    expect(out).toContain("export const helper = () => 1;");
    expect(out).toContain("### src/other.ts");
    expect(calledTools).toContain("context.query");
    expect(calledTools).toContain("context.search");
    expect(seenAuth.every((a) => a === "Bearer secret")).toBe(true);
  });

  it("best-effort: an HTTP error yields '' (never fails the review)", async () => {
    server.use(http.post(`${ENDPOINT}/mcp`, () => new HttpResponse(null, { status: 500 })));
    const out = await Effect.runPromise(
      fetchContext({ config: { endpoint: ENDPOINT }, queries: ["x"], paths: [] }),
    );
    expect(out).toBe("");
  });
});

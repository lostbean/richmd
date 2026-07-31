// CLI-level tests for the batch stdin/stdout protocol both grammar-check
// helpers speak (design.md §07, ADR-0018).
//
// Both helpers are invoked as ONE subprocess per document per kind: stdin
// carries every block of that kind, each tagged with an identifier, and
// stdout returns one verdict per identifier so a rejection names the block
// it came from. These tests drive the helpers exactly the way the Lua
// filter does — as real subprocesses over a pipe — because that pipe IS the
// interface; the in-process check functions are covered separately in
// test/mermaid-check.test.js / test/vega-lite-check.test.js.
//
// The three-outcome exit contract is the load-bearing part: 0 = every block
// valid, 1 = at least one grammar rejection, 2 = the helper itself failed.
// Outcome 2 must stay distinguishable from outcome 1, since the filter
// treats a crashed helper as a hard filter failure rather than a per-block
// rejection.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const mermaidHelper = path.join(repoRoot, "helpers", "mermaid-check.js");
const vegaLiteHelper = path.join(repoRoot, "helpers", "vega-lite-check.js");

// runHelper(helperPath, stdinText) -> { code, stdout, stderr }
//
// Spawns the helper as a real subprocess and writes stdinText to its stdin,
// mirroring the Lua filter's own io.popen invocation. Never throws on a
// non-zero exit — the exit code is the thing under test.
function runHelper(helperPath, stdinText) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [helperPath],
      { cwd: repoRoot },
      (err, stdout, stderr) => {
        resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin.end(stdinText);
  });
}

const VALID_MERMAID = "graph TD\n  A[Start] --> B[End]\n";
const INVALID_MERMAID = "graph TD\n  A ~~ B\n";

const VALID_VEGA_LITE = JSON.stringify({
  data: { values: [{ a: "A", b: 28 }] },
  mark: "bar",
  encoding: {
    x: { field: "a", type: "nominal" },
    y: { field: "b", type: "quantitative" },
  },
});
const INVALID_VEGA_LITE = JSON.stringify({ foo: "bar" });

// Both helpers speak the identical protocol, so the protocol-shape
// assertions are written once and run against each — a divergence between
// the two would be a real defect, not a stylistic difference.
const helpers = [
  {
    name: "mermaid-check.js",
    helperPath: mermaidHelper,
    valid: VALID_MERMAID,
    invalid: INVALID_MERMAID,
  },
  {
    name: "vega-lite-check.js",
    helperPath: vegaLiteHelper,
    valid: VALID_VEGA_LITE,
    invalid: INVALID_VEGA_LITE,
  },
];

for (const helper of helpers) {
  describe(`${helper.name} (batch stdin/stdout protocol)`, () => {
    it("exits 0 and returns one valid verdict per id for an all-valid batch", async () => {
      const result = await runHelper(
        helper.helperPath,
        JSON.stringify({
          blocks: [
            { id: "one", source: helper.valid },
            { id: "two", source: helper.valid },
            { id: "three", source: helper.valid },
          ],
        }),
      );
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.results.length, 3);
      assert.deepEqual(parsed.results.map((r) => r.id).sort(), [
        "one",
        "three",
        "two",
      ]);
      for (const verdict of parsed.results) {
        assert.equal(verdict.valid, true, JSON.stringify(verdict));
      }
    });

    it("exits 1 and names the rejected block by id, leaving its neighbours valid", async () => {
      const result = await runHelper(
        helper.helperPath,
        JSON.stringify({
          blocks: [
            { id: "first", source: helper.valid },
            { id: "second", source: helper.invalid },
            { id: "third", source: helper.valid },
          ],
        }),
      );
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      const byId = Object.fromEntries(parsed.results.map((r) => [r.id, r]));
      assert.equal(byId.first.valid, true);
      assert.equal(byId.third.valid, true);
      assert.equal(byId.second.valid, false);
      assert.equal(typeof byId.second.reason, "string");
      assert.ok(byId.second.reason.length > 0);
    });

    it("reports every rejection in a batch, not just the first", async () => {
      const result = await runHelper(
        helper.helperPath,
        JSON.stringify({
          blocks: [
            { id: "bad-a", source: helper.invalid },
            { id: "good", source: helper.valid },
            { id: "bad-b", source: helper.invalid },
          ],
        }),
      );
      assert.equal(result.code, 1);
      const parsed = JSON.parse(result.stdout);
      const rejected = parsed.results.filter((r) => !r.valid).map((r) => r.id);
      assert.deepEqual(rejected.sort(), ["bad-a", "bad-b"]);
    });

    it("returns every id exactly once, so verdicts pair by id and never by position", async () => {
      const result = await runHelper(
        helper.helperPath,
        JSON.stringify({
          blocks: [
            { id: "zulu", source: helper.valid },
            { id: "alpha", source: helper.invalid },
          ],
        }),
      );
      const parsed = JSON.parse(result.stdout);
      const ids = parsed.results.map((r) => r.id);
      assert.equal(ids.length, 2);
      assert.equal(new Set(ids).size, 2);
      assert.ok(ids.includes("zulu"));
      assert.ok(ids.includes("alpha"));
    });

    it("exits 0 with an empty result set for an empty batch", async () => {
      const result = await runHelper(
        helper.helperPath,
        JSON.stringify({ blocks: [] }),
      );
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.deepEqual(parsed.results, []);
    });

    // Exit 2 — the helper itself failed — must never be confused with exit
    // 1, a grammar rejection. Malformed stdin is the reachable way to
    // provoke it without breaking the installed tree.
    it("exits 2, not 1, when stdin is not a valid batch document", async () => {
      const result = await runHelper(helper.helperPath, "{ not json at all ]");
      assert.equal(result.code, 2);
    });

    it("exits 2, not 1, when stdin carries no blocks array", async () => {
      const result = await runHelper(
        helper.helperPath,
        JSON.stringify({ notBlocks: [] }),
      );
      assert.equal(result.code, 2);
    });

    it("exits 2, not 1, when a block entry is missing its id", async () => {
      const result = await runHelper(
        helper.helperPath,
        JSON.stringify({ blocks: [{ source: helper.valid }] }),
      );
      assert.equal(result.code, 2);
    });
  });
}

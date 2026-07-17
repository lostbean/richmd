// Diagram id determinism (issue #22).
//
// design.md §02's `--check` contract — "byte-compares that same result
// against the existing sibling `.html` file instead of writing it — exiting
// 0 when identical" — is only satisfiable if rendering the SAME source twice
// produces the SAME bytes. It did not, for any document containing a
// diagram: filter/blocks/mermaid.lua and filter/blocks/vega-lite.lua each
// minted a fresh random id per render, so every render of a diagram-bearing
// document differed from the last and `--check` could never exit 0, however
// fresh the committed file was.
//
// These tests assert that property through the public interface only — the
// CLI's exit codes and output bytes. Nothing here asserts a particular id
// VALUE or numbering scheme: "the two renders agree" and "the ids on one
// page are distinct" are the behaviors that matter, and an implementation is
// free to mint any id that holds them.
//
// Cases covered, mirroring the acceptance criteria:
//   1. Two renders byte-identical — a mermaid document.
//   2. Two renders byte-identical — a vega-lite document.
//   3. Two renders byte-identical — several of both in one document.
//   4. `render --check` exits 0 right after a fresh `render`, for a
//      diagram-bearing document (the issue's headline acceptance).
//   5. A multi-diagram page yields distinct ids (N diagrams -> N distinct
//      ids), mermaid and vega ids never colliding with each other.
//   6. `--offline` renders are deterministic too.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      { cwd: repoRoot },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

const MERMAID_DOC = [
  "# Mermaid page",
  "",
  '```{.mermaid title="Flow"}',
  "graph TD",
  "    A[Start] --> B[End]",
  "```",
  "",
].join("\n");

const VEGA_DOC = [
  "# Vega page",
  "",
  '```{.vega-lite title="Events"}',
  "{",
  '  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",',
  '  "data": { "values": [{ "a": "A", "b": 28 }, { "a": "B", "b": 55 }] },',
  '  "mark": "bar",',
  '  "encoding": {',
  '    "x": { "field": "a", "type": "nominal" },',
  '    "y": { "field": "b", "type": "quantitative" }',
  "  }",
  "}",
  "```",
  "",
].join("\n");

// Two of each kind, interleaved — the shape that would expose both a
// collision between the two renderers' id spaces and any cross-diagram
// coupling within one document.
const MIXED_DOC = [
  "# Mixed page",
  "",
  "```{.mermaid}",
  "graph TD",
  "    A[One] --> B[Two]",
  "```",
  "",
  "```{.vega-lite}",
  "{",
  '  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",',
  '  "data": { "values": [{ "a": "A", "b": 28 }] },',
  '  "mark": "bar",',
  '  "encoding": {',
  '    "x": { "field": "a", "type": "nominal" },',
  '    "y": { "field": "b", "type": "quantitative" }',
  "  }",
  "}",
  "```",
  "",
  "```{.mermaid}",
  "graph LR",
  "    C[Three] --> D[Four]",
  "```",
  "",
  "```{.vega-lite}",
  "{",
  '  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",',
  '  "data": { "values": [{ "a": "B", "b": 55 }] },',
  '  "mark": "line",',
  '  "encoding": {',
  '    "x": { "field": "a", "type": "nominal" },',
  '    "y": { "field": "b", "type": "quantitative" }',
  "  }",
  "}",
  "```",
  "",
].join("\n");

// Renders `source` twice into a throwaway dir, returning both renders' bytes.
// The .html is read (and the render repeated) through the real CLI — no
// filter internals, no mocking, exactly the suite's existing convention.
async function renderTwice(t, name, source, extraArgs = []) {
  const workDir = await mkdtemp(
    path.join(tmpdir(), `richmd-determinism-${name}-`),
  );
  try {
    const mdPath = path.join(workDir, `${name}.md`);
    const htmlPath = path.join(workDir, `${name}.html`);
    await writeFile(mdPath, source);

    const first = await runCli(["render", mdPath, ...extraArgs]);
    assert.equal(first.code, 0, `first render failed: ${first.stderr}`);
    const firstHtml = await readFile(htmlPath, "utf8");

    const second = await runCli(["render", mdPath, ...extraArgs]);
    assert.equal(second.code, 0, `second render failed: ${second.stderr}`);
    const secondHtml = await readFile(htmlPath, "utf8");

    return { firstHtml, secondHtml };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

describe("richmd render (diagram id determinism)", () => {
  it("renders a mermaid document byte-identically twice", async (t) => {
    const { firstHtml, secondHtml } = await renderTwice(
      t,
      "mermaid",
      MERMAID_DOC,
    );
    assert.equal(secondHtml, firstHtml);
  });

  it("renders a vega-lite document byte-identically twice", async (t) => {
    const { firstHtml, secondHtml } = await renderTwice(t, "vega", VEGA_DOC);
    assert.equal(secondHtml, firstHtml);
  });

  it("renders a mixed multi-diagram document byte-identically twice", async (t) => {
    const { firstHtml, secondHtml } = await renderTwice(t, "mixed", MIXED_DOC);
    assert.equal(secondHtml, firstHtml);
  });

  it("renders byte-identically twice with --offline", async (t) => {
    const { firstHtml, secondHtml } = await renderTwice(
      t,
      "offline",
      MIXED_DOC,
      ["--offline"],
    );
    assert.equal(secondHtml, firstHtml);
  });
});

describe("richmd render --check (diagram-bearing document)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-determinism-check-"));
    mdPath = path.join(workDir, "mixed.md");
    await writeFile(mdPath, MIXED_DOC);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 immediately after a fresh render", async () => {
    const render = await runCli(["render", mdPath]);
    assert.equal(render.code, 0, `render failed: ${render.stderr}`);

    const check = await runCli(["render", mdPath, "--check"]);
    assert.equal(check.code, 0, `stderr was: ${check.stderr}`);
  });

  it("exits 0 immediately after a fresh --offline render, checked with --offline", async () => {
    const render = await runCli(["render", mdPath, "--offline"]);
    assert.equal(render.code, 0, `render failed: ${render.stderr}`);

    const check = await runCli(["render", mdPath, "--check", "--offline"]);
    assert.equal(check.code, 0, `stderr was: ${check.stderr}`);
  });
});

describe("richmd render (diagram ids are unique within a page)", () => {
  let html;

  before(async () => {
    const workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-determinism-unique-"),
    );
    try {
      const mdPath = path.join(workDir, "mixed.md");
      await writeFile(mdPath, MIXED_DOC);
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `render failed: ${result.stderr}`);
      html = await readFile(path.join(workDir, "mixed.html"), "utf8");
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("gives each of the page's two mermaid diagrams its own id", () => {
    const ids = [...html.matchAll(/id="(richmd-mermaid-[^"-]+)"/g)].map(
      (m) => m[1],
    );
    assert.equal(ids.length, 2, `found ids: ${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids}`);
  });

  it("gives each of the page's two vega charts its own id", () => {
    const ids = [...html.matchAll(/id="(richmd-vega-[^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.equal(ids.length, 2, `found ids: ${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, ids.length, `ids collided: ${ids}`);
  });

  it("never reuses one id for two different elements anywhere on the page", () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(
      new Set(ids).size,
      ids.length,
      `duplicate element id on the page: ${ids}`,
    );
  });
});

// End-to-end tests for per-document batch grammar validation
// (design.md §07, ADR-0018), driven through the real `richmd` CLI.
//
// The behavior under test is that each grammar validator is invoked as ONE
// subprocess per document per kind — not once per block — while everything
// the fail-closed gate promises stays exactly as it was: a rejection names
// its own block with the parser's own reason, every rejection in a document
// is reported, and a helper that cannot run is a hard filter failure rather
// than a silent pass.
//
// The subprocess count is asserted OBSERVABLY, not by reading the filter's
// source: ADR-0001 fixes that the Lua filter reaches its helpers as a bare
// `node` resolved through PATH, so a recording shim placed earlier on PATH
// sees every helper invocation the filter actually makes. Nothing is mocked
// — the shim execs the real `node` on the real helper and the real check
// runs; it only keeps a tally on the way through.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  chmod,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");

const VALID_MERMAID = "graph TD\n    A[Start] --> B[End]";
const MALFORMED_MERMAID = "graph TD\n    A -->";

function vegaLiteSpec(field) {
  return JSON.stringify(
    {
      data: { values: [{ a: "A", b: 28 }] },
      mark: "bar",
      encoding: {
        x: { field, type: "nominal" },
        y: { field: "b", type: "quantitative" },
      },
    },
    null,
    2,
  );
}

// A spec that is valid JSON but does not conform to the vega-lite schema.
const MALFORMED_VEGA_LITE = JSON.stringify(
  { notAVegaLiteField: true },
  null,
  2,
);

function mermaidBlock(source) {
  return "```mermaid\n" + source + "\n```";
}

function vegaLiteBlock(source) {
  return "```vega-lite\n" + source + "\n```";
}

describe("batch grammar validation (design.md §07, ADR-0018)", () => {
  let workDir;
  let binDir;
  let logPath;

  // A `node` shim that appends its own argv to a log, then execs the real
  // node. Placed first on PATH, it intercepts exactly the invocations the
  // Lua filter makes — `node <helper> < <batch file>` — and nothing else,
  // because bin/richmd.js itself is already running under the real node by
  // the time the shim exists on PATH.
  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-batch-validation-"));
    binDir = path.join(workDir, "shim-bin");
    logPath = path.join(workDir, "node-invocations.log");

    await execFileAsync("mkdir", ["-p", binDir]);
    const shimPath = path.join(binDir, "node");
    await writeFile(
      shimPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(logPath)}\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    );
    await chmod(shimPath, 0o755);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // runWithShim(markdown, name) -> { code, stderr, helperCalls }
  //
  // Writes `markdown` to its own file, renders it with the recording shim
  // first on PATH, and reports how many times each helper was invoked.
  async function runWithShim(markdown, name) {
    const mdPath = path.join(workDir, `${name}.md`);
    await writeFile(mdPath, markdown);
    await writeFile(logPath, "");

    let code = 0;
    let stderr = "";
    try {
      const result = await execFileAsync(
        process.execPath,
        [cliPath, "render", mdPath],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
          },
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      stderr = result.stderr;
    } catch (err) {
      code = err.code ?? 1;
      stderr = err.stderr ?? "";
    }

    const log = await readFile(logPath, "utf8");
    const lines = log.split("\n").filter((line) => line.trim() !== "");
    return {
      code,
      stderr,
      htmlPath: path.join(workDir, `${name}.html`),
      mermaidCalls: lines.filter((line) => line.includes("mermaid-check.js"))
        .length,
      vegaLiteCalls: lines.filter((line) => line.includes("vega-lite-check.js"))
        .length,
    };
  }

  it("spawns exactly one mermaid helper for a document with three mermaid blocks", async () => {
    const markdown = [
      "# Three diagrams",
      "",
      mermaidBlock(VALID_MERMAID),
      "",
      mermaidBlock("sequenceDiagram\n    Alice->>Bob: Hello"),
      "",
      mermaidBlock("graph LR\n    X --> Y"),
      "",
    ].join("\n");

    const result = await runWithShim(markdown, "three-mermaid");
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.equal(result.mermaidCalls, 1);
  });

  it("spawns exactly one vega-lite helper for a document with three vega-lite blocks", async () => {
    const markdown = [
      "# Three charts",
      "",
      vegaLiteBlock(vegaLiteSpec("a")),
      "",
      vegaLiteBlock(vegaLiteSpec("b")),
      "",
      vegaLiteBlock(vegaLiteSpec("c")),
      "",
    ].join("\n");

    const result = await runWithShim(markdown, "three-vega-lite");
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.equal(result.vegaLiteCalls, 1);
  });

  it("spawns one helper of each kind for a document mixing both kinds", async () => {
    const markdown = [
      "# Mixed",
      "",
      mermaidBlock(VALID_MERMAID),
      "",
      vegaLiteBlock(vegaLiteSpec("a")),
      "",
      mermaidBlock("graph LR\n    X --> Y"),
      "",
      vegaLiteBlock(vegaLiteSpec("b")),
      "",
    ].join("\n");

    const result = await runWithShim(markdown, "mixed-kinds");
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.equal(result.mermaidCalls, 1);
    assert.equal(result.vegaLiteCalls, 1);
  });

  it("spawns no helper of a kind the document contains no blocks of", async () => {
    const markdown = [
      "# Only mermaid",
      "",
      mermaidBlock(VALID_MERMAID),
      "",
    ].join("\n");

    const result = await runWithShim(markdown, "mermaid-only");
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.equal(result.mermaidCalls, 1);
    assert.equal(result.vegaLiteCalls, 0);
  });

  it("spawns neither helper for a document with no diagram or chart blocks at all", async () => {
    const markdown = [
      "# Plain prose",
      "",
      "Just a paragraph, no diagrams.",
      "",
    ].join("\n");

    const result = await runWithShim(markdown, "no-blocks");
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.equal(result.mermaidCalls, 0);
    assert.equal(result.vegaLiteCalls, 0);
  });

  // A `chart` block expands to a vega-lite spec that goes through the same
  // grammar validator (design.md §05 Interface) — it must ride in the SAME
  // single subprocess as hand-authored vega-lite blocks, not a second one.
  it("checks a chart block's expanded spec in the same single vega-lite helper invocation", async () => {
    const markdown = [
      "# Chart plus hand-authored chart",
      "",
      vegaLiteBlock(vegaLiteSpec("a")),
      "",
      '::: {.chart type="bar"}',
      "",
      "| Month | Count |",
      "| ----- | ----- |",
      "| Jan   | 3     |",
      "| Feb   | 5     |",
      "",
      ":::",
      "",
    ].join("\n");

    const result = await runWithShim(markdown, "chart-plus-vega");
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.equal(result.vegaLiteCalls, 1);
  });

  describe("a malformed block among valid ones", () => {
    it("names the malformed mermaid block's own reason and writes no HTML", async () => {
      const markdown = [
        "# Second one is broken",
        "",
        mermaidBlock(VALID_MERMAID),
        "",
        mermaidBlock(MALFORMED_MERMAID),
        "",
        mermaidBlock("graph LR\n    X --> Y"),
        "",
      ].join("\n");

      const result = await runWithShim(markdown, "second-malformed");
      assert.notEqual(result.code, 0);
      assert.equal(result.mermaidCalls, 1);
      assert.match(result.stderr, /mermaid/);
      // The parser's own reason, not a generic "invalid mermaid".
      assert.match(result.stderr, /[Pp]arse error/);
      // Exactly ONE mermaid error: the two valid neighbours must not be
      // dragged down with the malformed one.
      const mermaidErrors = result.stderr
        .split("\n")
        .filter((line) => line.includes("invalid mermaid syntax"));
      assert.equal(mermaidErrors.length, 1, result.stderr);
      await assert.rejects(() => access(result.htmlPath));
    });

    it("names the malformed vega-lite block's own reason and leaves its neighbours unreported", async () => {
      const markdown = [
        "# Second chart is broken",
        "",
        vegaLiteBlock(vegaLiteSpec("a")),
        "",
        vegaLiteBlock(MALFORMED_VEGA_LITE),
        "",
        vegaLiteBlock(vegaLiteSpec("c")),
        "",
      ].join("\n");

      const result = await runWithShim(markdown, "vega-second-malformed");
      assert.notEqual(result.code, 0);
      assert.equal(result.vegaLiteCalls, 1);
      const vegaErrors = result.stderr
        .split("\n")
        .filter((line) => line.includes("invalid vega-lite spec"));
      assert.equal(vegaErrors.length, 1, result.stderr);
      assert.match(vegaErrors[0], /vega-lite/);
    });
  });

  describe("two malformed blocks in one document", () => {
    it("reports both malformed mermaid blocks, not just the first", async () => {
      const markdown = [
        "# Two broken diagrams",
        "",
        mermaidBlock(MALFORMED_MERMAID),
        "",
        mermaidBlock(VALID_MERMAID),
        "",
        mermaidBlock("graph TD\n    A ~~ B"),
        "",
      ].join("\n");

      const result = await runWithShim(markdown, "two-malformed-mermaid");
      assert.notEqual(result.code, 0);
      assert.equal(result.mermaidCalls, 1);
      const mermaidErrors = result.stderr
        .split("\n")
        .filter((line) => line.includes("invalid mermaid syntax"));
      assert.equal(mermaidErrors.length, 2, result.stderr);
      // Each error carries its OWN reason, not one reason copied twice —
      // the two malformed diagrams fail in different ways.
      assert.notEqual(mermaidErrors[0], mermaidErrors[1]);
    });

    it("reports a malformed block of each kind in one run", async () => {
      const markdown = [
        "# One of each broken",
        "",
        mermaidBlock(MALFORMED_MERMAID),
        "",
        vegaLiteBlock(MALFORMED_VEGA_LITE),
        "",
      ].join("\n");

      const result = await runWithShim(markdown, "one-broken-each");
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /invalid mermaid syntax/);
      assert.match(result.stderr, /invalid vega-lite spec/);
    });
  });

  // design.md §07: "a validator subprocess crashing unexpectedly is itself a
  // hard filter failure, distinct from a normal grammar rejection". A
  // crashed helper must never read as "everything checked out", and must
  // stay tellable apart from a rejected diagram.
  describe("a validator subprocess that cannot run", () => {
    let crashBinDir;

    before(async () => {
      crashBinDir = path.join(workDir, "crash-bin");
      await execFileAsync("mkdir", ["-p", crashBinDir]);
      const crashShim = path.join(crashBinDir, "node");
      // Exits 2 — the helper-failure code — with a stack-trace-shaped
      // message on stderr, exactly as a helper that blew up on startup
      // would. bin/richmd.js is already running under the real node, so
      // only the filter's own helper invocations hit this.
      await writeFile(
        crashShim,
        "#!/bin/sh\necho 'Error: helper exploded on startup' >&2\nexit 2\n",
      );
      await chmod(crashShim, 0o755);
    });

    async function runWithCrashingHelper(markdown, name) {
      const mdPath = path.join(workDir, `${name}.md`);
      await writeFile(mdPath, markdown);
      try {
        const result = await execFileAsync(
          process.execPath,
          [cliPath, "render", mdPath],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              PATH: `${crashBinDir}${path.delimiter}${process.env.PATH}`,
            },
            maxBuffer: 64 * 1024 * 1024,
          },
        );
        return { code: 0, stderr: result.stderr };
      } catch (err) {
        return { code: err.code ?? 1, stderr: err.stderr ?? "" };
      }
    }

    it("fails the filter and writes no HTML rather than passing the blocks through", async () => {
      const markdown = [
        "# Valid diagram",
        "",
        mermaidBlock(VALID_MERMAID),
        "",
      ].join("\n");
      const result = await runWithCrashingHelper(markdown, "helper-crash");

      assert.notEqual(result.code, 0);
      await assert.rejects(() =>
        access(path.join(workDir, "helper-crash.html")),
      );
    });

    it("reads as a helper failure, distinguishable from a grammar rejection", async () => {
      const markdown = [
        "# Valid diagram",
        "",
        mermaidBlock(VALID_MERMAID),
        "",
      ].join("\n");
      const result = await runWithCrashingHelper(
        markdown,
        "helper-crash-reason",
      );

      // The helper is named as the thing that failed. A grammar rejection
      // reports the parser's own reason instead ("Parse error on line ..."),
      // which a perfectly valid diagram like this one could never produce.
      assert.match(result.stderr, /mermaid-check helper/);
      assert.doesNotMatch(result.stderr, /[Pp]arse error on line/);
    });
  });
});

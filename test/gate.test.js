import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");
const fixturesDir = path.join(__dirname, "fixtures");

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

// This test proves the fail-closed gate (design.md §00 invariant): the
// render phase must be structurally unreachable when the validate phase's
// error list is non-empty. A callout with an out-of-enum `tint` value is
// the thinnest input that exercises this — the CLI-level polish (clear
// user-facing messages, `richmd validate`) is chunk 2's job; this test only
// proves the gate itself is real, not a straight-line script that always
// renders.
describe("richmd render (callout, invalid tint) — fail-closed gate", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-invalid-"));
    mdPath = path.join(workDir, "callout-invalid-tint.md");
    htmlPath = path.join(workDir, "callout-invalid-tint.html");
    await cp(path.join(fixturesDir, "callout-invalid-tint.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("writes zero HTML — no sibling .html file at all", async () => {
    await assert.rejects(() => access(htmlPath));
  });

  it("reports the invalid tint value on stderr", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /tint/);
    assert.match(result.stderr, /not-a-real-tint/);
  });
});

// This test proves the "all errors collected, never fail-fast" invariant
// (design.md §00) with a real multi-error document: TWO independent
// malformed callout blocks, each with a different bad `tint` value. If the
// validate phase stopped at the first error, only one of the two distinct
// tint values would ever appear on stderr.
describe("richmd render (callout, two independent invalid blocks) — all errors collected", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-two-invalid-"));
    mdPath = path.join(workDir, "callout-two-invalid.md");
    htmlPath = path.join(workDir, "callout-two-invalid.html");
    await cp(path.join(fixturesDir, "callout-two-invalid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("writes zero HTML", async () => {
    await assert.rejects(() => access(htmlPath));
  });

  it("reports BOTH distinct invalid tint values on stderr in one run", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /not-a-real-tint/);
    assert.match(result.stderr, /also-not-real/);
  });

  it("reports two separate error lines, not just one", async () => {
    const result = await runCli(["render", mdPath]);
    // "richmd: [" (not just "richmd: ") specifically matches the
    // "richmd: [<kind>] <location>: <reason>" error-line shape
    // (USAGE_RULES.md "Failure behavior") — distinct from the unconditional
    // "richmd: config directory resolved to '...'" line every invocation
    // now also prints (ADR-0009), which is not an error and must not be
    // counted here.
    const errorLines = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("richmd: ["));
    assert.equal(
      errorLines.length,
      2,
      `expected 2 error lines, got: ${JSON.stringify(errorLines)}`,
    );
  });
});

// A document mixing one valid callout and one malformed callout: only the
// malformed block's error should appear, and — because the fail-closed gate
// is document-wide, not per-block — zero HTML is written at all, even
// though one of the two blocks was individually valid.
describe("richmd render (callout, one valid + one invalid) — gate is document-wide", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-mixed-"));
    mdPath = path.join(workDir, "callout-mixed-valid-invalid.md");
    htmlPath = path.join(workDir, "callout-mixed-valid-invalid.html");
    await cp(path.join(fixturesDir, "callout-mixed-valid-invalid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("writes zero HTML — the valid callout is not partially rendered", async () => {
    await assert.rejects(() => access(htmlPath));
  });

  it("reports only the malformed block's error, not a generic message", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /tint/);
    assert.match(result.stderr, /not-a-real-tint/);

    // "richmd: [" excludes the unconditional
    // "richmd: config directory resolved to '...'" line (ADR-0009) every
    // invocation now also prints — see the identical note above.
    const errorLines = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("richmd: ["));
    assert.equal(
      errorLines.length,
      1,
      `expected exactly 1 error line (the valid block must not error), got: ${JSON.stringify(errorLines)}`,
    );
  });
});

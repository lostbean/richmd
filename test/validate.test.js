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

// `richmd validate` runs the same fail-closed gate as `richmd render`, but
// must NEVER write HTML — not even on a fully valid document (design.md
// §02 CLI entry). This is the distinguishing behavior from `render`.
describe("richmd validate (callout, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-validate-valid-"));
    mdPath = path.join(workDir, "callout-valid.md");
    htmlPath = path.join(workDir, "callout-valid.html");
    await cp(path.join(fixturesDir, "callout-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 on a valid document", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("writes NO sibling .html file even though validation passed", async () => {
    await runCli(["validate", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd validate (callout, invalid tint)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-validate-invalid-"));
    mdPath = path.join(workDir, "callout-invalid-tint.md");
    htmlPath = path.join(workDir, "callout-invalid-tint.html");
    await cp(path.join(fixturesDir, "callout-invalid-tint.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("prints the error to stderr", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.match(result.stderr, /tint/);
    assert.match(result.stderr, /not-a-real-tint/);
  });

  it("writes no HTML", async () => {
    await runCli(["validate", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

// Same all-errors-collected proof as gate.test.js, but through the
// `validate` subcommand specifically — the acceptance criteria require this
// to hold for either subcommand, not just `render`.
describe("richmd validate (callout, two independent invalid blocks)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-two-invalid-"),
    );
    mdPath = path.join(workDir, "callout-two-invalid.md");
    await cp(path.join(fixturesDir, "callout-two-invalid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and reports both distinct invalid tint values", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not-a-real-tint/);
    assert.match(result.stderr, /also-not-real/);
  });
});

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

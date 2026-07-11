import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, readFile, access } from "node:fs/promises";
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
    // execFile rejects on non-zero exit; surface the same shape.
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("richmd render (callout, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-valid-"));
    mdPath = path.join(workDir, "callout-valid.md");
    htmlPath = path.join(workDir, "callout-valid.html");
    await cp(path.join(fixturesDir, "callout-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath); // throws if missing
  });

  it("writes HTML containing the callout body text", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /This is a valid callout body\./);
  });

  it("writes HTML containing a --richmd- themed style block", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<style/);
    assert.match(html, /--richmd-/);
  });
});

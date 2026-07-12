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
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("richmd render (stat-tile, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-stat-tile-valid-"),
    );
    mdPath = path.join(workDir, "stat-tile-valid.md");
    htmlPath = path.join(workDir, "stat-tile-valid.html");
    await cp(path.join(fixturesDir, "stat-tile-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("writes HTML containing the value prominently and the label beneath", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /class="richmd-stat-tile"/);
    assert.match(html, /richmd-stat-tile__value"[^>]*>\s*42/);
    assert.match(html, /richmd-stat-tile__label"[^>]*>\s*widgets shipped/);
  });
});

describe("richmd validate (stat-tile, missing required label)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-stat-tile-missing-label-"),
    );
    mdPath = path.join(workDir, "stat-tile-missing-label.md");
    await cp(path.join(fixturesDir, "stat-tile-missing-label.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the missing 'label' attr", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /missing required attr 'label'/);
  });
});

describe("richmd validate (stat-tile, forbidden body present)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-stat-tile-forbidden-body-"),
    );
    mdPath = path.join(workDir, "stat-tile-forbidden-body.md");
    await cp(path.join(fixturesDir, "stat-tile-forbidden-body.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and reports the forbidden body", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /body is forbidden but content was present/);
  });
});

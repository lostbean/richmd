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

  it("writes HTML containing the value prominently and the label beneath, wrapped in a stat grid", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /class="richmd-stat-grid"/);
    assert.match(html, /class="richmd-stat"/);
    assert.match(html, /richmd-stat-value"[^>]*>\s*42/);
    assert.match(html, /richmd-stat-label"[^>]*>\s*widgets shipped/);
  });

  it("does not render a delta div when none was authored", async () => {
    const html = await readFile(htmlPath, "utf8");
    // Scope to the rendered stat tile markup, not the inlined theme
    // stylesheet, which legitimately contains `.richmd-stat-delta` rules.
    const bodyMatch = html.match(/<body>[\s\S]*<\/body>/);
    assert.ok(bodyMatch, "expected an HTML <body> to be present");
    assert.doesNotMatch(bodyMatch[0], /class="richmd-stat-delta/);
  });
});

describe("richmd render (stat-tile, with delta/dir)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-stat-tile-delta-"),
    );
    mdPath = path.join(workDir, "stat-tile-delta.md");
    htmlPath = path.join(workDir, "stat-tile-delta.html");
    await cp(path.join(fixturesDir, "stat-tile-delta.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("renders an up-trend delta with the direction modifier class", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /class="richmd-stat-grid"/);
    assert.match(html, /class="richmd-stat"/);
    assert.match(html, /richmd-stat-value"[^>]*>\s*6\.4M/);
    assert.match(html, /richmd-stat-label"[^>]*>\s*Events \/ day/);
    assert.match(
      html,
      /richmd-stat-delta richmd-stat-delta--up"[^>]*>\s*↑ 12% vs last wk/,
    );
  });
});

describe("richmd validate (stat-tile, invalid dir value)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-stat-tile-invalid-dir-"),
    );
    mdPath = path.join(workDir, "stat-tile-invalid-dir.md");
    await cp(path.join(fixturesDir, "stat-tile-invalid-dir.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the invalid 'dir' value", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /attr 'dir' has invalid value 'sideways'/);
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

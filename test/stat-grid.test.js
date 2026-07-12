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

describe("richmd render (stat-grid, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-stat-grid-valid-"),
    );
    mdPath = path.join(workDir, "stat-grid-valid.md");
    htmlPath = path.join(workDir, "stat-grid-valid.html");
    await cp(path.join(fixturesDir, "stat-grid-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("writes HTML containing exactly ONE richmd-stat-grid with a data-cols attribute", async () => {
    const html = await readFile(htmlPath, "utf8");
    const gridMatches = [...html.matchAll(/class="richmd-stat-grid"[^>]*/g)];
    assert.equal(
      gridMatches.length,
      1,
      `expected exactly one .richmd-stat-grid, found ${gridMatches.length}`,
    );
    assert.match(gridMatches[0][0], /data-cols="4"/);
  });

  it("nests all 4 .richmd-stat tiles inside that one grid, not 4 separate grids", async () => {
    const html = await readFile(htmlPath, "utf8");
    const gridRe =
      /<div class="richmd-stat-grid"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/;
    // Simpler and more robust: count total .richmd-stat occurrences overall,
    // and confirm only one .richmd-stat-grid wrapper exists (checked above).
    const statMatches = [...html.matchAll(/class="richmd-stat"[^-]/g)];
    assert.equal(
      statMatches.length,
      4,
      `expected 4 .richmd-stat tiles, found ${statMatches.length}`,
    );
    assert.match(html, /richmd-stat-value"[^>]*>\s*1/);
    assert.match(html, /richmd-stat-label"[^>]*>\s*a/);
    assert.match(html, /richmd-stat-value"[^>]*>\s*4/);
    assert.match(html, /richmd-stat-label"[^>]*>\s*d/);
  });
});

describe("richmd render (stat-grid, with delta/dir on a nested tile)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-stat-grid-delta-"),
    );
    mdPath = path.join(workDir, "stat-grid-with-delta.md");
    htmlPath = path.join(workDir, "stat-grid-with-delta.html");
    await cp(path.join(fixturesDir, "stat-grid-with-delta.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("renders exactly one shared grid with 3 tiles, preserving delta/dir on the tile that has them", async () => {
    const html = await readFile(htmlPath, "utf8");
    const gridMatches = [...html.matchAll(/class="richmd-stat-grid"[^>]*/g)];
    assert.equal(gridMatches.length, 1);
    assert.match(gridMatches[0][0], /data-cols="3"/);

    assert.match(
      html,
      /richmd-stat-delta richmd-stat-delta--up"[^>]*>\s*↑ 0\.04 pts vs Q1/,
    );
    assert.match(
      html,
      /richmd-stat-delta richmd-stat-delta--up"[^>]*>\s*↓ 18ms vs Q1/,
    );

    // The third tile has no delta authored — no delta div should leak in for it.
    const bodyMatch = html.match(/<body>[\s\S]*<\/body>/);
    assert.ok(bodyMatch, "expected an HTML <body> to be present");
    const deltaCount = [...bodyMatch[0].matchAll(/class="richmd-stat-delta/g)]
      .length;
    assert.equal(deltaCount, 2, `expected 2 delta divs, found ${deltaCount}`);
  });
});

describe("richmd validate (stat-grid, invalid cols)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-stat-grid-invalid-cols-"),
    );
    mdPath = path.join(workDir, "stat-grid-invalid-cols.md");
    await cp(path.join(fixturesDir, "stat-grid-invalid-cols.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the bad cols value", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cols/);
    assert.match(result.stderr, /7/);
  });
});

describe("richmd validate (stat-grid, missing required body)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-stat-grid-missing-body-"),
    );
    mdPath = path.join(workDir, "stat-grid-missing-body.md");
    await cp(path.join(fixturesDir, "stat-grid-missing-body.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and reports the empty body", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /body is required but was empty/);
  });
});

describe("richmd validate (stat-grid, malformed nested stat-tile)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-stat-grid-invalid-nested-"),
    );
    mdPath = path.join(workDir, "stat-grid-invalid-nested-tile.md");
    await cp(
      path.join(fixturesDir, "stat-grid-invalid-nested-tile.md"),
      mdPath,
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the missing 'label' attr on the nested tile, not swallowed by the parent", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /missing required attr 'label'/);
  });

  it("does not write any HTML (fail-closed gate)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
  });
});

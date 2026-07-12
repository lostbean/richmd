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

describe("richmd render (cards, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-cards-valid-"));
    mdPath = path.join(workDir, "cards-valid.md");
    htmlPath = path.join(workDir, "cards-valid.html");
    await cp(path.join(fixturesDir, "cards-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("writes HTML containing a card-grid div with a data-cols attribute", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /class="richmd-card-grid"[^>]*data-cols="3"/);
  });

  it("writes HTML containing one .richmd-card per heading, each with its own title and body", async () => {
    const html = await readFile(htmlPath, "utf8");
    const cardRe =
      /<div class="richmd-card">\s*<div class="richmd-card-title">\s*([^<]*?)\s*<\/div>\s*<div class="richmd-card-body">\s*<p>([\s\S]*?)<\/p>\s*<\/div>\s*<\/div>/g;
    const cards = [...html.matchAll(cardRe)];
    assert.equal(
      cards.length,
      3,
      `expected 3 .richmd-card divs, found ${cards.length}`,
    );
    assert.equal(cards[0][1], "First card");
    assert.match(cards[0][2], /Body text for the first card\./);
    assert.equal(cards[1][1], "Second card");
    assert.match(cards[1][2], /Body text for the second card\./);
    assert.equal(cards[2][1], "Third card");
    assert.match(cards[2][2], /Body text for the third card\./);
  });
});

describe("richmd validate (cards, invalid cols)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-cards-invalid-"),
    );
    mdPath = path.join(workDir, "cards-invalid-cols.md");
    await cp(path.join(fixturesDir, "cards-invalid-cols.md"), mdPath);
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

describe("richmd validate (cards, missing required body)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-cards-missing-body-"),
    );
    mdPath = path.join(workDir, "cards-missing-body.md");
    await cp(path.join(fixturesDir, "cards-missing-body.md"), mdPath);
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

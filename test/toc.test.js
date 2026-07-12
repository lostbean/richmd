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

describe("richmd render (toc, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-toc-valid-"));
    mdPath = path.join(workDir, "toc-valid.md");
    htmlPath = path.join(workDir, "toc-valid.html");
    await cp(path.join(fixturesDir, "toc-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("generates a real table of contents from the document's own headings", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /class="richmd-toc"/);
    assert.match(html, /<div class="richmd-toc-title">Contents<\/div>/);
    assert.match(html, /<ul class="richmd-toc-list">/);
    // Every non-TOC heading in the fixture must appear as a link target,
    // each wrapped in its own <li>.
    assert.match(
      html,
      /<li class="richmd-toc-sub"><a href="#second-heading">Second Heading<\/a><\/li>/,
    );
    assert.match(
      html,
      /<li class="richmd-toc-sub"><a href="#third-heading">Third Heading<\/a><\/li>/,
    );
    // The TOC's own generated link targets must resolve to real heading ids
    // in the SAME page (same slugify function, §00 invariant).
    assert.match(html, /<h2 id="second-heading">/);
    assert.match(html, /<h3 id="nested-heading">/);
  });

  it("marks sub-level entries (deeper than the shallowest collected heading) with richmd-toc-sub", async () => {
    const html = await readFile(htmlPath, "utf8");
    // Top Heading (H1) is the shallowest level present in the fixture -> top
    // tier, no richmd-toc-sub modifier.
    assert.match(html, /<li><a href="#top-heading">Top Heading<\/a><\/li>/);
    // Second/Third Heading (H2) and Nested Heading (H3) are all deeper than
    // the shallowest collected level (H1) -> sub tier, same modifier class
    // regardless of exactly how much deeper (two-tier, not one class per
    // level).
    assert.match(
      html,
      /<li class="richmd-toc-sub"><a href="#second-heading">Second Heading<\/a><\/li>/,
    );
    assert.match(
      html,
      /<li class="richmd-toc-sub"><a href="#nested-heading">Nested Heading<\/a><\/li>/,
    );
  });
});

describe("richmd render (toc, max-depth + shallowest-level-is-top tiering)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-toc-max-depth-"),
    );
    mdPath = path.join(workDir, "toc-max-depth.md");
    htmlPath = path.join(workDir, "toc-max-depth.html");
    await cp(path.join(fixturesDir, "toc-max-depth.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("filters out headings deeper than max-depth, unchanged from before", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<li><a href="#section-one">Section One<\/a><\/li>/);
    assert.match(html, /<li><a href="#section-two">Section Two<\/a><\/li>/);
    // "Sub Section" is an H3, excluded by max-depth="2" — must not appear
    // anywhere inside the generated <ul>.
    assert.doesNotMatch(html, /richmd-toc-list">.*Sub Section.*<\/ul>/s);
  });

  it("treats the shallowest collected level (H2 here, no H1 present) as the top tier", async () => {
    const html = await readFile(htmlPath, "utf8");
    // With max-depth="2" and no H1 in this fixture, H2 is the shallowest
    // level actually collected -> top tier, no richmd-toc-sub modifier.
    assert.match(html, /<li><a href="#section-one">Section One<\/a><\/li>/);
    assert.match(html, /<li><a href="#section-two">Section Two<\/a><\/li>/);
  });
});

describe("richmd validate (toc, forbidden body present)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-toc-forbidden-body-"),
    );
    mdPath = path.join(workDir, "toc-forbidden-body.md");
    await cp(path.join(fixturesDir, "toc-forbidden-body.md"), mdPath);
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

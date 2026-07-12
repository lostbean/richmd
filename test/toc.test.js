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
    // Every non-TOC heading in the fixture must appear as a link target.
    assert.match(html, /<a href="#second-heading">Second Heading<\/a>/);
    assert.match(html, /<a href="#third-heading">Third Heading<\/a>/);
    assert.match(html, /<a href="#nested-heading">Nested Heading<\/a>/);
    // The TOC's own generated link targets must resolve to real heading ids
    // in the SAME page (same slugify function, §00 invariant).
    assert.match(html, /<h2 id="second-heading">/);
    assert.match(html, /<h3 id="nested-heading">/);
  });

  it("reflects heading nesting via a per-level class", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /richmd-toc__item--level-1/); // Top Heading
    assert.match(html, /richmd-toc__item--level-2/); // Second/Third Heading
    assert.match(html, /richmd-toc__item--level-3/); // Nested Heading
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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, readFile } from "node:fs/promises";
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

// --tree (design.md §02/§06, ADR-0005, issue-driven work order): a
// repeatable `--tree=<path>` flag classifies each rewritten cross-document
// link as "in-tree" by comparing its resolved `.md` target (fragment
// stripped) against the flag's path set, adding
// class="richmd-intree-link" to the rendered <a> tag on a match. Absent
// entirely, output is byte-identical to today's (no `--tree` at all).
describe("richmd render (--tree, link target matches)", () => {
  let workDir;
  let mainPath;
  let siblingPath;
  let mainHtmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-tree-match-"));
    mainPath = path.join(workDir, "links-main.md");
    siblingPath = path.join(workDir, "links-sibling.md");
    mainHtmlPath = path.join(workDir, "links-main.html");
    await cp(path.join(fixturesDir, "links-main.md"), mainPath);
    await cp(path.join(fixturesDir, "links-sibling.md"), siblingPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0", async () => {
    const result = await runCli(["render", mainPath, "--tree=" + siblingPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it('adds class="richmd-intree-link" to the rewritten <a> tag for the matching (fragment) link', async () => {
    await runCli(["render", mainPath, "--tree=" + siblingPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(
      html,
      /<a\s+href="links-sibling\.html#some-heading"\s+class="richmd-intree-link">/,
    );
  });

  it('adds class="richmd-intree-link" to the rewritten <a> tag for the matching bare (no-fragment) link', async () => {
    await runCli(["render", mainPath, "--tree=" + siblingPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(
      html,
      /<a\s+href="links-sibling\.html"\s+class="richmd-intree-link">/,
    );
  });

  it("strips the #fragment before matching — the fragment link classifies via the sibling.md path alone, and the fragment still appears in the rewritten href", async () => {
    await runCli(["render", mainPath, "--tree=" + siblingPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(
      html,
      /<a\s+href="links-sibling\.html#some-heading"\s+class="richmd-intree-link">/,
    );
  });
});

describe("richmd render (--tree, link target does not match)", () => {
  let workDir;
  let mainPath;
  let siblingPath;
  let mainHtmlPath;
  let unrelatedTreePath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-tree-nomatch-"));
    mainPath = path.join(workDir, "links-main.md");
    siblingPath = path.join(workDir, "links-sibling.md");
    mainHtmlPath = path.join(workDir, "links-main.html");
    unrelatedTreePath = path.join(workDir, "not-linked-anywhere.md");
    await cp(path.join(fixturesDir, "links-main.md"), mainPath);
    await cp(path.join(fixturesDir, "links-sibling.md"), siblingPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 — a --tree path matching nothing in the document is not an error", async () => {
    const result = await runCli([
      "render",
      mainPath,
      "--tree=" + unrelatedTreePath,
    ]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("does not add the class to a link whose target isn't in the --tree set", async () => {
    await runCli(["render", mainPath, "--tree=" + unrelatedTreePath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(html, /<a\s+href="links-sibling\.html#some-heading">/);
    assert.doesNotMatch(html, /richmd-intree-link/);
  });
});

describe("richmd render (--tree, repeatable — multiple flags)", () => {
  let workDir;
  let mainPath;
  let siblingPath;
  let mainHtmlPath;
  let unrelatedTreePath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-tree-multi-"));
    mainPath = path.join(workDir, "links-main.md");
    siblingPath = path.join(workDir, "links-sibling.md");
    mainHtmlPath = path.join(workDir, "links-main.html");
    unrelatedTreePath = path.join(workDir, "not-linked-anywhere.md");
    await cp(path.join(fixturesDir, "links-main.md"), mainPath);
    await cp(path.join(fixturesDir, "links-sibling.md"), siblingPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("classifies the matching link when passed alongside an unrelated --tree flag (both take effect)", async () => {
    const result = await runCli([
      "render",
      mainPath,
      "--tree=" + unrelatedTreePath,
      "--tree=" + siblingPath,
    ]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(
      html,
      /<a\s+href="links-sibling\.html#some-heading"\s+class="richmd-intree-link">/,
    );
    assert.match(
      html,
      /<a\s+href="links-sibling\.html"\s+class="richmd-intree-link">/,
    );
  });
});

// Regression guard: --tree entirely absent must produce byte-identical
// output to today's behavior — same assertions as links.test.js's untree'd
// cross-document-link case, plus a direct absence-of-class check.
describe("richmd render (--tree absent) — unchanged from today's output", () => {
  let workDir;
  let mainPath;
  let siblingPath;
  let mainHtmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-tree-absent-"));
    mainPath = path.join(workDir, "links-main.md");
    siblingPath = path.join(workDir, "links-sibling.md");
    mainHtmlPath = path.join(workDir, "links-main.html");
    await cp(path.join(fixturesDir, "links-main.md"), mainPath);
    await cp(path.join(fixturesDir, "links-sibling.md"), siblingPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0", async () => {
    const result = await runCli(["render", mainPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("rewrites the #fragment link with no richmd-intree-link class present anywhere", async () => {
    await runCli(["render", mainPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(html, /<a\s+href="links-sibling\.html#some-heading">/);
    assert.doesNotMatch(html, /richmd-intree-link/);
  });

  it("rewrites the bare link with no richmd-intree-link class present anywhere", async () => {
    await runCli(["render", mainPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(html, /<a\s+href="links-sibling\.html">/);
    assert.doesNotMatch(html, /richmd-intree-link/);
  });
});

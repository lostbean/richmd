import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, readFile, writeFile, access } from "node:fs/promises";
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

  // theme/default.css §4 CALLOUTS expects the outer `.richmd-callout` to
  // wrap a `.richmd-callout-body` element — never hold content directly —
  // and, absent a `title` attr, the body must contain no
  // `.richmd-callout-title` span at all (no empty/broken title element).
  it("wraps the callout body in .richmd-callout-body, nested inside .richmd-callout--info", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<div class="richmd-callout richmd-callout--info">\s*<div class="richmd-callout-body">/,
    );
  });

  it("emits no .richmd-callout-title span when no title attr is given", async () => {
    const html = await readFile(htmlPath, "utf8");
    // The theme's <style> block legitimately defines `.richmd-callout-title`
    // as a CSS rule; only the callout's own rendered markup (inside
    // .richmd-callout-body) must be free of the class.
    const bodyMatch = html.match(
      /<div class="richmd-callout-body">([\s\S]*?)<\/div>\s*<\/div>/,
    );
    assert.ok(bodyMatch, "expected to find a .richmd-callout-body element");
    assert.doesNotMatch(bodyMatch[1], /richmd-callout-title/);
  });
});

// A callout with an optional `title` attr: the title renders as a leading
// `.richmd-callout-title` span, still nested inside the same
// `.richmd-callout-body` wrapper as the rest of the content (theme/default.css
// §4 CALLOUTS markup contract).
describe("richmd render (callout, with title attr)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-title-"));
    mdPath = path.join(workDir, "callout-with-title.md");
    htmlPath = path.join(workDir, "callout-with-title.html");
    await cp(path.join(fixturesDir, "callout-with-title.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("renders the title as a .richmd-callout-title span inside .richmd-callout-body", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<div class="richmd-callout-body">\s*<span class="richmd-callout-title">Error budget<\/span>/,
    );
  });

  it("still renders the body text after the title", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /92% of the monthly error budget remains/);
  });

  it("uses the correct tint modifier class", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /richmd-callout richmd-callout--info/);
  });
});

// The three tint enum values (info/warning/danger) must each still produce
// the correctly named modifier class on the new nested markup shape.
describe("richmd render (callout, tint variants)", () => {
  let workDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-tints-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  for (const tint of ["info", "warning", "danger"]) {
    it(`renders richmd-callout--${tint} for tint="${tint}"`, async () => {
      const mdPath = path.join(workDir, `callout-tint-${tint}.md`);
      const htmlPath = path.join(workDir, `callout-tint-${tint}.html`);
      await writeFile(
        mdPath,
        `::: {.callout tint="${tint}"}\nBody for ${tint}.\n:::\n`,
      );
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const html = await readFile(htmlPath, "utf8");
      assert.match(html, new RegExp(`richmd-callout richmd-callout--${tint}"`));
      assert.match(html, /<div class="richmd-callout-body">\s*<p>Body for/);
    });
  }
});

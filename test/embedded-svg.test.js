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

describe("richmd render (embedded-svg, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-embedded-svg-valid-"),
    );
    mdPath = path.join(workDir, "embedded-svg-valid.md");
    htmlPath = path.join(workDir, "embedded-svg-valid.html");
    await cp(path.join(fixturesDir, "embedded-svg-valid.md"), mdPath);
    // The referenced SVG must sit alongside the .md as a sibling file.
    await cp(
      path.join(fixturesDir, "sample.svg"),
      path.join(workDir, "sample.svg"),
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("embeds the real <svg> markup inline, not an <img> reference", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<svg[^>]*class="richmd-fixture-svg"/);
    assert.match(html, /<circle cx="50" cy="50" r="40" fill="#4a9edb"/);
    assert.doesNotMatch(html, /<img[^>]*sample\.svg/);
  });

  // Bug fix: theme/default.css previously had ZERO CSS rule for
  // .richmd-embedded-svg (confirmed via grep before this fix), so an
  // embedded SVG's own hardcoded width/height attributes (e.g.
  // examples/diagram.svg's width="240" height="120") won outright with no
  // override, rendering tiny regardless of the surrounding container's
  // actual width. A real headless-browser measurement (chrome-devtools MCP)
  // against a page embedding examples/diagram.svg (which has explicit
  // width="240" height="120" AND a viewBox="0 0 240 120") confirmed: before
  // this CSS rule, the rendered <svg> stayed at exactly 240x120px inside a
  // 1032px-wide container; after adding `.richmd-embedded-svg svg { width:
  // 100%; max-width: 100%; height: auto; }`, the rendered <svg> scaled to
  // fill the full 1032px container width at 1032x516px — exactly the
  // viewBox's 240:120 (2:1) aspect ratio preserved (1032/516 = 2.0).
  it("emits a .richmd-embedded-svg svg CSS rule in the stylesheet so embedded SVGs scale to their container", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /\.richmd-embedded-svg svg\s*\{[^}]*width:\s*100%[^}]*\}/,
    );
    assert.match(
      html,
      /\.richmd-embedded-svg svg\s*\{[^}]*height:\s*auto[^}]*\}/,
    );
  });
});

describe("richmd render (embedded-svg, optional caption)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-embedded-svg-caption-"),
    );
    mdPath = path.join(workDir, "embedded-svg-caption.md");
    htmlPath = path.join(workDir, "embedded-svg-caption.html");
    await cp(path.join(fixturesDir, "embedded-svg-caption.md"), mdPath);
    await cp(
      path.join(fixturesDir, "sample.svg"),
      path.join(workDir, "sample.svg"),
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("wraps the embedded svg div in a <figure> with a <figcaption> holding the caption text", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<figure>\s*<div class="richmd-embedded-svg">[\s\S]*?<\/div>\s*<figcaption>Figure 1: sample diagram<\/figcaption>\s*<\/figure>/,
    );
  });
});

// A caption is spliced into a raw HTML <figcaption> via string
// concatenation (render() has no AST-node route to a bare RawBlock's
// contents that would auto-escape it, unlike e.g. cards.lua's badge/meta
// text which goes through pandoc.Str/Span and IS auto-escaped by Pandoc's
// own HTML writer). An unescaped caption containing `<`/`>`/`&` would
// either render as live HTML (e.g. a real `<b>` tag) or, worse, let
// caption text execute as script — verified as a real bug (not just a
// theoretical one) before html_escape was added to embedded-svg.lua.
describe("richmd render (embedded-svg, caption with unsafe HTML characters)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-embedded-svg-caption-unsafe-"),
    );
    mdPath = path.join(workDir, "embedded-svg-caption-unsafe-chars.md");
    htmlPath = path.join(workDir, "embedded-svg-caption-unsafe-chars.html");
    await cp(
      path.join(fixturesDir, "embedded-svg-caption-unsafe-chars.md"),
      mdPath,
    );
    await cp(
      path.join(fixturesDir, "sample.svg"),
      path.join(workDir, "sample.svg"),
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("HTML-escapes the caption text rather than splicing it in as live markup", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<figcaption>a &lt;b&gt;bold&lt;\/b&gt; &amp; "quoted" caption<\/figcaption>/,
    );
    assert.doesNotMatch(html, /<figcaption>[^<]*<b>bold<\/b>/);
  });
});

// Chunk 12 fix: validate_block (the Div-shaped validation path) now calls
// schema.validate generically, exactly like validate_only_codeblock already
// did for CodeBlock-shaped kinds — closing the gap chunk 10 found and
// escalated. embedded-svg's own file-existence check (its schema.validate
// hook) now runs during the validate PHASE, so a missing file is caught by
// richmd validate's fail-closed gate like every other kind's errors, not
// left to crash at render time.
describe("richmd validate (embedded-svg, nonexistent file)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-embedded-svg-missing-"),
    );
    mdPath = path.join(workDir, "embedded-svg-missing-file.md");
    await cp(path.join(fixturesDir, "embedded-svg-missing-file.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the missing file via the standard error format", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(
      result.stderr,
      /^richmd: \[embedded-svg\] div\.embedded-svg: .*does-not-exist\.svg/m,
    );
    assert.match(result.stderr, /does not exist/);
  });
});

// render must ALSO catch the missing file during the validate phase now —
// via the same collected-errors fail-closed gate every other kind's errors
// go through — rather than crashing with an unhandled Lua runtime error at
// render time (the previous, buggy behavior: exit 83, stack traceback,
// no clean error message).
describe("richmd render (embedded-svg, nonexistent file)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-embedded-svg-missing-"),
    );
    mdPath = path.join(workDir, "embedded-svg-missing-file.md");
    htmlPath = path.join(workDir, "embedded-svg-missing-file.html");
    await cp(path.join(fixturesDir, "embedded-svg-missing-file.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 1 (not a crash), names the missing file, and writes no HTML", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(
      result.code,
      1,
      `expected clean exit 1, got stderr: ${result.stderr}`,
    );
    assert.match(
      result.stderr,
      /^richmd: \[embedded-svg\] div\.embedded-svg: .*does-not-exist\.svg/m,
    );
    assert.match(result.stderr, /does not exist/);
    assert.doesNotMatch(result.stderr, /stack traceback/);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd validate (embedded-svg, forbidden body present)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-embedded-svg-forbidden-body-"),
    );
    mdPath = path.join(workDir, "embedded-svg-forbidden-body.md");
    await cp(path.join(fixturesDir, "embedded-svg-forbidden-body.md"), mdPath);
    await cp(
      path.join(fixturesDir, "sample.svg"),
      path.join(workDir, "sample.svg"),
    );
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

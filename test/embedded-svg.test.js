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

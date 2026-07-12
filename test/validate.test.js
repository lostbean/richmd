import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, access } from "node:fs/promises";
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

// `richmd validate` runs the same fail-closed gate as `richmd render`, but
// must NEVER write HTML — not even on a fully valid document (design.md
// §02 CLI entry). This is the distinguishing behavior from `render`.
describe("richmd validate (callout, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-validate-valid-"));
    mdPath = path.join(workDir, "callout-valid.md");
    htmlPath = path.join(workDir, "callout-valid.html");
    await cp(path.join(fixturesDir, "callout-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 on a valid document", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("writes NO sibling .html file even though validation passed", async () => {
    await runCli(["validate", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd validate (callout, invalid tint)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-validate-invalid-"));
    mdPath = path.join(workDir, "callout-invalid-tint.md");
    htmlPath = path.join(workDir, "callout-invalid-tint.html");
    await cp(path.join(fixturesDir, "callout-invalid-tint.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("prints the error to stderr", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.match(result.stderr, /tint/);
    assert.match(result.stderr, /not-a-real-tint/);
  });

  it("writes no HTML", async () => {
    await runCli(["validate", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

// Same all-errors-collected proof as gate.test.js, but through the
// `validate` subcommand specifically — the acceptance criteria require this
// to hold for either subcommand, not just `render`.
describe("richmd validate (callout, two independent invalid blocks)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-two-invalid-"),
    );
    mdPath = path.join(workDir, "callout-two-invalid.md");
    await cp(path.join(fixturesDir, "callout-two-invalid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and reports both distinct invalid tint values", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not-a-real-tint/);
    assert.match(result.stderr, /also-not-real/);
  });
});

// CONTEXT.md#term-block's Div/CodeBlock distinction: `::: {.kind}` is
// richmd's primary authoring syntax, so a fenced div's class is ALWAYS a
// kind attempt — a Div with classes that match NOTHING in the registry is a
// richmd block attempt with a typo'd/unknown kind name, not a foreign
// tool's unrelated div, and must be a collected validation error, exactly
// like an unknown kind reached via any other path (registry.lookup
// returning nil). (CodeBlocks are handled differently on purpose — see the
// "CodeBlock with an unrecognized/language class" suite below.)
describe("richmd validate (Div with an unrecognized class)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-unknown-div-"),
    );
    mdPath = path.join(workDir, "unknown-kind-div.md");
    await cp(path.join(fixturesDir, "unknown-kind-div.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the unrecognized kind on stderr", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /totally-unregistered-kind/);
    assert.match(result.stderr, /unknown block kind/);
  });
});

// CodeBlock is deliberately NOT symmetric with Div here (CONTEXT.md
// #term-block's explicit Div/CodeBlock distinction, added specifically to
// resolve this): by universal Pandoc/CommonMark convention a code block's
// class names a syntax-highlighting language (` ```js `, ` ```python `), not
// a kind attempt, so richmd only treats a CodeBlock as a Block when its
// class is one it explicitly recognizes (`mermaid`, `vega-lite`, ...). An
// unrecognized class like `js` must stay ordinary code, silently untouched
// — asserting the OPPOSITE of the Div case above is intentional, not an
// inconsistency.
describe("richmd validate (CodeBlock with an unrecognized/language class)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-codeblock-language-"),
    );
    mdPath = path.join(workDir, "codeblock-unrecognized-language.md");
    await cp(
      path.join(fixturesDir, "codeblock-unrecognized-language.md"),
      mdPath,
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 with no errors — an ordinary code sample, left untouched", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.equal(result.stderr, "");
  });
});

// The flip side of the two cases above: genuinely unclassed content (no
// `{.kind}` anywhere — a plain heading, paragraph, unclassed code fence, and
// list) is never a Block at all (CONTEXT.md#term-block requires a `.kind`
// class) and must remain completely unaffected by this fix — zero errors,
// zero validation attempt, ordinary Pandoc content passed straight through.
describe("richmd validate (no classes at all — ordinary content untouched)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-validate-unclassed-"));
    mdPath = path.join(workDir, "unclassed-passthrough.md");
    await cp(path.join(fixturesDir, "unclassed-passthrough.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 with no errors", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.equal(result.stderr, "");
  });
});

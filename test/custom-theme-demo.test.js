// Proves the "definition" custom block-kind extension
// (examples/.richmd/blocks/definition.schema.json + definition.lua) works
// end to end against the REAL examples/custom-theme-demo.md document — not
// a copied fixture — so extension-directory resolution is exercised for
// THIS example specifically, not just examples/data-status-report.md's
// "kicker" extension (design.md §00 principle P4, ADR-0003: extend by
// composition, never by fork).
//
// TDD directive: this file's happy-path test was run and observed to FAIL
// (no definition.schema.json/definition.lua existed yet, so "definition"
// was an unregistered class and `richmd validate` reported "unknown block
// kind") before examples/.richmd/blocks/definition.* was written — red,
// then green.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");
const examplesDir = path.join(repoRoot, "examples");
const demoMdPath = path.join(examplesDir, "custom-theme-demo.md");
const demoHtmlPath = path.join(examplesDir, "custom-theme-demo.html");

async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      { cwd: repoRoot, ...options },
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

describe("richmd render (examples/custom-theme-demo.md, the real example doc)", () => {
  after(async () => {
    // Clean up the generated sibling HTML so running the test suite never
    // leaves a build artifact behind in examples/ (the golden-hash script,
    // not this test, owns producing the committed .html for CI).
    await rm(demoHtmlPath, { force: true });
  });

  it("exits 0, resolving the 'definition' kind from examples/.richmd/blocks/", async () => {
    const result = await runCli(["render", demoMdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(demoHtmlPath);
  });

  it("renders each definition's term as a .custom-definition-term heading and its body inside .custom-definition-body", async () => {
    const html = await readFile(demoHtmlPath, "utf8");
    assert.match(
      html,
      /<div class="custom-definition">\s*<div class="custom-definition-body">/,
    );
    assert.match(html, /custom-definition-term">Idempotency key<\/span>/);
    assert.match(html, /custom-definition-term">Quorum<\/span>/);
  });

  it("also renders the mixed built-in kinds used alongside 'definition' (callout, cards, mermaid, toc)", async () => {
    const html = await readFile(demoHtmlPath, "utf8");
    assert.match(html, /richmd-callout richmd-callout--info/);
    assert.match(html, /richmd-callout richmd-callout--warning/);
    assert.match(html, /richmd-card-grid/);
    assert.match(html, /richmd-mermaid/);
    assert.match(html, /richmd-toc/);
  });

  it("embeds richmd's default theme (--richmd- custom properties) — the theme swap is a separate, secondary step, never baked into this render", async () => {
    const html = await readFile(demoHtmlPath, "utf8");
    assert.match(html, /<style/);
    assert.match(html, /--richmd-accent-500: #4f46e5/); // default theme's indigo accent
  });
});

describe("richmd validate (examples/custom-theme-demo.md)", () => {
  it("exits 0", async () => {
    const result = await runCli(["validate", demoMdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });
});

// Acceptance criterion: a malformed 'definition' block (missing the
// required `term` attr) must fail validation with a clear error, proving
// the extension's OWN schema validation genuinely runs — not just the
// happy path.
describe("richmd validate (malformed 'definition' block — missing required 'term' attr)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-definition-bad-"));
    const blocksDir = path.join(workDir, ".richmd", "blocks");
    await mkdir(blocksDir, { recursive: true });

    // Copy the REAL schema/lua pair from examples/.richmd/blocks/ — this
    // test proves the shipped extension's own validation behavior, not a
    // reimplementation of it.
    const schema = await readFile(
      path.join(examplesDir, ".richmd", "blocks", "definition.schema.json"),
      "utf8",
    );
    const lua = await readFile(
      path.join(examplesDir, ".richmd", "blocks", "definition.lua"),
      "utf8",
    );
    await writeFile(path.join(blocksDir, "definition.schema.json"), schema);
    await writeFile(path.join(blocksDir, "definition.lua"), lua);

    mdPath = path.join(workDir, "bad-definition.md");
    htmlPath = path.join(workDir, "bad-definition.html");
    await writeFile(
      mdPath,
      "::: {.definition}\nA definition missing its required term attr.\n:::\n",
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("reports a clear 'missing required attr' error naming the 'definition' kind", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.match(result.stderr, /^richmd: \[definition\]/m);
    assert.match(result.stderr, /missing required attr 'term'/);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

// Acceptance criterion: an empty body also violates the schema's
// `body: "required"`, mirroring built-in kinds' own body-required
// behavior (e.g. callout, cards).
describe("richmd validate (malformed 'definition' block — empty body)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-definition-nobody-"));
    const blocksDir = path.join(workDir, ".richmd", "blocks");
    await mkdir(blocksDir, { recursive: true });

    const schema = await readFile(
      path.join(examplesDir, ".richmd", "blocks", "definition.schema.json"),
      "utf8",
    );
    const lua = await readFile(
      path.join(examplesDir, ".richmd", "blocks", "definition.lua"),
      "utf8",
    );
    await writeFile(path.join(blocksDir, "definition.schema.json"), schema);
    await writeFile(path.join(blocksDir, "definition.lua"), lua);

    mdPath = path.join(workDir, "empty-body.md");
    await writeFile(mdPath, '::: {.definition term="Empty"}\n:::\n');
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero with a body-required error", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /^richmd: \[definition\]/m);
    assert.match(result.stderr, /body is required but was empty/);
  });
});

// Proves the "definition" custom block-kind extension
// (examples/.richmd/blocks/definition.schema.json + definition.lua) works
// end to end against a COPY of the real examples/custom-theme-demo.md
// document (not a from-scratch fixture) — so extension-directory
// resolution is exercised for THIS example specifically, not just
// examples/data-status-report.md's "kicker" extension (design.md §00
// principle P4, ADR-0003: extend by composition, never by fork).
//
// Rendered into a throwaway temp copy, never onto the real
// examples/custom-theme-demo.md in place: this test used to render
// directly onto the committed sibling path and rm() the resulting .html in
// an after() hook, which deleted that TRACKED, golden-hashed file (same
// golden-hash discipline as the other 3 example docs, via
// scripts/example-hash-check custom-theme-demo) on every single `npm test`
// run — anyone or anything that stopped short of the after() hook (a
// crash, a different runner) left it deleted with nothing to restore it.
// Copying the doc (plus its sibling .richmd/blocks/ extension dir and the
// data-status-report.md it cross-document-links to) into a temp dir first
// makes that class of bug structurally impossible: nothing under
// examples/ is ever written or deleted by this test.
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
  cp,
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

describe("richmd render (custom-theme-demo.md, a copy of the real example doc)", () => {
  let workDir;
  let demoMdPath;
  let demoHtmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-custom-theme-demo-"));
    // Copy the WHOLE examples/ directory: the demo doc cross-document-links
    // to data-status-report.md (§00 invariant: cross-document links always
    // resolve, checked at validate time) and resolves the `definition` kind
    // from the sibling `.richmd/blocks/` extension directory (ADR-0003) —
    // both must exist alongside the copy for a faithful render.
    await cp(examplesDir, workDir, { recursive: true });
    demoMdPath = path.join(workDir, "custom-theme-demo.md");
    demoHtmlPath = path.join(workDir, "custom-theme-demo.html");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
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

  it("exits 0 under richmd validate too", async () => {
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

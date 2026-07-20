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

  // --- Cascade-layer contract (Fix 2) -------------------------------------
  // richmd's default theme wraps ALL of its own rules in a single named
  // cascade layer, `@layer richmd-base { … }`. A consumer who writes a plain
  // UNLAYERED `.richmd-doc { --richmd-token: value }` rule then wins over
  // every richmd rule — including richmd's own higher-specificity
  // `.richmd-doc[data-richmd-theme="light"|"dark"]` and
  // `:root[data-richmd-theme="dark"]` scoped blocks — because in the CSS
  // cascade, any unlayered declaration outranks ALL layered declarations
  // regardless of selector specificity. This is the mechanism that makes
  // design.md §00 P3 ("style is swappable, never hardcoded") actually WIN.
  //
  // A real browser cascade engine is not available here (this repo has no
  // headless browser; linkedom lacks CSSOM/getComputedStyle — see
  // scripts/theme-swap-check's header for the same limitation), so these
  // assertions verify the STRUCTURAL facts about the emitted CSS text that,
  // by the documented cascade rule above, make the override win. That is an
  // honest stand-in for a computed-style check for this specific claim.
  function extractThemeStyleBlock(html) {
    const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
      (m) => m[1],
    );
    const themeBlock = blocks.find((b) => b.includes("--richmd-"));
    assert.ok(
      themeBlock,
      "richmd theme <style> block not found in rendered HTML",
    );
    return themeBlock;
  }

  it("emits richmd's theme rules inside a named `@layer richmd-base` cascade layer, with the :root token block inside it", async () => {
    const html = await readFile(demoHtmlPath, "utf8");
    const themeCss = extractThemeStyleBlock(html);

    // (1) Layer present: the theme <style> declares the richmd-base layer and
    // opens a block for it.
    assert.match(themeCss, /@layer richmd-base\s*\{/);

    // The :root light-token RULE sits INSIDE the layer block: the layer's
    // opening brace precedes the `:root {` rule. (We anchor on the actual
    // rule `:root {`, not a bare `:root`, because the file's header comment
    // mentions ":root" in prose — matching that would be a false positive.)
    const layerOpen = themeCss.search(/@layer richmd-base\s*\{/);
    const rootRuleAt = themeCss.search(/:root\s*\{/);
    assert.ok(
      layerOpen >= 0 && rootRuleAt > layerOpen,
      "the `:root {` token rule must appear after the @layer opening brace",
    );
  });

  it("declares the light-theme tokens with their exact unchanged values inside richmd-base (layer wrap changed no value)", async () => {
    const html = await readFile(demoHtmlPath, "utf8");
    const themeCss = extractThemeStyleBlock(html);

    // Standalone-identical proof: specific known token values are still
    // declared verbatim. If the layer wrap had altered any value, these would
    // fail. (These are the light :root defaults from theme/default.css §1.)
    assert.match(themeCss, /--richmd-color-bg:\s*#f6f7fb/);
    assert.match(themeCss, /--richmd-color-text:\s*#12172b/);
    assert.match(themeCss, /--richmd-accent-500:\s*#4f46e5/);
  });

  it("puts the data-richmd-theme scoped blocks INSIDE richmd-base, so an unlayered consumer override outranks them too", async () => {
    const html = await readFile(demoHtmlPath, "utf8");
    const themeCss = extractThemeStyleBlock(html);

    // The scoped attribute blocks that Fix 1 relies on must be inside the
    // layer — otherwise an unlayered consumer .richmd-doc{} rule would NOT
    // beat them. Assert each RULE (selector immediately followed by `{`, so a
    // prose mention of the selector in the header comment is not a false
    // positive) appears after the layer opens.
    const layerOpen = themeCss.search(/@layer richmd-base\s*\{/);
    assert.ok(layerOpen >= 0, "@layer richmd-base { must be present");

    const scopedRuleRegexes = [
      /\.richmd-doc\[data-richmd-theme="light"\]\s*\{/,
      /\.richmd-doc\[data-richmd-theme="dark"\]\s*\{/,
      /:root\[data-richmd-theme="dark"\]\s*\{/,
    ];
    for (const re of scopedRuleRegexes) {
      const at = themeCss.search(re);
      assert.ok(
        at > layerOpen,
        `${re} rule must appear inside the richmd-base layer`,
      );
    }

    // And the theme block ends by closing the layer: the LAST non-whitespace
    // char of the theme CSS is the layer's closing brace.
    assert.match(themeCss, /\}\s*$/);

    // Cascade rule (documented, not executed here): because these blocks are
    // layered, a consumer's UNLAYERED `.richmd-doc { --richmd-*: … }` wins
    // over them with no specificity matching required. Real-browser cascade
    // resolution is not exercised (no CSSOM/getComputedStyle available); this
    // is a structural assertion of the fact that makes the override win.
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

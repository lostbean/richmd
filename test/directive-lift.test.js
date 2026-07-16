import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  access,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lift } from "../filter/directive-lift.js";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");

async function runCli(args, options = {}) {
  const { cwd = repoRoot } = options;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      { cwd },
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

// --------------------------------------------------------------------------
// Unit: the pure lift function (design.md §02.1, ADR-0010). String in, string
// out; deterministic, idempotent, code-fence-aware, colon-count-preserving.
// --------------------------------------------------------------------------

describe("directive lift (pure function)", () => {
  it("rewrites an attr-bearing bareword opener to native form", () => {
    assert.equal(
      lift(":::invariant {enforcement=convention}\n"),
      "::: {.invariant enforcement=convention}\n",
    );
  });

  it("leaves an attrless bareword `:::goal` untouched (Pandoc already reads it as a Div)", () => {
    assert.equal(lift(":::goal\n"), ":::goal\n");
  });

  it("leaves an already-native `::: {.goal}` opener untouched", () => {
    assert.equal(lift("::: {.goal}\n"), "::: {.goal}\n");
  });

  it("leaves an already-native opener with attrs untouched", () => {
    assert.equal(
      lift('::: {.callout tint="warning"}\n'),
      '::: {.callout tint="warning"}\n',
    );
  });

  it("preserves a 4-colon nested fence's colon count", () => {
    assert.equal(
      lift('::::stat-tile {value="9"}\n'),
      ':::: {.stat-tile value="9"}\n',
    );
  });

  it("preserves leading indentation (0-3 spaces, still a Div to Pandoc)", () => {
    // 3 spaces is not indented code, so a nested opener still lifts and its
    // leading indentation is preserved verbatim. (4+ spaces would be indented
    // code — covered by the indented-code cases below.)
    assert.equal(
      lift('   ::::stat-tile {value="9"}\n'),
      '   :::: {.stat-tile value="9"}\n',
    );
  });

  it("does not rewrite a bareword directive line inside a ``` fenced code block", () => {
    const src = [
      "```",
      ":::invariant {enforcement=convention}",
      "```",
      "",
    ].join("\n");
    assert.equal(lift(src), src);
  });

  it("does not rewrite a bareword directive line inside a ~~~ fenced code block", () => {
    const src = [
      "~~~",
      ":::invariant {enforcement=convention}",
      "~~~",
      "",
    ].join("\n");
    assert.equal(lift(src), src);
  });

  it("honors info strings on the opening code fence", () => {
    const src = [
      "```markdown",
      ":::invariant {enforcement=convention}",
      "```",
      "",
    ].join("\n");
    assert.equal(lift(src), src);
  });

  it("lifts a bareword directive AFTER a closed code fence", () => {
    const src = [
      "```",
      "code",
      "```",
      "",
      ":::invariant {enforcement=convention}",
      "",
    ].join("\n");
    const expected = [
      "```",
      "code",
      "```",
      "",
      "::: {.invariant enforcement=convention}",
      "",
    ].join("\n");
    assert.equal(lift(src), expected);
  });

  it("respects the CommonMark closing-fence rule (closer must be >= and same char)", () => {
    // A ~~~ line inside a ``` block does not close it; the directive stays
    // verbatim.
    const src = [
      "````",
      "~~~",
      ":::invariant {enforcement=convention}",
      "````",
      "",
    ].join("\n");
    assert.equal(lift(src), src);
  });

  it("does not rewrite a `:::something` sequence appearing mid-sentence in prose", () => {
    const src = "See the :::foo {bar} token in the docs.\n";
    assert.equal(lift(src), src);
  });

  it("leaves a bare closing `:::` fence untouched", () => {
    assert.equal(lift(":::\n"), ":::\n");
  });

  it("leaves a colons-plus-whitespace closing fence untouched", () => {
    assert.equal(lift("::::   \n"), "::::   \n");
  });

  it("is idempotent: lift(lift(x)) === lift(x)", () => {
    const src = [
      ":::invariant {enforcement=convention}",
      "body",
      ":::",
      "",
      '::::stat-tile {value="9"}',
      "::::",
      "",
    ].join("\n");
    const once = lift(src);
    assert.equal(lift(once), once);
  });

  it("preserves the inner attr content verbatim, including multiple attrs", () => {
    assert.equal(
      lift(':::cards {cols="3" size="lg"}\n'),
      '::: {.cards cols="3" size="lg"}\n',
    );
  });

  it("leaves a 4-space-indented bareword opener untouched (Pandoc reads it as indented code)", () => {
    const src = '    :::callout {tint="info"}\n';
    assert.equal(lift(src), src);
  });

  it("leaves a tab-indented bareword opener untouched (Pandoc reads it as indented code)", () => {
    const src = '\t:::callout {x="1"}\n';
    assert.equal(lift(src), src);
  });

  it("still lifts a nested opener with 0-3 spaces of indent (Pandoc reads it as a Div)", () => {
    // 3 spaces of indent is NOT indented code; the nested opener must still lift
    // and its colon count must be preserved.
    assert.equal(
      lift('   ::::stat-tile {value="9"}\n'),
      '   :::: {.stat-tile value="9"}\n',
    );
  });

  it("does not rewrite a bareword line inside a CRLF-terminated fenced code block", () => {
    const src = "```\r\n:::callout {x=1}\r\n```\r\n";
    assert.equal(lift(src), src);
  });

  it("preserves CRLF line endings on a lifted line", () => {
    assert.equal(
      lift(":::invariant {enforcement=convention}\r\n"),
      "::: {.invariant enforcement=convention}\r\n",
    );
  });

  it("leaves a whole document with no bareword directives byte-identical", () => {
    const src = [
      "# Title",
      "",
      "Some prose.",
      "",
      '::: {.callout tint="info"}',
      "Native form.",
      ":::",
      "",
    ].join("\n");
    assert.equal(lift(src), src);
  });
});

// --------------------------------------------------------------------------
// End-to-end: through the CLI (real Pandoc, real filesystem). A document
// authored in bareword-attr form must be actually SEEN by validation.
// --------------------------------------------------------------------------

const CALLOUT_BAREWORD = [
  ':::callout {tint="warning"}',
  "Rebuilding this index takes about ten minutes.",
  ":::",
  "",
].join("\n");

const CALLOUT_NATIVE = [
  '::: {.callout tint="warning"}',
  "Rebuilding this index takes about ten minutes.",
  ":::",
  "",
].join("\n");

describe("directive lift end-to-end (bareword-form callout validates like native)", () => {
  let workDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-lift-e2e-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("validates a bareword-attr callout (exit 0, the block is actually seen)", async () => {
    const mdPath = path.join(workDir, "bareword.md");
    await writeFile(mdPath, CALLOUT_BAREWORD);
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /^richmd: \[/m);
  });

  it("renders a bareword-attr callout byte-identical to the native form", async () => {
    const barewordDir = path.join(workDir, "bw");
    const nativeDir = path.join(workDir, "nv");
    await mkdir(barewordDir, { recursive: true });
    await mkdir(nativeDir, { recursive: true });
    const bwMd = path.join(barewordDir, "doc.md");
    const nvMd = path.join(nativeDir, "doc.md");
    await writeFile(bwMd, CALLOUT_BAREWORD);
    await writeFile(nvMd, CALLOUT_NATIVE);

    const bwResult = await runCli(["render", bwMd]);
    const nvResult = await runCli(["render", nvMd]);
    assert.equal(bwResult.code, 0, `bareword stderr: ${bwResult.stderr}`);
    assert.equal(nvResult.code, 0, `native stderr: ${nvResult.stderr}`);

    const bwHtml = await readFile(path.join(barewordDir, "doc.html"), "utf8");
    const nvHtml = await readFile(path.join(nativeDir, "doc.html"), "utf8");
    assert.equal(bwHtml, nvHtml);
  });

  it("reports a loud unknown-kind error for an unknown bareword kind (no silent pass)", async () => {
    const mdPath = path.join(workDir, "unknown.md");
    await writeFile(mdPath, ':::notakind {x="1"}\nbody\n:::\n');
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /notakind/);
    assert.match(result.stderr, /unknown block kind/);
  });

  it("does NOT rewrite a 4-space-indented bareword directive (renders as literal indented code)", async () => {
    const mdPath = path.join(workDir, "indented.md");
    const src = ["# Doc", "", '    :::callout {tint="info"}', ""].join("\n");
    await writeFile(mdPath, src);
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(path.join(workDir, "indented.html"), "utf8");
    // The indented line is verbatim code: the ORIGINAL bareword text survives
    // and the rewritten native form never appears.
    assert.match(html, /:::callout/);
    assert.doesNotMatch(html, /\{\.callout/);
  });

  it("does NOT rewrite a bareword directive quoted inside a code fence (renders as literal code)", async () => {
    const mdPath = path.join(workDir, "quoted.md");
    const src = ["# Doc", "", "```", ':::notakind {x="1"}', "```", ""].join(
      "\n",
    );
    await writeFile(mdPath, src);
    // The bareword inside the fence is verbatim code, never a block attempt,
    // so `notakind` must NOT trigger an unknown-kind validation error.
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /unknown block kind/);
  });
});

// The directive-lift temp file must never leak its (random) name into the
// rendered `<title>`. A bareword-form document must render byte-identical to its
// native equivalent whether the document declares its own title or relies on
// Pandoc's filename fallback.
describe("directive lift preserves the rendered <title> across the temp-file seam", () => {
  let workDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-lift-title-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function renderPair(name, barewordSrc, nativeSrc) {
    const bwDir = path.join(workDir, `${name}-bw`);
    const nvDir = path.join(workDir, `${name}-nv`);
    await mkdir(bwDir, { recursive: true });
    await mkdir(nvDir, { recursive: true });
    await writeFile(path.join(bwDir, "doc.md"), barewordSrc);
    await writeFile(path.join(nvDir, "doc.md"), nativeSrc);
    const bw = await runCli(["render", path.join(bwDir, "doc.md")]);
    const nv = await runCli(["render", path.join(nvDir, "doc.md")]);
    assert.equal(bw.code, 0, `bareword stderr: ${bw.stderr}`);
    assert.equal(nv.code, 0, `native stderr: ${nv.stderr}`);
    return {
      bw: await readFile(path.join(bwDir, "doc.html"), "utf8"),
      nv: await readFile(path.join(nvDir, "doc.html"), "utf8"),
    };
  }

  it("no-title document: title falls back to the ORIGINAL stem, not the temp name", async () => {
    const { bw, nv } = await renderPair(
      "notitle",
      ':::callout {tint="info"}\nhi\n:::\n',
      '::: {.callout tint="info"}\nhi\n:::\n',
    );
    assert.equal(bw, nv);
    assert.match(bw, /<title>doc<\/title>/);
    assert.doesNotMatch(bw, /richmd-lift-/);
  });

  it("YAML-title document: the document's own title still wins (not clobbered)", async () => {
    const { bw, nv } = await renderPair(
      "yamltitle",
      '---\ntitle: My Real Title\n---\n\n:::callout {tint="info"}\nhi\n:::\n',
      '---\ntitle: My Real Title\n---\n\n::: {.callout tint="info"}\nhi\n:::\n',
    );
    assert.equal(bw, nv);
    assert.match(bw, /<title>My Real Title<\/title>/);
  });

  it("percent-title document: the document's own title still wins", async () => {
    const { bw, nv } = await renderPair(
      "pcttitle",
      '% Percent Title\n\n:::callout {tint="info"}\nhi\n:::\n',
      '% Percent Title\n\n::: {.callout tint="info"}\nhi\n:::\n',
    );
    assert.equal(bw, nv);
    assert.match(bw, /<title>Percent Title<\/title>/);
  });
});

// The sibling-temp-file seam (bin/richmd.js runFilter): lifting must not
// disturb doc_dir, which drives config-dir discovery AND relative .md link
// resolution. A bareword doc nested in a subdirectory, with a .richmd/ config
// two levels up and a relative .md link, must still resolve both.
describe("directive lift preserves doc_dir (config-dir + relative link seam)", () => {
  let workDir;
  let docDir;

  const HIGHLIGHT_SCHEMA = JSON.stringify({
    kind: "highlight",
    attrs: { note: { required: false, type: "string" } },
    body: "required",
  });
  const HIGHLIGHT_LUA = [
    "local function render(block, resolved_attrs)",
    '  return pandoc.Div(block.content, pandoc.Attr("", { "richmd-highlight" }))',
    "end",
    "return { render = render }",
  ].join("\n");

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-lift-docdir-"));
    // repo root marker
    await mkdir(path.join(workDir, ".git"), { recursive: true });
    // ancestor .richmd/ two levels above the doc
    const blocksDir = path.join(workDir, "docs", "design", ".richmd", "blocks");
    await mkdir(blocksDir, { recursive: true });
    await writeFile(
      path.join(blocksDir, "highlight.schema.json"),
      HIGHLIGHT_SCHEMA,
    );
    await writeFile(path.join(blocksDir, "highlight.lua"), HIGHLIGHT_LUA);

    docDir = path.join(workDir, "docs", "design", "ctx");
    await mkdir(docDir, { recursive: true });
    // sibling doc the relative .md link points at
    await writeFile(path.join(docDir, "other.md"), "# Other\n\nhi\n");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("resolves the ancestor .richmd/ block AND a relative .md link from a bareword doc", async () => {
    // Bareword-form custom block (forces the lift to produce a temp file) plus
    // a relative .md cross-doc link (doc_dir-relative resolution).
    const src = [
      ':::highlight {note="x"}',
      "See [other](other.md) for more.",
      ":::",
      "",
    ].join("\n");
    const mdPath = path.join(docDir, "design.md");
    await writeFile(mdPath, src);

    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(path.join(docDir, "design.html"), "utf8");
    // The custom kind resolved (ancestor .richmd/ found via doc_dir walk).
    assert.match(html, /richmd-highlight/);
    // The relative .md link was rewritten to its sibling .html (link resolver
    // ran against the correct doc_dir).
    assert.match(html, /other\.html/);
    // The temp file must be cleaned up — only the real doc and its .html remain.
    const entries = await (await import("node:fs/promises")).readdir(docDir);
    assert.deepEqual(entries.sort(), ["design.html", "design.md", "other.md"]);
  });
});

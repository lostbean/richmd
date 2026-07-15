import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");

// This suite exercises richmd-filter.lua's config-directory upward walk
// (ADR-0009, CONTEXT.md#term-config-directory) through the full CLI, same
// convention as test/extension-cli.test.js: a real temp directory tree (via
// mkdtemp/mkdir/writeFile), never an in-memory filesystem stand-in, driven
// through bin/richmd.js's actual `render`/`validate` subcommands.

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

// A consumer-defined "highlight" block kind — same fixture shape as
// test/extension-cli.test.js — used to prove WHICH .richmd/blocks/ directory
// actually got loaded: if the walked config dir is wrong, the document fails
// to validate/render with an "unknown block kind" error instead.
const HIGHLIGHT_SCHEMA = JSON.stringify({
  kind: "highlight",
  attrs: {},
  body: "required",
});

const HIGHLIGHT_LUA = [
  "local function render(block, resolved_attrs)",
  '  return pandoc.Div(block.content, pandoc.Attr("", { "richmd-highlight" }))',
  "end",
  "return { render = render }",
].join("\n");

async function writeHighlightExtension(richmdDir) {
  const blocksDir = path.join(richmdDir, "blocks");
  await mkdir(blocksDir, { recursive: true });
  await writeFile(
    path.join(blocksDir, "highlight.schema.json"),
    HIGHLIGHT_SCHEMA,
  );
  await writeFile(path.join(blocksDir, "highlight.lua"), HIGHLIGHT_LUA);
}

const DOC_MD = "::: {.highlight}\nExtension text.\n:::\n";

describe("config directory discovery (no .richmd/ and no .git anywhere) — regression, byte-identical fallback", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-cfg-none-"));
    mdPath = path.join(workDir, "doc.md");
    await writeFile(mdPath, "# Plain doc\n\nNothing fancy.\n");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("falls back to doc_dir and renders successfully (no extension, no crash)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(path.join(workDir, "doc.html"));
  });

  it("prints the resolved config directory (doc's own dir) on stderr", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(escapeRe(workDir)));
  });
});

describe("config directory discovery (.richmd/ directly in the document's own directory)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-cfg-own-"));
    await writeHighlightExtension(path.join(workDir, ".richmd"));
    mdPath = path.join(workDir, "doc.md");
    await writeFile(mdPath, DOC_MD);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("uses the document's own .richmd/ directly (today's existing case)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await (
      await import("node:fs/promises")
    ).readFile(path.join(workDir, "doc.html"), "utf8");
    assert.match(html, /richmd-highlight/);
  });
});

describe("config directory discovery (.richmd/ in an ANCESTOR, .git further up, doc nested)", () => {
  let workDir;
  let mdPath;
  let ancestorRichmdDir;
  let docDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-cfg-ancestor-"));
    // repo root: has .git
    await mkdir(path.join(workDir, ".git"), { recursive: true });
    // docs/design/.richmd/blocks/highlight.{schema.json,lua}
    ancestorRichmdDir = path.join(workDir, "docs", "design", ".richmd");
    await writeHighlightExtension(ancestorRichmdDir);
    // nested doc: docs/design/some-context/design.md (no .richmd/ of its own)
    docDir = path.join(workDir, "docs", "design", "some-context");
    await mkdir(docDir, { recursive: true });
    mdPath = path.join(docDir, "design.md");
    await writeFile(mdPath, DOC_MD);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("walks up and finds the ancestor's .richmd/, not the doc's own (missing) one", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await (
      await import("node:fs/promises")
    ).readFile(path.join(docDir, "design.html"), "utf8");
    assert.match(html, /richmd-highlight/);
  });

  it("prints the ancestor directory (not the doc's own directory) as the resolved config dir", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(escapeRe(path.dirname(ancestorRichmdDir))),
    );
  });
});

describe("config directory discovery (.richmd/ in an ANCESTOR, invoked via RELATIVE path from the doc's own directory — the ordinary CLI invocation shape)", () => {
  let workDir;
  let ancestorRichmdDir;
  let docDir;

  // Every other describe block in this file invokes the CLI with an
  // ABSOLUTE path to the document (mdPath is built from path.join off an
  // mkdtemp'd absolute workDir, and runCli always runs with cwd: repoRoot).
  // That happens to mask the bug: PANDOC_STATE.input_files[1] is only ever
  // a bare relative filename (e.g. "doc.md", no "/" in it at all) when
  // richmd is invoked the ordinary way — `richmd render doc.md` run FROM
  // the document's own directory, exactly like every example in
  // USAGE_RULES.md. current_doc_dir()'s "(.*)/[^/]*$" pattern only matches
  // when the input path already contains a "/"; a bare filename falls
  // through to the literal string "." — which resolve_config_dir's upward
  // walk then cannot climb past (parent_dir(".") returns nil immediately),
  // so an ancestor .richmd/ several levels up is never found. This case
  // reproduces that exact invocation shape: cwd is the doc's OWN directory,
  // and the CLI is given only the bare filename "design.md".
  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-cfg-relative-"));
    // repo root: has .git
    await mkdir(path.join(workDir, ".git"), { recursive: true });
    // docs/design/.richmd/blocks/highlight.{schema.json,lua} — two levels
    // above the document itself.
    ancestorRichmdDir = path.join(workDir, "docs", "design", ".richmd");
    await writeHighlightExtension(ancestorRichmdDir);
    // nested doc: docs/design/some-context/design.md (no .richmd/ of its own)
    docDir = path.join(workDir, "docs", "design", "some-context");
    await mkdir(docDir, { recursive: true });
    await writeFile(path.join(docDir, "design.md"), DOC_MD);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("walks up and finds the ancestor's .richmd/ when invoked with a bare relative filename from the doc's own cwd", async () => {
    const result = await runCli(["render", "design.md"], { cwd: docDir });
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await (
      await import("node:fs/promises")
    ).readFile(path.join(docDir, "design.html"), "utf8");
    assert.match(html, /richmd-highlight/);
  });

  it("prints the ancestor directory (not the literal '.') as the resolved config dir", async () => {
    const result = await runCli(["validate", "design.md"], { cwd: docDir });
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(escapeRe(path.dirname(ancestorRichmdDir))),
    );
  });
});

describe("config directory discovery (relative invocation, .git boundary several levels up — must terminate, not hang)", () => {
  let workDir;
  let docDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-cfg-relative-deep-"));
    await mkdir(path.join(workDir, ".git"), { recursive: true });
    // No .richmd/ anywhere; doc nested several levels deep.
    docDir = path.join(workDir, "a", "b", "c", "d");
    await mkdir(docDir, { recursive: true });
    await writeFile(path.join(docDir, "doc.md"), "# Plain doc\n\nNo blocks.\n");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("climbs past multiple levels via a relative invocation and terminates at the .git boundary (falls back to doc's own dir, not the literal '.')", async () => {
    const result = await runCli(["validate", "doc.md"], { cwd: docDir });
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(escapeRe(docDir)));
    assert.doesNotMatch(result.stderr, /resolved to '\.'/);
  });
});

describe("config directory discovery (two .richmd/ at different levels — nearest wins, no merge)", () => {
  let workDir;
  let mdPath;
  let docDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-cfg-nearest-"));
    await mkdir(path.join(workDir, ".git"), { recursive: true });

    // Root-level .richmd/blocks/ defines a DIFFERENT kind ("root-only"),
    // never used by the document below — proves the farther one's contents
    // are never merged in.
    const rootRichmdBlocks = path.join(workDir, ".richmd", "blocks");
    await mkdir(rootRichmdBlocks, { recursive: true });
    await writeFile(
      path.join(rootRichmdBlocks, "root-only.schema.json"),
      JSON.stringify({ kind: "root-only", attrs: {}, body: "required" }),
    );
    await writeFile(
      path.join(rootRichmdBlocks, "root-only.lua"),
      HIGHLIGHT_LUA.replace(/highlight/g, "root-only"),
    );

    // Nearer .richmd/ (in docs/) defines "highlight" — this is the one that
    // must win.
    const nearRichmdDir = path.join(workDir, "docs", ".richmd");
    await writeHighlightExtension(nearRichmdDir);

    docDir = path.join(workDir, "docs");
    mdPath = path.join(docDir, "doc.md");
    await writeFile(mdPath, DOC_MD);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("uses the nearer .richmd/ ('highlight' resolves), not the root one", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("never merges in the farther .richmd/'s kind (a doc using 'root-only' instead fails)", async () => {
    const rootOnlyMdPath = path.join(docDir, "root-only-doc.md");
    await writeFile(rootOnlyMdPath, "::: {.root-only}\ntext\n:::\n");
    const result = await runCli(["validate", rootOnlyMdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /unknown block kind 'root-only'/);
  });

  it("prints the nearer directory as the resolved config dir", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(
      result.stderr,
      new RegExp(escapeRe(path.dirname(path.join(docDir, ".richmd")))),
    );
  });
});

describe("config directory discovery (.git boundary reached, no .richmd/ found anywhere)", () => {
  let workDir;
  let mdPath;
  let docDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-cfg-boundary-"));
    await mkdir(path.join(workDir, ".git"), { recursive: true });
    docDir = path.join(workDir, "docs", "nested");
    await mkdir(docDir, { recursive: true });
    mdPath = path.join(docDir, "doc.md");
    await writeFile(mdPath, "# Plain doc\n\nNo blocks here.\n");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("falls back to the document's own directory (not the .git directory, not an error)", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(escapeRe(docDir)));
  });
});

describe("config directory path appears on stderr for both render and validate", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-cfg-stderr-"));
    mdPath = path.join(workDir, "doc.md");
    await writeFile(mdPath, "# Plain doc\n");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("render prints the resolved config directory to stderr", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(escapeRe(workDir)));
  });

  it("validate prints the resolved config directory to stderr", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(escapeRe(workDir)));
  });
});

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");

// The document shell hook (design.md §10 "Document shell", ADR-0014) is the
// fourth consumer-declarable contract: a single `.richmd/shell/shell.lua`
// returning `{ masthead?, colophon? }`, each `region(doc_meta) ->
// pandoc.Blocks`. richmd calls each region during the RENDER phase and
// injects the returned blocks into `.richmd-container` — the masthead
// prepended (after the leading anti-section guard RawBlock, before the
// document's own blocks), the colophon appended at the container's end.
//
// This suite drives the real CLI (`richmd render <md>`) against tmpdir
// fixtures — the public interface — asserting behavior through the rendered
// HTML and CLI exit/stderr, exactly as test/theme-shell.test.js and
// test/rules-loader.test.js do. No internal Lua state is inspected.

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

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Builds a work dir with a document at <name>.md and, optionally, a
// `.richmd/shell/` directory populated with the given { filename: contents }
// hook files.
async function makeDoc({ prefix, md, shellFiles }) {
  const workDir = await mkdtemp(path.join(tmpdir(), prefix));
  const mdPath = path.join(workDir, "doc.md");
  const htmlPath = path.join(workDir, "doc.html");
  await writeFile(mdPath, md);
  if (shellFiles) {
    const shellDir = path.join(workDir, ".richmd", "shell");
    await mkdir(shellDir, { recursive: true });
    for (const [name, contents] of Object.entries(shellFiles)) {
      await writeFile(path.join(shellDir, name), contents);
    }
  }
  return { workDir, mdPath, htmlPath };
}

describe("document shell hook: masthead injection", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-masthead-",
      md: "# Hello\n\nDocument body paragraph.\n",
      shellFiles: {
        "shell.lua": [
          "return {",
          "  masthead = function(doc_meta)",
          "    return pandoc.Blocks({",
          '      pandoc.Div(pandoc.Plain(pandoc.Str("MH")), pandoc.Attr("", {"richmd-masthead"})),',
          "    })",
          "  end,",
          "}",
        ].join("\n"),
      },
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("emits the region's richmd-*-classed element inside the container", () => {
    assert.match(html, /<div class="richmd-masthead">/);
  });

  it("places the masthead BEFORE the document's own first block", () => {
    const mastheadIdx = html.indexOf('class="richmd-masthead"');
    const bodyIdx = html.indexOf("Document body paragraph.");
    assert.ok(mastheadIdx >= 0 && bodyIdx >= 0);
    assert.ok(
      mastheadIdx < bodyIdx,
      "masthead should appear before the document body",
    );
  });

  it("places the masthead INSIDE .richmd-container", () => {
    const containerIdx = html.indexOf('class="richmd-container');
    const mastheadIdx = html.indexOf('class="richmd-masthead"');
    assert.ok(containerIdx >= 0);
    assert.ok(mastheadIdx > containerIdx);
  });
});

describe("document shell hook: colophon injection", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-colophon-",
      md: "# Hello\n\nDocument body paragraph.\n",
      shellFiles: {
        "shell.lua": [
          "return {",
          "  colophon = function(doc_meta)",
          "    return pandoc.Blocks({",
          '      pandoc.Div(pandoc.Plain(pandoc.Str("CP")), pandoc.Attr("", {"richmd-colophon"})),',
          "    })",
          "  end,",
          "}",
        ].join("\n"),
      },
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("places the colophon AFTER the document's own content, still inside the container", () => {
    const bodyIdx = html.indexOf("Document body paragraph.");
    const colophonIdx = html.indexOf('class="richmd-colophon"');
    assert.ok(bodyIdx >= 0 && colophonIdx >= 0);
    assert.ok(
      colophonIdx > bodyIdx,
      "colophon should appear after the document body",
    );
    // It must land inside the container, not after it: the container's own
    // closing occurs somewhere after the colophon, and the toggle script
    // (emitted after the container) comes later still.
    const containerIdx = html.indexOf('class="richmd-container');
    assert.ok(containerIdx >= 0 && colophonIdx > containerIdx);
  });
});

describe("document shell hook: both regions defined", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-both-",
      md: "# Hello\n\nDocument body paragraph.\n",
      shellFiles: {
        "shell.lua": [
          "return {",
          "  masthead = function(doc_meta)",
          "    return pandoc.Blocks({",
          '      pandoc.Div(pandoc.Plain(pandoc.Str("MH")), pandoc.Attr("", {"richmd-masthead"})),',
          "    })",
          "  end,",
          "  colophon = function(doc_meta)",
          "    return pandoc.Blocks({",
          '      pandoc.Div(pandoc.Plain(pandoc.Str("CP")), pandoc.Attr("", {"richmd-colophon"})),',
          "    })",
          "  end,",
          "}",
        ].join("\n"),
      },
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("places masthead before body and colophon after body", () => {
    const mastheadIdx = html.indexOf('class="richmd-masthead"');
    const bodyIdx = html.indexOf("Document body paragraph.");
    const colophonIdx = html.indexOf('class="richmd-colophon"');
    assert.ok(mastheadIdx >= 0 && bodyIdx >= 0 && colophonIdx >= 0);
    assert.ok(mastheadIdx < bodyIdx);
    assert.ok(bodyIdx < colophonIdx);
  });
});

describe("document shell hook: absent directory renders as today", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-absent-",
      md: "# Hello\n\nJust a plain paragraph.\n",
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("injects no masthead or colophon when there is no .richmd/shell/", () => {
    assert.doesNotMatch(html, /richmd-masthead/);
    assert.doesNotMatch(html, /richmd-colophon/);
  });

  it("still emits the standard shell (container + topbar) unchanged", () => {
    assert.match(html, /<div class="richmd-doc"/);
    assert.match(html, /<div class="richmd-topbar">/);
    assert.match(html, /<div class="richmd-container richmd-container--wide">/);
    assert.match(html, /Just a plain paragraph\./);
  });
});

describe("document shell hook: region receives real doc.meta", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-meta-",
      md: [
        "---",
        "eyebrow: Field Notes",
        "---",
        "",
        "# Hello",
        "",
        "Document body paragraph.",
        "",
      ].join("\n"),
      shellFiles: {
        "shell.lua": [
          "return {",
          "  masthead = function(doc_meta)",
          "    local eyebrow = pandoc.utils.stringify(doc_meta.eyebrow or {})",
          "    return pandoc.Blocks({",
          '      pandoc.Div(pandoc.Plain(pandoc.Str(eyebrow)), pandoc.Attr("", {"richmd-eyebrow"})),',
          "    })",
          "  end,",
          "}",
        ].join("\n"),
      },
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("threads doc.meta through: a frontmatter key read by the region appears in output", () => {
    assert.match(html, /<div class="richmd-eyebrow">/);
    assert.match(html, /Field Notes/);
  });
});

describe("document shell hook: singleton fail-loud (two masthead files)", () => {
  let ctx;
  let result;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-dup-",
      md: "# Hello\n\nBody.\n",
      shellFiles: {
        "a.lua": [
          "return {",
          "  masthead = function(doc_meta) return pandoc.Blocks({}) end,",
          "}",
        ].join("\n"),
        "b.lua": [
          "return {",
          "  masthead = function(doc_meta) return pandoc.Blocks({}) end,",
          "}",
        ].join("\n"),
      },
    });
    result = await runCli(["render", ctx.mdPath]);
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("exits non-zero, names BOTH files, and writes no HTML", async () => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /a\.lua/);
    assert.match(result.stderr, /b\.lua/);
    assert.match(result.stderr, /masthead/);
    assert.equal(await exists(ctx.htmlPath), false);
  });
});

describe("document shell hook: malformed hook (returns a number)", () => {
  let ctx;
  let result;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-badnum-",
      md: "# Hello\n\nBody.\n",
      shellFiles: {
        "shell.lua": "return 42",
      },
    });
    result = await runCli(["render", ctx.mdPath]);
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("exits non-zero naming the file, writes no HTML", async () => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /shell\.lua/);
    assert.equal(await exists(ctx.htmlPath), false);
  });
});

describe("document shell hook: malformed hook (region is not a function)", () => {
  let ctx;
  let result;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-badregion-",
      md: "# Hello\n\nBody.\n",
      shellFiles: {
        "shell.lua": 'return { masthead = "not a function" }',
      },
    });
    result = await runCli(["render", ctx.mdPath]);
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("exits non-zero naming the file, writes no HTML", async () => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /shell\.lua/);
    assert.match(result.stderr, /masthead/);
    assert.equal(await exists(ctx.htmlPath), false);
  });
});

describe("document shell hook: render-time region returns a non-Blocks value", () => {
  let ctx;
  let result;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-nonblocks-",
      md: "# Hello\n\nBody.\n",
      shellFiles: {
        "shell.lua": [
          "return {",
          "  masthead = function(doc_meta) return 7 end,",
          "}",
        ].join("\n"),
      },
    });
    result = await runCli(["render", ctx.mdPath]);
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("hard-fails naming shell.lua and the region, writes no HTML", async () => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /shell\.lua/);
    assert.match(result.stderr, /masthead/);
    assert.equal(await exists(ctx.htmlPath), false);
  });
});

describe("document shell hook: render-time region raises", () => {
  let ctx;
  let result;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-shell-raise-",
      md: "# Hello\n\nBody.\n",
      shellFiles: {
        "shell.lua": [
          "return {",
          '  colophon = function(doc_meta) error("boom from region") end,',
          "}",
        ].join("\n"),
      },
    });
    result = await runCli(["render", ctx.mdPath]);
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("hard-fails naming shell.lua and the region, writes no HTML", async () => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /shell\.lua/);
    assert.match(result.stderr, /colophon/);
    assert.equal(await exists(ctx.htmlPath), false);
  });
});

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

// The group render hook (design.md §11 "Group render", ADR-0015) is the fifth
// consumer-declarable contract: a `.richmd/groups/*.lua` file returning
// `{ kinds = { ... }, render = function(kind, rendered_blocks) -> Blocks }`.
// In the RENDER phase richmd finds each maximal run of consecutive top-level
// blocks whose ORIGINAL kind is claimed by a hook and replaces that run with
// the hook's returned (structure-only, `richmd-*`-classed) blocks.
//
// The grouping mechanism is generic over kind — it keys on a block's KIND
// (the fenced-div class matching a registered kind), never on any attr value.
// `goal`/`no-goal` (named in issue #27) are NOT registered kinds in this repo:
// they are `type=` VALUES on the built-in `labeled-block` kind, which the
// grouping mechanism never sees. So these tests use two REAL registered
// fenced-div kinds instead:
//   * `callout`       — renders to a `.richmd-callout` div;
//   * `labeled-block` — renders to a `.richmd-statement` div.
// Both are simple fenced divs easy to author consecutively, and a third kind
// (`toc`) is used where a run needs to be split by an unclaimed block.
//
// This suite drives the real CLI (`richmd render <md>`) against tmpdir
// fixtures — the public interface — asserting behavior through the rendered
// HTML and CLI exit/stderr, exactly as test/shell-loader.test.js does. No
// internal Lua state is inspected.

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

// Builds a work dir with a document at doc.md and, optionally, a
// `.richmd/groups/` directory populated with the given { filename: contents }
// hook files.
async function makeDoc({ prefix, md, groupFiles }) {
  const workDir = await mkdtemp(path.join(tmpdir(), prefix));
  const mdPath = path.join(workDir, "doc.md");
  const htmlPath = path.join(workDir, "doc.html");
  await writeFile(mdPath, md);
  if (groupFiles) {
    const groupsDir = path.join(workDir, ".richmd", "groups");
    await mkdir(groupsDir, { recursive: true });
    for (const [name, contents] of Object.entries(groupFiles)) {
      await writeFile(path.join(groupsDir, name), contents);
    }
  }
  return { workDir, mdPath, htmlPath };
}

// A hook that wraps every run of its claimed kinds into a
// `<div class="richmd-group richmd-group--<kind>">` under an <h2> heading
// naming the kind. Threads `kind` into both the wrapper's modifier class and
// the heading text, so the argument's plumbing is observable in the HTML.
function groupHook(kinds) {
  const list = kinds.map((k) => `"${k}"`).join(", ");
  return [
    "return {",
    `  kinds = { ${list} },`,
    "  render = function(kind, rendered_blocks)",
    '    local children = { pandoc.Header(2, pandoc.Str("Group of " .. kind)) }',
    "    for _, b in ipairs(rendered_blocks) do",
    "      table.insert(children, b)",
    "    end",
    "    return pandoc.Blocks({",
    '      pandoc.Div(children, pandoc.Attr("", { "richmd-group", "richmd-group--" .. kind })),',
    "    })",
    "  end,",
    "}",
  ].join("\n");
}

// Two consecutive `:::callout` blocks with distinct bodies.
const TWO_CALLOUTS = [
  "# Title",
  "",
  '::: {.callout tint="info"}',
  "First callout body alpha.",
  ":::",
  "",
  '::: {.callout tint="warning"}',
  "Second callout body bravo.",
  ":::",
  "",
].join("\n");

// Count non-overlapping occurrences of a literal substring.
function countOf(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

describe("group hook: wraps a run of consecutive same-kind blocks", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-groups-wrap-",
      md: TWO_CALLOUTS,
      groupFiles: { "g.lua": groupHook(["callout"]) },
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("emits exactly one richmd-group--callout wrapper", () => {
    assert.equal(
      countOf(html, 'class="richmd-group richmd-group--callout"'),
      1,
    );
  });

  it("wraps BOTH callouts inside that single group, under the hook's heading", () => {
    const groupIdx = html.indexOf("richmd-group richmd-group--callout");
    assert.ok(groupIdx >= 0);
    // Both callout bodies must appear after the group opens...
    const alphaIdx = html.indexOf("First callout body alpha.");
    const bravoIdx = html.indexOf("Second callout body bravo.");
    assert.ok(alphaIdx > groupIdx && bravoIdx > groupIdx);
    // ...and the hook's own heading is present.
    assert.match(html, /Group of callout/);
    // Both original callout renders survive inside.
    assert.equal(
      countOf(html, 'class="richmd-callout richmd-callout--info"'),
      1,
    );
    assert.equal(
      countOf(html, 'class="richmd-callout richmd-callout--warning"'),
      1,
    );
  });
});

describe("group hook: a different-kind block splits a run into two groups", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-groups-split-",
      md: [
        "# Title",
        "",
        '::: {.callout tint="info"}',
        "Callout one.",
        ":::",
        "",
        '::: {.callout tint="warning"}',
        "Callout two.",
        ":::",
        "",
        "::: {.toc}",
        ":::",
        "",
        '::: {.callout tint="danger"}',
        "Callout three.",
        ":::",
        "",
        '::: {.callout tint="info"}',
        "Callout four.",
        ":::",
        "",
      ].join("\n"),
      groupFiles: { "g.lua": groupHook(["callout"]) },
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("produces TWO separate callout group wrappers (the toc between them splits the run)", () => {
    assert.equal(
      countOf(html, 'class="richmd-group richmd-group--callout"'),
      2,
    );
  });

  it("does not reach across the splitting block: the toc is not inside a group", () => {
    // The toc renders its own container; it must appear between the two
    // groups, not wrapped by either.
    assert.match(html, /richmd-toc/);
  });
});

describe("group hook: an unclaimed kind renders block-by-block, unwrapped", () => {
  let claimedHtml;
  let unclaimedHtml;
  let claimedCtx;
  let unclaimedCtx;

  before(async () => {
    // Same document rendered twice: once with a hook claiming `labeled-block`
    // (which does NOT touch the callouts), once with no hook at all.
    const md = TWO_CALLOUTS;
    claimedCtx = await makeDoc({
      prefix: "richmd-groups-unclaimed-",
      md,
      groupFiles: { "g.lua": groupHook(["labeled-block"]) },
    });
    unclaimedCtx = await makeDoc({ prefix: "richmd-groups-nohook-", md });
    const r1 = await runCli(["render", claimedCtx.mdPath]);
    const r2 = await runCli(["render", unclaimedCtx.mdPath]);
    assert.equal(r1.code, 0, `stderr was: ${r1.stderr}`);
    assert.equal(r2.code, 0, `stderr was: ${r2.stderr}`);
    claimedHtml = await readFile(claimedCtx.htmlPath, "utf8");
    unclaimedHtml = await readFile(unclaimedCtx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(claimedCtx.workDir, { recursive: true, force: true });
    await rm(unclaimedCtx.workDir, { recursive: true, force: true });
  });

  it("wraps no callout: a kind no hook claims gets no richmd-group wrapper", () => {
    assert.doesNotMatch(claimedHtml, /richmd-group/);
  });

  it("renders byte-identical to the same document with no hook at all", () => {
    assert.equal(claimedHtml, unclaimedHtml);
  });
});

describe("group hook: absent .richmd/groups/ directory renders as today", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({ prefix: "richmd-groups-absent-", md: TWO_CALLOUTS });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("injects no richmd-group anywhere", () => {
    assert.doesNotMatch(html, /richmd-group/);
  });

  it("still emits the standard page shell and both callouts", () => {
    assert.match(html, /<div class="richmd-doc"/);
    assert.match(html, /<div class="richmd-container richmd-container--wide">/);
    assert.equal(
      countOf(html, 'class="richmd-callout richmd-callout--info"'),
      1,
    );
    assert.equal(
      countOf(html, 'class="richmd-callout richmd-callout--warning"'),
      1,
    );
  });
});

describe("group hook: kind argument is threaded (one hook, two claimed kinds)", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-groups-kindarg-",
      md: [
        "# Title",
        "",
        '::: {.callout tint="info"}',
        "A callout.",
        ":::",
        "",
        "Splitter paragraph between the two runs.",
        "",
        '::: {.labeled-block type="goal"}',
        "**A goal**",
        "",
        "Goal body text.",
        ":::",
        "",
      ].join("\n"),
      // ONE hook file claiming BOTH kinds — the run's own kind is threaded in,
      // so the callout run gets richmd-group--callout and the labeled-block
      // run gets richmd-group--labeled-block.
      groupFiles: { "g.lua": groupHook(["callout", "labeled-block"]) },
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("emits a distinct modifier class per kind, driven by the kind argument", () => {
    assert.equal(
      countOf(html, 'class="richmd-group richmd-group--callout"'),
      1,
    );
    assert.equal(
      countOf(html, 'class="richmd-group richmd-group--labeled-block"'),
      1,
    );
  });

  it("threads the kind string into the hook's own emitted content", () => {
    assert.match(html, /Group of callout/);
    assert.match(html, /Group of labeled-block/);
  });
});

describe("group hook: two files claiming DIFFERENT kinds both group (OK)", () => {
  let ctx;
  let html;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-groups-twofiles-ok-",
      md: [
        "# Title",
        "",
        '::: {.callout tint="info"}',
        "A callout.",
        ":::",
        "",
        "Splitter paragraph.",
        "",
        '::: {.labeled-block type="goal"}',
        "**A goal**",
        "",
        "Goal body.",
        ":::",
        "",
      ].join("\n"),
      groupFiles: {
        "callouts.lua": groupHook(["callout"]),
        "statements.lua": groupHook(["labeled-block"]),
      },
    });
    const result = await runCli(["render", ctx.mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(ctx.htmlPath, "utf8");
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("both hooks apply: each kind gets its own group wrapper", () => {
    assert.equal(
      countOf(html, 'class="richmd-group richmd-group--callout"'),
      1,
    );
    assert.equal(
      countOf(html, 'class="richmd-group richmd-group--labeled-block"'),
      1,
    );
  });
});

describe("group hook: per-kind singleton fail-loud (two files claim callout)", () => {
  let ctx;
  let result;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-groups-dup-",
      md: TWO_CALLOUTS,
      groupFiles: {
        "a.lua": groupHook(["callout"]),
        "b.lua": groupHook(["callout"]),
      },
    });
    result = await runCli(["render", ctx.mdPath]);
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("exits non-zero, names BOTH files and the kind, and writes no HTML", async () => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /a\.lua/);
    assert.match(result.stderr, /b\.lua/);
    assert.match(result.stderr, /callout/);
    assert.equal(await exists(ctx.htmlPath), false);
  });
});

describe("group hook: malformed hook (returns a number)", () => {
  let ctx;
  let result;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-groups-badnum-",
      md: TWO_CALLOUTS,
      groupFiles: { "g.lua": "return 42" },
    });
    result = await runCli(["render", ctx.mdPath]);
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("exits non-zero naming the file, writes no HTML", async () => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /g\.lua/);
    assert.equal(await exists(ctx.htmlPath), false);
  });
});

describe("group hook: render-time hook raises", () => {
  let ctx;
  let result;

  before(async () => {
    ctx = await makeDoc({
      prefix: "richmd-groups-raise-",
      md: TWO_CALLOUTS,
      groupFiles: {
        "g.lua": [
          "return {",
          '  kinds = { "callout" },',
          "  render = function(kind, rendered_blocks)",
          '    error("boom from group hook")',
          "  end,",
          "}",
        ].join("\n"),
      },
    });
    result = await runCli(["render", ctx.mdPath]);
  });

  after(async () => {
    await rm(ctx.workDir, { recursive: true, force: true });
  });

  it("hard-fails naming the file and the kind, writes no HTML", async () => {
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /g\.lua/);
    assert.match(result.stderr, /callout/);
    assert.equal(await exists(ctx.htmlPath), false);
  });
});

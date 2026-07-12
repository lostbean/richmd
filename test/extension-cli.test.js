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

// A consumer-defined "highlight" block kind, living ENTIRELY under a temp
// `.richmd/blocks/` directory alongside the fixture `.md` file — never under
// richmd's own filter/ tree (design.md §00 goal "extend without forking";
// principle P4). Schema: no attrs, body required. Renders as a <mark>-
// wrapped div.
const HIGHLIGHT_SCHEMA = JSON.stringify({
  kind: "highlight",
  attrs: {},
  body: "required",
});

const HIGHLIGHT_LUA = [
  "-- Consumer-defined block kind: highlight. Lives under the CONSUMER's own",
  "-- .richmd/blocks/ directory, never under richmd's filter/ tree.",
  "local function render(block, resolved_attrs)",
  '  return pandoc.Div({ pandoc.Plain({ pandoc.RawInline("html", "<mark>") }) },',
  '    pandoc.Attr("", { "richmd-highlight" }))',
  "end",
  "",
  "return { render = render }",
].join("\n");

// A more faithful render_fn that actually wraps the body content in <mark>,
// used by the end-to-end rendering test below.
const HIGHLIGHT_LUA_MARK_WRAP = [
  "local function render(block, resolved_attrs)",
  "  local wrapped = pandoc.Blocks({})",
  "  for _, b in ipairs(block.content) do",
  "    wrapped:insert(b)",
  "  end",
  '  return pandoc.Div(wrapped, pandoc.Attr("", { "richmd-highlight" }))',
  "end",
  "",
  "return { render = render }",
].join("\n");

async function setupConsumerRepo({ schema, lua, markdown }) {
  const workDir = await mkdtemp(path.join(tmpdir(), "richmd-consumer-"));
  const blocksDir = path.join(workDir, ".richmd", "blocks");
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(blocksDir, "highlight.schema.json"), schema);
  await writeFile(path.join(blocksDir, "highlight.lua"), lua);

  const mdPath = path.join(workDir, "doc.md");
  await writeFile(mdPath, markdown);

  return { workDir, blocksDir, mdPath };
}

// Acceptance criterion: a document using a block kind defined ONLY in a
// `.richmd/blocks/` directory (not "callout", not any richmd built-in)
// validates and renders successfully end to end.
describe("richmd render (consumer-defined 'highlight' kind, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    ({ workDir, mdPath } = await setupConsumerRepo({
      schema: HIGHLIGHT_SCHEMA,
      lua: HIGHLIGHT_LUA_MARK_WRAP,
      markdown: "::: {.highlight}\nImportant richmd extension text.\n:::\n",
    }));
    htmlPath = path.join(workDir, "doc.html");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("writes HTML containing the consumer kind's rendered wrapper class and body text", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /richmd-highlight/);
    assert.match(html, /Important richmd extension text\./);
  });
});

// Acceptance criterion: a malformed instance of the consumer-defined kind
// (violating its OWN schema's body requirement) produces a validation error
// with the SAME shape/mechanism as a built-in kind's error.
describe("richmd validate (consumer-defined 'highlight' kind, empty body violates its own schema)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    ({ workDir, mdPath } = await setupConsumerRepo({
      schema: HIGHLIGHT_SCHEMA,
      lua: HIGHLIGHT_LUA_MARK_WRAP,
      // A highlight div with NO body content at all — violates
      // `body: "required"` from the schema above.
      markdown: "::: {.highlight}\n:::\n",
    }));
    htmlPath = path.join(workDir, "doc.html");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("reports the error via the same 'richmd: [kind] location: reason' shape used for built-ins", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.match(result.stderr, /^richmd: \[highlight\]/m);
    assert.match(result.stderr, /body is required but was empty/);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

// Acceptance criterion: a malformed schema FILE itself (invalid JSON, or
// valid JSON missing a required schema field) causes the filter to refuse
// to run entirely at STARTUP — distinct from a per-block validation error.
describe("richmd render (malformed schema FILE — invalid JSON) — startup failure", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    ({ workDir, mdPath } = await setupConsumerRepo({
      schema: "{ not: valid json at all",
      lua: HIGHLIGHT_LUA,
      markdown: "::: {.highlight}\nbody\n:::\n",
    }));
    htmlPath = path.join(workDir, "doc.html");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("names the offending schema file in the error", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /highlight\.schema\.json/);
  });

  it("writes no HTML at all", async () => {
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd render (malformed schema FILE — missing required field) — startup failure", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    ({ workDir, mdPath } = await setupConsumerRepo({
      // Valid JSON, but missing the required "body" field entirely.
      schema: JSON.stringify({ kind: "highlight", attrs: {} }),
      lua: HIGHLIGHT_LUA,
      markdown: "::: {.highlight}\nbody\n:::\n",
    }));
    htmlPath = path.join(workDir, "doc.html");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("names the offending schema file in the error", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /highlight\.schema\.json/);
  });

  it("writes no HTML at all", async () => {
    await assert.rejects(() => access(htmlPath));
  });
});

// Acceptance criterion (chunk 5 scope): loading a `.richmd/blocks/`
// extension must not change how a div NAMING a registered-but-wrong kind
// behaves, nor introduce a crash. `richmd_kind_of` returns the FIRST class
// with a registry match, so when a registered kind sits alongside an
// unrelated unregistered class, the registered kind is still found and
// validated — the unregistered sibling class is simply never reached.
//
// (A previous version of this comment flagged a div whose classes contain
// NO registry hit AT ALL — neither built-in nor extension — as a known,
// unfixed gap against design.md §04's "a missing kind is itself a
// validation error, not a silent pass-through" interface guarantee. That gap
// is now fixed in richmd_kind_of (filter/richmd-filter.lua): a classed Div
// with zero registry matches is a validation error, not a silent
// pass-through. See test/validate.test.js's "Div with an unrecognized
// class" suite for the direct proof; that fix is orthogonal to the
// extension-loader behavior asserted below.
//
// CodeBlock deliberately does NOT get the same treatment — per
// CONTEXT.md#term-block's Div/CodeBlock distinction, a code block's class
// names a syntax-highlighting language by convention (` ```js `), not a
// kind attempt, so an unrecognized CodeBlock class stays a silent
// pass-through on purpose. See test/validate.test.js's "CodeBlock with an
// unrecognized/language class" suite.)
describe("richmd validate (registered class alongside an unrelated unknown class)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    ({ workDir, mdPath } = await setupConsumerRepo({
      schema: HIGHLIGHT_SCHEMA,
      lua: HIGHLIGHT_LUA_MARK_WRAP,
      // "highlight" is registered (via the extension dir) AND has no body
      // here, which its own schema forbids — proves the extension's
      // registered kind is still found and validated even when an
      // unrelated, unregistered class sits alongside it.
      markdown: "::: {.highlight .some-unrelated-unknown-class}\n:::\n",
    }));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("still finds and validates the registered 'highlight' kind, exits non-zero", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /\[highlight\]/);
    assert.match(result.stderr, /body is required but was empty/);
  });
});

// Design constraint proof: the consumer kind above works WITHOUT any file
// under richmd's own filter/ tree being modified to know about "highlight".
// This test greps the actual richmd filter source tree for the string
// "highlight" and asserts it is never mentioned — the only place "highlight"
// exists anywhere is inside this test file's own temp fixture directory.
describe("extend without forking (design.md §00 goal, principle P4)", () => {
  it("no file under richmd's own filter/ tree mentions the consumer-defined 'highlight' kind", async () => {
    const { readdir, readFile: read } = await import("node:fs/promises");

    async function collectLuaFiles(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await collectLuaFiles(full)));
        } else if (entry.name.endsWith(".lua")) {
          files.push(full);
        }
      }
      return files;
    }

    const filterDir = path.join(repoRoot, "filter");
    const luaFiles = await collectLuaFiles(filterDir);
    assert.ok(luaFiles.length > 0, "expected to find .lua files under filter/");

    for (const file of luaFiles) {
      const contents = await read(file, "utf8");
      assert.doesNotMatch(
        contents,
        /highlight/,
        `${file} must not mention the consumer-defined 'highlight' kind`,
      );
    }
  });
});

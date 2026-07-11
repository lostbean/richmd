import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const filterDir = path.join(repoRoot, "filter");

// This suite exercises filter/extension-loader.lua in ISOLATION, narrowly,
// before it is wired into richmd-filter.lua's startup sequence at all (TDD
// directive: prove the schema-loading mechanism itself works first). It
// drives a tiny throwaway Lua probe filter through `pandoc --lua-filter`
// (the same seam every other test in this repo crosses — there is no
// standalone Lua test runner here), requiring extension-loader.lua directly
// and calling ExtensionLoader.load(registry, dir_path) against a temp
// `.richmd/blocks/` directory — never through bin/richmd.js in this file.

async function runProbe(probeLua, mdPath) {
  const probeDir = await mkdtemp(path.join(tmpdir(), "richmd-probe-"));
  const probePath = path.join(probeDir, "probe.lua");
  await writeFile(probePath, probeLua);
  try {
    const { stdout, stderr } = await execFileAsync(
      "pandoc",
      ["--lua-filter", probePath, "-o", "-", mdPath],
      { encoding: "utf8" },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  } finally {
    await rm(probeDir, { recursive: true, force: true });
  }
}

// Every probe below requires both registry.lua and extension-loader.lua by
// absolute path (via package.path), so it works regardless of the probe
// file's own temp location.
function probePreamble() {
  return (
    `package.path = "${filterDir}/?.lua;" .. package.path\n` +
    `local Registry = require("registry")\n` +
    `local ExtensionLoader = require("extension-loader")\n`
  );
}

describe("extension-loader (isolated: load a schema+lua pair)", () => {
  let workDir;
  let blocksDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-ext-loader-"));
    blocksDir = path.join(workDir, ".richmd", "blocks");
    await mkdir(blocksDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    await writeFile(
      path.join(blocksDir, "highlight.schema.json"),
      JSON.stringify({ kind: "highlight", attrs: {}, body: "required" }),
    );
    await writeFile(
      path.join(blocksDir, "highlight.lua"),
      [
        "local function render(block, resolved_attrs)",
        '  return pandoc.Div(block.content, pandoc.Attr("", { "richmd-highlight" }))',
        "end",
        "return { render = render }",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("registers a well-formed schema+lua pair into the shared registry", async () => {
    const probe =
      probePreamble() +
      `local registry = Registry.new()\n` +
      `ExtensionLoader.load(registry, "${blocksDir}")\n` +
      `local schema, render_fn = registry:lookup("highlight")\n` +
      `io.stderr:write("schema_kind=" .. tostring(schema and schema.kind) .. "\\n")\n` +
      `io.stderr:write("schema_body=" .. tostring(schema and schema.body) .. "\\n")\n` +
      `io.stderr:write("render_fn_type=" .. type(render_fn) .. "\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, /schema_kind=highlight/);
    assert.match(result.stderr, /schema_body=required/);
    assert.match(result.stderr, /render_fn_type=function/);
  });

  it("the loaded render_fn is callable and returns a pandoc AST node", async () => {
    const probe =
      probePreamble() +
      `local registry = Registry.new()\n` +
      `ExtensionLoader.load(registry, "${blocksDir}")\n` +
      `local _, render_fn = registry:lookup("highlight")\n` +
      `local fake_block = { content = pandoc.Blocks({ pandoc.Para("x") }) }\n` +
      `local node = render_fn(fake_block, {})\n` +
      `io.stderr:write("node_tag=" .. tostring(node.tag) .. "\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, /node_tag=Div/);
  });
});

describe("extension-loader (isolated: missing extension directory)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-ext-loader-missing-"));
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("does nothing (no fatal error) when the extension directory does not exist", async () => {
    const probe =
      probePreamble() +
      `local registry = Registry.new()\n` +
      `ExtensionLoader.load(registry, "${path.join(workDir, ".richmd", "blocks")}")\n` +
      `io.stderr:write("ok\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, /ok/);
  });
});

describe("extension-loader (isolated: malformed schema file is a load-time fatal error)", () => {
  let workDir;
  let blocksDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-ext-loader-bad-json-"));
    blocksDir = path.join(workDir, ".richmd", "blocks");
    await mkdir(blocksDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    await writeFile(
      path.join(blocksDir, "broken.schema.json"),
      "{ this is not valid json",
    );
    await writeFile(
      path.join(blocksDir, "broken.lua"),
      "return { render = function(block, attrs) return block.content end }",
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("raises a fatal error naming the offending schema file", async () => {
    const probe =
      probePreamble() +
      `local registry = Registry.new()\n` +
      `ExtensionLoader.load(registry, "${blocksDir}")\n` +
      `io.stderr:write("should not reach here\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /broken\.schema\.json/);
    assert.doesNotMatch(result.stderr, /should not reach here/);
  });
});

describe("extension-loader (isolated: schema missing a required field is a load-time fatal error)", () => {
  let workDir;
  let blocksDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-ext-loader-missing-field-"),
    );
    blocksDir = path.join(workDir, ".richmd", "blocks");
    await mkdir(blocksDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    // Valid JSON, but missing the required "body" field.
    await writeFile(
      path.join(blocksDir, "incomplete.schema.json"),
      JSON.stringify({ kind: "incomplete", attrs: {} }),
    );
    await writeFile(
      path.join(blocksDir, "incomplete.lua"),
      "return { render = function(block, attrs) return block.content end }",
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("raises a fatal error naming the offending schema file", async () => {
    const probe =
      probePreamble() +
      `local registry = Registry.new()\n` +
      `ExtensionLoader.load(registry, "${blocksDir}")\n` +
      `io.stderr:write("should not reach here\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /incomplete\.schema\.json/);
    assert.doesNotMatch(result.stderr, /should not reach here/);
  });
});

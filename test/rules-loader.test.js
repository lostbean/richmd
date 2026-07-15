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

// This suite exercises filter/rules-loader.lua in ISOLATION, narrowly,
// before it is wired into richmd-filter.lua's startup sequence at all (TDD
// directive: prove the rule-loading mechanism itself works first). It
// drives a tiny throwaway Lua probe filter through `pandoc --lua-filter`
// (the same seam test/extension-loader.test.js already uses), requiring
// rules-loader.lua directly and calling RulesLoader.load(dir_path) against a
// temp `.richmd/rules/` directory — never through bin/richmd.js in this
// file.

async function runProbe(probeLua, mdPath) {
  const probeDir = await mkdtemp(path.join(tmpdir(), "richmd-rules-probe-"));
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

// Every probe below requires rules-loader.lua by absolute path (via
// package.path), so it works regardless of the probe file's own temp
// location.
function probePreamble() {
  return (
    `package.path = "${filterDir}/?.lua;" .. package.path\n` +
    `local RulesLoader = require("rules-loader")\n`
  );
}

describe("rules-loader (isolated: load a single valid rule file)", () => {
  let workDir;
  let rulesDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-rules-loader-"));
    rulesDir = path.join(workDir, ".richmd", "rules");
    await mkdir(rulesDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    await writeFile(
      path.join(rulesDir, "at-most-one-callout.lua"),
      [
        "return {",
        "  check = function(block_projections, add_error)",
        "    add_error('rule:at-most-one-callout', 'div.callout', 'too many callouts')",
        "  end,",
        "}",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("loads the rule with its filename (sans .lua) as name, and a callable check", async () => {
    const probe =
      probePreamble() +
      `local rules = RulesLoader.load("${rulesDir}")\n` +
      `io.stderr:write("count=" .. #rules .. "\\n")\n` +
      `io.stderr:write("name=" .. tostring(rules[1].name) .. "\\n")\n` +
      `io.stderr:write("check_type=" .. type(rules[1].check) .. "\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, /count=1/);
    assert.match(result.stderr, /name=at-most-one-callout/);
    assert.match(result.stderr, /check_type=function/);
  });

  it("the loaded check is callable and reaches add_error with what it passed", async () => {
    const probe =
      probePreamble() +
      `local rules = RulesLoader.load("${rulesDir}")\n` +
      `local calls = {}\n` +
      `local function add_error(source, location, reason)\n` +
      `  table.insert(calls, source .. "|" .. location .. "|" .. reason)\n` +
      `end\n` +
      `rules[1].check({}, add_error)\n` +
      `io.stderr:write("call1=" .. calls[1] .. "\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(
      result.stderr,
      /call1=rule:at-most-one-callout\|div\.callout\|too many callouts/,
    );
  });
});

describe("rules-loader (isolated: bare-function rule shape)", () => {
  let workDir;
  let rulesDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-rules-loader-bare-"));
    rulesDir = path.join(workDir, ".richmd", "rules");
    await mkdir(rulesDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    await writeFile(
      path.join(rulesDir, "bare-fn-rule.lua"),
      [
        "return function(block_projections, add_error)",
        "  -- no-op rule",
        "end",
      ].join("\n"),
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("accepts a bare function as the rule's check", async () => {
    const probe =
      probePreamble() +
      `local rules = RulesLoader.load("${rulesDir}")\n` +
      `io.stderr:write("count=" .. #rules .. "\\n")\n` +
      `io.stderr:write("name=" .. tostring(rules[1].name) .. "\\n")\n` +
      `io.stderr:write("check_type=" .. type(rules[1].check) .. "\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, /count=1/);
    assert.match(result.stderr, /name=bare-fn-rule/);
    assert.match(result.stderr, /check_type=function/);
  });
});

describe("rules-loader (isolated: missing rules directory)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-rules-loader-missing-"),
    );
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("returns zero rules (no fatal error) when the rules directory does not exist", async () => {
    const probe =
      probePreamble() +
      `local rules = RulesLoader.load("${path.join(workDir, ".richmd", "rules")}")\n` +
      `io.stderr:write("count=" .. #rules .. "\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, /count=0/);
  });
});

describe("rules-loader (isolated: malformed Lua syntax is a load-time fatal error)", () => {
  let workDir;
  let rulesDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-rules-loader-badsyntax-"),
    );
    rulesDir = path.join(workDir, ".richmd", "rules");
    await mkdir(rulesDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    await writeFile(
      path.join(rulesDir, "broken.lua"),
      "this is not ) valid lua at all (((",
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("raises a fatal error naming the offending file and that it failed to load", async () => {
    const probe =
      probePreamble() +
      `local rules = RulesLoader.load("${rulesDir}")\n` +
      `io.stderr:write("should not reach here\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /broken\.lua/);
    assert.match(result.stderr, /failed to load/);
    assert.doesNotMatch(result.stderr, /should not reach here/);
  });
});

describe("rules-loader (isolated: illegal return shape — plain number — is a load-time fatal error)", () => {
  let workDir;
  let rulesDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-rules-loader-badnum-"));
    rulesDir = path.join(workDir, ".richmd", "rules");
    await mkdir(rulesDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    await writeFile(path.join(rulesDir, "not-a-function.lua"), "return 42");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("raises a fatal error naming the file and the illegal shape found", async () => {
    const probe =
      probePreamble() +
      `local rules = RulesLoader.load("${rulesDir}")\n` +
      `io.stderr:write("should not reach here\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /not-a-function\.lua/);
    assert.match(
      result.stderr,
      /neither a function nor a table with a 'check' function field/,
    );
    assert.doesNotMatch(result.stderr, /should not reach here/);
  });
});

describe("rules-loader (isolated: illegal return shape — table with non-function check — is a load-time fatal error)", () => {
  let workDir;
  let rulesDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-rules-loader-badcheck-"),
    );
    rulesDir = path.join(workDir, ".richmd", "rules");
    await mkdir(rulesDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    await writeFile(
      path.join(rulesDir, "bad-check-field.lua"),
      "return { check = 'not a function' }",
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("raises a fatal error naming the file and the illegal shape found", async () => {
    const probe =
      probePreamble() +
      `local rules = RulesLoader.load("${rulesDir}")\n` +
      `io.stderr:write("should not reach here\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /bad-check-field\.lua/);
    assert.match(
      result.stderr,
      /neither a function nor a table with a 'check' function field/,
    );
    assert.doesNotMatch(result.stderr, /should not reach here/);
  });
});

describe("rules-loader (isolated: multiple rules loaded)", () => {
  let workDir;
  let rulesDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-rules-loader-multi-"));
    rulesDir = path.join(workDir, ".richmd", "rules");
    await mkdir(rulesDir, { recursive: true });
    mdPath = path.join(workDir, "probe.md");
    await writeFile(mdPath, "probe\n");

    await writeFile(
      path.join(rulesDir, "rule-a.lua"),
      "return { check = function(bp, add_error) end }",
    );
    await writeFile(
      path.join(rulesDir, "rule-b.lua"),
      "return { check = function(bp, add_error) end }",
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("loads all rule files found in the directory", async () => {
    const probe =
      probePreamble() +
      `local rules = RulesLoader.load("${rulesDir}")\n` +
      `io.stderr:write("count=" .. #rules .. "\\n")\n` +
      `local names = {}\n` +
      `for _, r in ipairs(rules) do table.insert(names, r.name) end\n` +
      `table.sort(names)\n` +
      `io.stderr:write("names=" .. table.concat(names, ",") .. "\\n")\n` +
      `os.exit(0)\n` +
      `function Pandoc(doc) return doc end\n`;

    const result = await runProbe(probe, mdPath);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stderr, /count=2/);
    assert.match(result.stderr, /names=rule-a,rule-b/);
  });
});

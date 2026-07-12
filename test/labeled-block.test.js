import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");
const fixturesDir = path.join(__dirname, "fixtures");

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

describe("richmd render (labeled-block, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-labeled-block-valid-"),
    );
    mdPath = path.join(workDir, "labeled-block-valid.md");
    htmlPath = path.join(workDir, "labeled-block-valid.html");
    await cp(path.join(fixturesDir, "labeled-block-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("writes HTML with the statement grid wrapper, the label, and the body wrapped in a <p>, with no type-modifier class", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /class="richmd-statement"/);
    assert.doesNotMatch(html, /richmd-statement--goal/);
    assert.doesNotMatch(html, /richmd-labeled-block/);
    assert.match(
      html,
      /richmd-statement-label"[^>]*>\s*<strong>Ship the thing<\/strong>/,
    );
    assert.match(
      html,
      /<p class="richmd-statement-body">\s*Get the feature out the door with clear scope\.\s*<\/p>/,
    );
  });
});

describe("richmd validate (labeled-block, missing required type)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-labeled-block-missing-type-"),
    );
    mdPath = path.join(workDir, "labeled-block-missing-type.md");
    await cp(path.join(fixturesDir, "labeled-block-missing-type.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the missing 'type' attr", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /missing required attr 'type'/);
  });
});

describe("richmd validate (labeled-block, missing required body)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-labeled-block-missing-body-"),
    );
    mdPath = path.join(workDir, "labeled-block-missing-body.md");
    await cp(path.join(fixturesDir, "labeled-block-missing-body.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and reports the empty body", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /body is required but was empty/);
  });
});

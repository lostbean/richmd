// CLI-level (subprocess, execFile against bin/richmd.js) integration tests
// for the vega-lite block kind — mirrors test/mermaid.test.js's pattern
// exactly. Direct, in-process tests for the underlying grammar-check
// helper live in test/vega-lite-check.test.js.

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

describe("richmd render (vega-lite, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-valid-"),
    );
    mdPath = path.join(workDir, "vega-lite-valid.md");
    htmlPath = path.join(workDir, "vega-lite-valid.html");
    await cp(path.join(fixturesDir, "vega-lite-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath); // throws if missing
  });

  it("writes HTML containing the raw vega-lite JSON spec embedded in a recognizable container", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /richmd-vega-lite/);
    assert.match(html, /"mark":\s*"bar"/);
    assert.match(html, /"field":\s*"a"/);
  });

  it("writes HTML containing CDN script references for the vega-lite/vega-embed runtime", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<script[^>]*src="[^"]*cdn\.jsdelivr\.net\/npm\/vega[^"]*"/,
    );
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/vega-embed/);
  });
});

describe("richmd render (vega-lite, malformed JSON) — fail-closed gate", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-malformed-json-"),
    );
    mdPath = path.join(workDir, "vega-lite-malformed-json.md");
    htmlPath = path.join(workDir, "vega-lite-malformed-json.html");
    await cp(path.join(fixturesDir, "vega-lite-malformed-json.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("names the vega-lite block and calls out invalid JSON specifically", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /vega-lite/);
    assert.match(result.stderr, /JSON/i);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd render (vega-lite, valid JSON but invalid schema) — fail-closed gate", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-invalid-schema-"),
    );
    mdPath = path.join(workDir, "vega-lite-invalid-schema.md");
    htmlPath = path.join(workDir, "vega-lite-invalid-schema.html");
    await cp(path.join(fixturesDir, "vega-lite-invalid-schema.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("names the vega-lite block and the missing 'mark' field specifically, not a generic JSON error", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /vega-lite/);
    assert.match(result.stderr, /mark/);
    // Distinguishing check: this is NOT the "not valid JSON" failure mode —
    // the JSON itself parses fine, only the vega-lite shape is wrong.
    assert.doesNotMatch(result.stderr, /not valid JSON/);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd validate (vega-lite)", () => {
  let workDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-validate-vega-lite-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 for a valid vega-lite block, writes no HTML", async () => {
    const mdPath = path.join(workDir, "vega-lite-valid.md");
    await cp(path.join(fixturesDir, "vega-lite-valid.md"), mdPath);
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await assert.rejects(() =>
      access(path.join(workDir, "vega-lite-valid.html")),
    );
  });

  it("exits non-zero for a schema-invalid vega-lite block", async () => {
    const mdPath = path.join(workDir, "vega-lite-invalid-schema.md");
    await cp(path.join(fixturesDir, "vega-lite-invalid-schema.md"), mdPath);
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /vega-lite/);
  });
});

// richmd render --offline (design.md §02/§07, ADR-0004) — vega-lite side.
//
// Mirrors test/mermaid-offline.test.js's subprocess-driven CLI pattern
// exactly, proving the same three things for vega-lite's three-runtime
// bundle (vega, vega-lite, vega-embed) that mermaid-offline.test.js already
// proves for mermaid's single runtime:
//   1. Default mode (no flag) is unchanged: still three CDN <script src>
//      references, never an embedded runtime.
//   2. `--offline` embeds the full vega/vega-lite/vega-embed runtimes inline
//      instead of CDN references, each byte-identical to the real bundle
//      file it was read from (not truncated/corrupted).
//   3. `--offline` has no effect whatsoever on the fail-closed gate: a
//      malformed vega-lite block still fails identically, flag or no flag.

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

const vegaBundlePath = path.join(
  repoRoot,
  "node_modules",
  "vega",
  "build",
  "vega.min.js",
);
const vegaLiteBundlePath = path.join(
  repoRoot,
  "node_modules",
  "vega-lite",
  "build",
  "vega-lite.min.js",
);
const vegaEmbedBundlePath = path.join(
  repoRoot,
  "node_modules",
  "vega-embed",
  "build",
  "vega-embed.min.js",
);

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

describe("richmd render (vega-lite, default mode) — unchanged by --offline's existence", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-default-"),
    );
    mdPath = path.join(workDir, "vega-lite-valid.md");
    htmlPath = path.join(workDir, "vega-lite-valid.html");
    await cp(path.join(fixturesDir, "vega-lite-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("still emits three CDN script references and no embedded runtime JS", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<script[^>]*src="[^"]*cdn\.jsdelivr\.net\/npm\/vega@[^"]*"/,
    );
    assert.match(
      html,
      /<script[^>]*src="[^"]*cdn\.jsdelivr\.net\/npm\/vega-lite@[^"]*"/,
    );
    assert.match(
      html,
      /<script[^>]*src="[^"]*cdn\.jsdelivr\.net\/npm\/vega-embed@[^"]*"/,
    );
    // No embedded runtime: none of the three UMD bundles' own source should
    // appear inline (a distinctive marker string from each bundle's own UMD
    // header/global assignment is enough to prove absence, without needing
    // the whole file loaded here).
    assert.doesNotMatch(html, /globalThis\.vega=\{\}/);
    assert.doesNotMatch(html, /e\.vegaLite=\{\}/);
    assert.doesNotMatch(html, /e\.vegaEmbed=t\(e\.vega,e\.vegaLite\)/);
  });
});

describe("richmd render (vega-lite, --offline) — embeds all three runtimes inline", () => {
  let workDir;
  let mdPath;
  let htmlPath;
  let vegaSource;
  let vegaLiteSource;
  let vegaEmbedSource;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-offline-"),
    );
    mdPath = path.join(workDir, "vega-lite-valid.md");
    htmlPath = path.join(workDir, "vega-lite-valid.html");
    await cp(path.join(fixturesDir, "vega-lite-valid.md"), mdPath);
    [vegaSource, vegaLiteSource, vegaEmbedSource] = await Promise.all([
      readFile(vegaBundlePath, "utf8"),
      readFile(vegaLiteBundlePath, "utf8"),
      readFile(vegaEmbedBundlePath, "utf8"),
    ]);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath, "--offline"]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("contains no CDN reference anywhere in the output", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net/);
    assert.doesNotMatch(html, /unpkg\.com/);
  });

  it("embeds all three runtime bundles inline, byte-identical to their source files", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.ok(
      html.includes(vegaSource),
      "expected the HTML to contain the vega bundle source verbatim (byte-identical, not truncated)",
    );
    assert.ok(
      html.includes(vegaLiteSource),
      "expected the HTML to contain the vega-lite bundle source verbatim (byte-identical, not truncated)",
    );
    assert.ok(
      html.includes(vegaEmbedSource),
      "expected the HTML to contain the vega-embed bundle source verbatim (byte-identical, not truncated)",
    );
  });

  it("embeds the three bundles in dependency order (vega, then vega-lite, then vega-embed)", async () => {
    const html = await readFile(htmlPath, "utf8");
    const vegaIndex = html.indexOf(vegaSource);
    const vegaLiteIndex = html.indexOf(vegaLiteSource);
    const vegaEmbedIndex = html.indexOf(vegaEmbedSource);
    assert.ok(vegaIndex >= 0 && vegaLiteIndex >= 0 && vegaEmbedIndex >= 0);
    assert.ok(
      vegaIndex < vegaLiteIndex,
      "expected vega's bundle to appear before vega-lite's",
    );
    assert.ok(
      vegaLiteIndex < vegaEmbedIndex,
      "expected vega-lite's bundle to appear before vega-embed's",
    );
  });

  it("still contains the raw vega-lite spec in its recognizable container", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<div id="[^"]*" class="richmd-vega">/);
    assert.match(html, /"mark":\s*"bar"/);
  });

  it("still wraps the chart in the shared .richmd-diagram panel", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<div class="richmd-diagram">\s*<div id="[^"]*" class="richmd-vega">/,
    );
  });

  it("guards the embedded runtime with a presence check and still exposes vegaEmbed/rerender wiring", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /if\s*\(\s*!window\.vegaEmbed\s*\)\s*\{/);
    assert.match(html, /vegaEmbed\(/);
    assert.match(html, /window\.richmdDiagramRerenders\.push\(/);
  });
});

describe("richmd render --offline (vega-lite malformed input) — fail-closed gate unaffected by the flag", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-offline-malformed-"),
    );
    mdPath = path.join(workDir, "vega-lite-malformed-json.md");
    htmlPath = path.join(workDir, "vega-lite-malformed-json.html");
    await cp(path.join(fixturesDir, "vega-lite-malformed-json.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits with the same non-zero code as without --offline", async () => {
    const withFlag = await runCli(["render", mdPath, "--offline"]);
    const withoutFlag = await runCli(["render", mdPath]);
    assert.notEqual(withFlag.code, 0);
    assert.equal(withFlag.code, withoutFlag.code);
  });

  it("names the same vega-lite error on stderr, with or without --offline", async () => {
    const withFlag = await runCli(["render", mdPath, "--offline"]);
    const withoutFlag = await runCli(["render", mdPath]);
    assert.match(withFlag.stderr, /vega-lite/);
    assert.match(withFlag.stderr, /JSON/i);
    assert.equal(withFlag.stderr, withoutFlag.stderr);
  });

  it("writes no HTML either way", async () => {
    await runCli(["render", mdPath, "--offline"]);
    await assert.rejects(() => access(htmlPath));
  });
});

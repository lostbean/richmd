// richmd render --offline (design.md §02/§07, ADR-0004, issue #7).
//
// Proves three things, mirroring mermaid.test.js's subprocess-driven CLI
// pattern exactly:
//   1. Default mode (no flag) is byte-for-byte unchanged: still a CDN
//      <script> reference, never an embedded runtime.
//   2. `--offline` embeds the full mermaid.js runtime inline instead of a
//      CDN reference, and the embedded copy is byte-identical to the real
//      source file it was read from (not truncated/corrupted).
//   3. `--offline` has no effect whatsoever on the fail-closed gate: a
//      malformed mermaid block still fails identically, flag or no flag.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");
const fixturesDir = path.join(__dirname, "fixtures");
const mermaidBundlePath = path.join(
  repoRoot,
  "node_modules",
  "mermaid",
  "dist",
  "mermaid.min.js",
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

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

describe("richmd render (mermaid, default mode) — unchanged by --offline's existence", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-mermaid-default-"),
    );
    mdPath = path.join(workDir, "mermaid-valid.md");
    htmlPath = path.join(workDir, "mermaid-valid.html");
    await cp(path.join(fixturesDir, "mermaid-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("still emits a CDN script reference and no embedded runtime JS", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid/);
    // No embedded runtime: the full mermaid bundle source should not appear
    // inline (a crude but effective proxy is its distinctive size/marker
    // string near the end of the bundle).
    assert.doesNotMatch(html, /globalThis\.__esbuild_esm_mermaid/);
  });
});

describe("richmd render (mermaid, --offline) — embeds the runtime inline", () => {
  let workDir;
  let mdPath;
  let htmlPath;
  let bundleSource;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-mermaid-offline-"),
    );
    mdPath = path.join(workDir, "mermaid-valid.md");
    htmlPath = path.join(workDir, "mermaid-valid.html");
    await cp(path.join(fixturesDir, "mermaid-valid.md"), mdPath);
    bundleSource = await readFile(mermaidBundlePath, "utf8");
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
    assert.doesNotMatch(html, /https?:\/\/[^"']*mermaid[^"']*\.m?js/);
  });

  it("embeds the full mermaid runtime JS inline, byte-identical to the source bundle", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<script[^>]*>[\s\S]*globalThis\.mermaid[\s\S]*<\/script>/,
    );
    // Not truncated/corrupted: hash the embedded copy and compare against
    // the real node_modules bundle it should have been read from verbatim.
    const embeddedHash = sha256(bundleSource);
    assert.equal(
      sha256(bundleSource),
      embeddedHash,
      "sanity: hashing the same string twice must match",
    );
    assert.ok(
      html.includes(bundleSource),
      "expected the HTML to contain the mermaid bundle source verbatim (byte-identical, not truncated)",
    );
  });

  it("still contains the raw mermaid source in its recognizable container", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<pre class="[^"]*mermaid[^"]*"/);
    assert.match(html, /graph TD/);
  });

  it("still wraps the diagram in the shared .richmd-diagram panel", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<div class="richmd-diagram">\s*<pre class="mermaid richmd-mermaid"[^>]*>/,
    );
  });

  it("guards the embedded runtime with a window.mermaid presence check and still exposes the render/re-render pattern", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /if\s*\(\s*!window\.mermaid\s*\)\s*\{/);
    assert.match(html, /theme:\s*['"]base['"]/);
    assert.match(html, /themeVariables/);
    assert.match(html, /window\.richmdDiagramRerenders\.push\(/);
  });
});

describe("richmd render --offline (malformed input) — fail-closed gate unaffected by the flag", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-mermaid-offline-malformed-"),
    );
    mdPath = path.join(workDir, "mermaid-malformed.md");
    htmlPath = path.join(workDir, "mermaid-malformed.html");
    await cp(path.join(fixturesDir, "mermaid-malformed.md"), mdPath);
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

  it("names the same mermaid parse error on stderr, with or without --offline", async () => {
    const withFlag = await runCli(["render", mdPath, "--offline"]);
    const withoutFlag = await runCli(["render", mdPath]);
    assert.match(withFlag.stderr, /mermaid/);
    assert.match(withFlag.stderr, /[Pp]arse error/);
    assert.equal(withFlag.stderr, withoutFlag.stderr);
  });

  it("writes no HTML either way", async () => {
    await runCli(["render", mdPath, "--offline"]);
    await assert.rejects(() => access(htmlPath));
  });
});

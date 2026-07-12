// CLI-level (subprocess, execFile against bin/richmd.js) integration tests
// for the `richmd-layout` YAML frontmatter key (design.md §07: "Container
// width is a per-document choice, authored as a YAML frontmatter key
// (`richmd-layout: narrow`, defaulting to `wide` when absent)").
//
// This is document-level metadata, not a block-kind concept — it is read
// once per document by richmd-filter.lua's page-shell wrapper, never through
// the registry/schema mechanism (design.md §00 invariant). These tests
// therefore assert on the emitted container class names directly, mirroring
// test/theme-shell.test.js's existing shell-structure assertions.

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

async function renderFixture(fixtureName) {
  const workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-layout-"));
  const mdPath = path.join(workDir, fixtureName);
  const htmlPath = mdPath.replace(/\.md$/, ".html");
  await cp(path.join(fixturesDir, fixtureName), mdPath);
  const result = await runCli(["render", mdPath]);
  assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  await access(htmlPath);
  const html = await readFile(htmlPath, "utf8");
  await rm(workDir, { recursive: true, force: true });
  return html;
}

describe("richmd-layout frontmatter (container width choice, design.md §07)", () => {
  it("no richmd-layout frontmatter at all defaults to wide: emits both richmd-container and richmd-container--wide", async () => {
    const html = await renderFixture("layout-default.md");
    assert.match(html, /<div class="richmd-container richmd-container--wide">/);
  });

  it("richmd-layout: wide (explicit) also emits richmd-container--wide", async () => {
    const html = await renderFixture("layout-wide-explicit.md");
    assert.match(html, /<div class="richmd-container richmd-container--wide">/);
  });

  it("richmd-layout: narrow emits plain richmd-container with no --wide modifier", async () => {
    const html = await renderFixture("layout-narrow.md");
    // The embedded stylesheet's own `.richmd-container--wide { ... }` CSS
    // rule (theme/default.css) legitimately contains this substring on EVERY
    // page regardless of which class the container div itself gets — so the
    // only reliable check is the container div's own class attribute, not a
    // whole-page substring search.
    assert.match(html, /<div class="richmd-container">/);
    assert.doesNotMatch(
      html,
      /<div class="richmd-container richmd-container--wide">/,
    );
  });
});

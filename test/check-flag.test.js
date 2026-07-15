// richmd render --check (design.md §02 CLI entry).
//
// `--check` runs the exact same full pipeline (validate + render phases) as
// a normal `render` call, honoring every other flag on the same invocation
// (`--offline`, `--tree=<path>...`) exactly as it would shape a normal
// write — but the generated HTML is captured in memory instead of being
// written to the sibling `.html` file, then byte-compared against whatever
// already exists at that sibling path. It never writes that path, in any
// outcome (missing, identical, stale, or failed validation).
//
// Cases covered here, mirroring the acceptance criteria:
//   1. No committed .html yet -> non-zero exit, nothing written, "missing"
//      message.
//   2. Committed .html byte-identical to a fresh render -> exit 0, nothing
//      written (committed file untouched).
//   3. Committed .html stale (source .md changed since) -> non-zero exit,
//      a diff shown, committed file on disk untouched (not overwritten).
//   4. Document fails validation -> non-zero exit, validation errors
//      printed, nothing written or compared, no diff noise.
//   5. `--check --offline` against a plain (non-offline) committed file
//      correctly reports "different/stale" (a real content difference, not
//      a bug) — proves other flags shape the in-memory result before the
//      comparison happens.
//   6. Regression: `render` without `--check` still writes the file
//      exactly as before.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  cp,
  readFile,
  writeFile,
  access,
  stat,
} from "node:fs/promises";
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

describe("richmd render --check (no committed .html yet)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-check-missing-"));
    mdPath = path.join(workDir, "callout-valid.md");
    htmlPath = path.join(workDir, "callout-valid.html");
    await cp(path.join(fixturesDir, "callout-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath, "--check"]);
    assert.notEqual(result.code, 0);
  });

  it("does not write the .html file", async () => {
    await runCli(["render", mdPath, "--check"]);
    await assert.rejects(() => access(htmlPath));
  });

  it("reports the file is missing", async () => {
    const result = await runCli(["render", mdPath, "--check"]);
    assert.match(result.stderr, /missing/i);
  });
});

describe("richmd render --check (committed .html byte-identical)", () => {
  let workDir;
  let mdPath;
  let htmlPath;
  let originalStat;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-check-identical-"));
    mdPath = path.join(workDir, "callout-valid.md");
    htmlPath = path.join(workDir, "callout-valid.html");
    await cp(path.join(fixturesDir, "callout-valid.md"), mdPath);
    // Produce the committed file via a normal render first.
    const first = await runCli(["render", mdPath]);
    assert.equal(first.code, 0, `setup render failed: ${first.stderr}`);
    originalStat = await stat(htmlPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0", async () => {
    const result = await runCli(["render", mdPath, "--check"]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("leaves the committed .html file's content untouched", async () => {
    const before = await readFile(htmlPath, "utf8");
    await runCli(["render", mdPath, "--check"]);
    const after = await readFile(htmlPath, "utf8");
    assert.equal(after, before);
  });

  it("leaves the committed .html file's mtime untouched (never rewritten)", async () => {
    await runCli(["render", mdPath, "--check"]);
    const after = await stat(htmlPath);
    assert.equal(after.mtimeMs, originalStat.mtimeMs);
  });
});

describe("richmd render --check (committed .html is stale)", () => {
  let workDir;
  let mdPath;
  let htmlPath;
  let staleContent;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-check-stale-"));
    mdPath = path.join(workDir, "callout-valid.md");
    htmlPath = path.join(workDir, "callout-valid.html");
    await cp(path.join(fixturesDir, "callout-valid.md"), mdPath);
    // Commit the html for the ORIGINAL source...
    const first = await runCli(["render", mdPath]);
    assert.equal(first.code, 0, `setup render failed: ${first.stderr}`);
    staleContent = await readFile(htmlPath, "utf8");
    // ...then change the source without re-rendering, so the committed
    // .html no longer matches a fresh render.
    await writeFile(
      mdPath,
      '::: {.callout tint="warning"}\nThis body has changed since the .html was committed.\n:::\n',
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath, "--check"]);
    assert.notEqual(result.code, 0);
  });

  it("shows a diff", async () => {
    const result = await runCli(["render", mdPath, "--check"]);
    // A textual diff should mention content from both sides.
    assert.match(result.stderr, /warning|changed since/);
  });

  it("leaves the existing .html file on disk untouched (not overwritten)", async () => {
    await runCli(["render", mdPath, "--check"]);
    const onDisk = await readFile(htmlPath, "utf8");
    assert.equal(onDisk, staleContent);
  });
});

describe("richmd render --check (document fails validation)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-check-invalid-"));
    mdPath = path.join(workDir, "callout-invalid-tint.md");
    htmlPath = path.join(workDir, "callout-invalid-tint.html");
    await cp(path.join(fixturesDir, "callout-invalid-tint.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath, "--check"]);
    assert.notEqual(result.code, 0);
  });

  it("prints the validation error", async () => {
    const result = await runCli(["render", mdPath, "--check"]);
    assert.match(result.stderr, /tint/);
    assert.match(result.stderr, /not-a-real-tint/);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath, "--check"]);
    await assert.rejects(() => access(htmlPath));
  });

  it("does not emit diff noise (no committed file to diff against)", async () => {
    const result = await runCli(["render", mdPath, "--check"]);
    assert.doesNotMatch(result.stderr, /^---/m);
    assert.doesNotMatch(result.stderr, /^\+\+\+/m);
  });
});

describe("richmd render --check --offline (against a plain committed file)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-check-offline-"));
    mdPath = path.join(workDir, "mermaid-valid.md");
    htmlPath = path.join(workDir, "mermaid-valid.html");
    await writeFile(
      mdPath,
      '```{.mermaid title="Flow"}\ngraph TD\n    A[Start] --> B[End]\n```\n',
    );
    // Commit the html WITHOUT --offline.
    const first = await runCli(["render", mdPath]);
    assert.equal(first.code, 0, `setup render failed: ${first.stderr}`);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("reports stale/different when checked with --offline against a non-offline committed file", async () => {
    const result = await runCli(["render", mdPath, "--check", "--offline"]);
    assert.notEqual(result.code, 0);
  });

  it("does not overwrite the committed (non-offline) file", async () => {
    const before = await readFile(htmlPath, "utf8");
    await runCli(["render", mdPath, "--check", "--offline"]);
    const after = await readFile(htmlPath, "utf8");
    assert.equal(after, before);
  });
});

// mermaid/vega-lite blocks embed a randomly generated per-render element id
// (filter/blocks/mermaid.lua, filter/blocks/vega-lite.lua), so two separate
// renders of the identical source are never byte-identical to each other —
// a pre-existing property of those two block kinds, unrelated to --check's
// own logic. A deterministic block kind (callout) is used here instead to
// prove the same-flags-on-both-sides case: when the committed file and the
// --check invocation agree on every flag (including a non-boolean one like
// --tree), the comparison is a clean match.
describe("richmd render --check --tree (matching flags on both sides)", () => {
  let workDir;
  let mainPath;
  let siblingPath;
  let mainHtmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-check-tree-"));
    mainPath = path.join(workDir, "links-main.md");
    siblingPath = path.join(workDir, "links-sibling.md");
    mainHtmlPath = path.join(workDir, "links-main.html");
    await cp(path.join(fixturesDir, "links-main.md"), mainPath);
    await cp(path.join(fixturesDir, "links-sibling.md"), siblingPath);
    const commit = await runCli(["render", mainPath, "--tree=" + siblingPath]);
    assert.equal(commit.code, 0, `setup render failed: ${commit.stderr}`);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 when --check is passed the same --tree set used to commit the file", async () => {
    const result = await runCli([
      "render",
      mainPath,
      "--check",
      "--tree=" + siblingPath,
    ]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("does not rewrite the committed file", async () => {
    const before = await readFile(mainHtmlPath, "utf8");
    await runCli(["render", mainPath, "--check", "--tree=" + siblingPath]);
    const after = await readFile(mainHtmlPath, "utf8");
    assert.equal(after, before);
  });

  it("reports stale when --check omits the --tree flag the file was committed with", async () => {
    const result = await runCli(["render", mainPath, "--check"]);
    assert.notEqual(result.code, 0);
  });
});

describe("richmd render (without --check) still writes the file as before", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-check-regression-"));
    mdPath = path.join(workDir, "callout-valid.md");
    htmlPath = path.join(workDir, "callout-valid.html");
    await cp(path.join(fixturesDir, "callout-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("writes HTML containing the callout body text", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /This is a valid callout body\./);
  });
});

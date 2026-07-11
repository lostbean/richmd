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

describe("richmd render (mermaid, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-mermaid-valid-"),
    );
    mdPath = path.join(workDir, "mermaid-valid.md");
    htmlPath = path.join(workDir, "mermaid-valid.html");
    await cp(path.join(fixturesDir, "mermaid-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath); // throws if missing
  });

  it("writes HTML containing the raw mermaid source in a recognizable container", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<pre class="[^"]*mermaid[^"]*"/);
    assert.match(html, /graph TD/);
    assert.match(html, /A\[Start\]/);
  });

  it("writes HTML containing a CDN script tag referencing the mermaid.js runtime", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<script[^>]*>/);
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid/);
  });
});

describe("richmd render (mermaid, malformed input) — fail-closed gate", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-mermaid-malformed-"),
    );
    mdPath = path.join(workDir, "mermaid-malformed.md");
    htmlPath = path.join(workDir, "mermaid-malformed.html");
    await cp(path.join(fixturesDir, "mermaid-malformed.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("names the mermaid block and the parser's specific reason on stderr", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /mermaid/);
    // The parser's own reason should be surfaced, not just a generic
    // "invalid mermaid" message — expect a mention of a parse error.
    assert.match(result.stderr, /[Pp]arse error/);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

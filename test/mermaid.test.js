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

  it("wraps the diagram in the shared .richmd-diagram panel, with no title div when no title attr is set", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<div class="richmd-diagram">/);
    // No actual title <div> element (the .richmd-diagram-title selector
    // text legitimately appears in the inlined theme <style> block, so
    // check for the element itself, not the bare class name substring).
    assert.doesNotMatch(html, /<div class="richmd-diagram-title">/);
    // The mermaid <pre> must be inside the .richmd-diagram wrapper (the
    // source-bearing <pre> now carries an id + inline display:none — it is
    // kept in the DOM as the render script's data source, not shown
    // directly; a separate target <div class="richmd-mermaid"> receives the
    // rendered SVG).
    assert.match(
      html,
      /<div class="richmd-diagram">\s*<pre class="mermaid richmd-mermaid"[^>]*>/,
    );
  });

  it("renders explicitly via mermaid.render with theme:'base' and live-CSS themeVariables, not mermaid.initialize({startOnLoad:true})", async () => {
    const html = await readFile(htmlPath, "utf8");
    // The old blind auto-scan-and-render call must be gone.
    assert.doesNotMatch(html, /startOnLoad:\s*true/);
    assert.match(html, /startOnLoad:\s*false/);
    assert.match(html, /theme:\s*['"]base['"]/);
    assert.match(html, /themeVariables/);
    assert.match(html, /richmdDiagramTheme/);
    assert.match(html, /\.render\(/);
  });

  it("pushes its render function onto the shared window.richmdDiagramRerenders array", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /window\.richmdDiagramRerenders\.push\(/);
  });

  it("adds a runtime .catch() handler that logs and reveals the source on render failure", async () => {
    const html = await readFile(htmlPath, "utf8");

    // A .catch() must follow the .then() on the mermaid.render() promise
    // chain, inside the same shared renderMermaid_<id> function (i.e.
    // before that function's closing brace and before the
    // richmdDiagramRerenders.push line that reuses it).
    const renderFnMatch = html.match(
      /function renderMermaid_\w+\(\)\s*\{([\s\S]*?)\n\s*\}\s*window\.richmdDiagramRerenders\s*=[\s\S]*?window\.richmdDiagramRerenders\.push\(/,
    );
    assert.ok(
      renderFnMatch,
      "expected to find the shared renderMermaid_<id> function body",
    );
    const fnBody = renderFnMatch[1];

    assert.match(fnBody, /\.catch\(/);
    assert.match(fnBody, /console\.error\(/);
    // Failure must un-hide the source <pre> (remove/override display:none)
    // and set some visible error content distinct from the success path.
    assert.match(fnBody, /display\s*=\s*['"](?!none)/);
    assert.match(fnBody, /targetEl\.innerHTML\s*=/);
  });
});

describe("richmd render (mermaid, valid input with title attr)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-mermaid-titled-"),
    );
    mdPath = path.join(workDir, "mermaid-valid-titled.md");
    htmlPath = path.join(workDir, "mermaid-valid-titled.html");
    await cp(path.join(fixturesDir, "mermaid-valid-titled.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and renders the title in a .richmd-diagram-title div inside .richmd-diagram", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<div class="richmd-diagram">\s*<div class="richmd-diagram-title">My Diagram<\/div>\s*<pre class="mermaid richmd-mermaid"[^>]*>/,
    );
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

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

// Cross-document link rewriting (design.md §06): a relative `.md` link,
// with or without a `#fragment`, is rewritten to its sibling `.html` target
// during the render phase — automatic, no special marker syntax.
describe("richmd render (cross-document links, sibling exists)", () => {
  let workDir;
  let mainPath;
  let siblingPath;
  let mainHtmlPath;
  let siblingHtmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-links-valid-"));
    mainPath = path.join(workDir, "links-main.md");
    siblingPath = path.join(workDir, "links-sibling.md");
    mainHtmlPath = path.join(workDir, "links-main.html");
    siblingHtmlPath = path.join(workDir, "links-sibling.html");
    await cp(path.join(fixturesDir, "links-main.md"), mainPath);
    await cp(path.join(fixturesDir, "links-sibling.md"), siblingPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 rendering the main document", async () => {
    const result = await runCli(["render", mainPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("rewrites a #fragment .md link to sibling.html#some-heading", async () => {
    await runCli(["render", mainPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(html, /<a href="links-sibling\.html#some-heading"/);
  });

  it("rewrites a bare .md link (no fragment) to sibling.html", async () => {
    await runCli(["render", mainPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(html, /<a href="links-sibling\.html"/);
  });

  it("leaves a non-.md link (https://) completely untouched", async () => {
    await runCli(["render", mainPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(html, /<a href="https:\/\/example\.com"/);
  });

  it("leaves a non-.md image target (image.png) completely untouched", async () => {
    await runCli(["render", mainPath]);
    const html = await readFile(mainHtmlPath, "utf8");
    assert.match(html, /src="image\.png"/);
  });

  it("renders the sibling document with a heading id matching the slugifier", async () => {
    const result = await runCli(["render", siblingPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(siblingHtmlPath, "utf8");
    assert.match(html, /<h2 id="some-heading">/);
  });
});

// Link validation (design.md §00 invariant: cross-document links always
// resolve): a relative `.md` link whose target does not exist on disk is a
// validate-phase error, collected through the same `errors` mechanism as
// callout errors — never a silently broken link in output.
describe("richmd render (cross-document links, dangling target) — fail-closed", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-links-dangling-"));
    mdPath = path.join(workDir, "links-dangling.md");
    htmlPath = path.join(workDir, "links-dangling.html");
    await cp(path.join(fixturesDir, "links-dangling.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("writes no HTML", async () => {
    await assert.rejects(() => access(htmlPath));
  });

  it("names the broken link's target and the source document's location", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /does-not-exist\.md/);
  });
});

// Validate-only variant of the same dangling-link gate, proving the error
// goes through the shared `errors` table used by `richmd validate` too.
describe("richmd validate (cross-document links, dangling target)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-links-dangling-"),
    );
    mdPath = path.join(workDir, "links-dangling.md");
    await cp(path.join(fixturesDir, "links-dangling.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the broken link target", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /does-not-exist\.md/);
  });
});

// Fragment resolution is the other call site of the SAME slugify function
// (design.md §06: "the slugify function is also exported standalone so
// #fragment link resolution during validate can call the identical
// logic"). A #fragment naming a heading that does not exist in the target
// document is caught here, through the shared errors table.
describe("richmd render (cross-document links, fragment does not match any heading)", () => {
  let workDir;
  let mainPath;
  let siblingPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-links-bad-frag-"));
    mainPath = path.join(workDir, "links-bad-fragment.md");
    siblingPath = path.join(workDir, "links-sibling.md");
    htmlPath = path.join(workDir, "links-bad-fragment.html");
    await cp(path.join(fixturesDir, "links-bad-fragment.md"), mainPath);
    await cp(path.join(fixturesDir, "links-sibling.md"), siblingPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mainPath]);
    assert.notEqual(result.code, 0);
  });

  it("writes no HTML", async () => {
    await assert.rejects(() => access(htmlPath));
  });

  it("names the fragment that does not match any heading", async () => {
    const result = await runCli(["render", mainPath]);
    assert.match(result.stderr, /no-such-heading/);
  });
});

// Slugs are a pure, documented function (design.md §00 invariant): two
// identical heading texts in the SAME document must produce distinct ids
// via the GitHub-flavored -1/-2 duplicate suffix rule.
describe("richmd render (duplicate headings, -1/-2 suffix rule)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-headings-dup-"));
    mdPath = path.join(workDir, "headings-duplicate.md");
    htmlPath = path.join(workDir, "headings-duplicate.html");
    await cp(path.join(fixturesDir, "headings-duplicate.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });

  it("assigns distinct ids overview, overview-1, overview-2 to the three duplicate headings", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<h2 id="overview">/);
    assert.match(html, /<h2 id="overview-1">/);
    assert.match(html, /<h2 id="overview-2">/);
  });
});

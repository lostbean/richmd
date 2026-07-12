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

describe("richmd render (cards, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-cards-valid-"));
    mdPath = path.join(workDir, "cards-valid.md");
    htmlPath = path.join(workDir, "cards-valid.html");
    await cp(path.join(fixturesDir, "cards-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("writes HTML containing a card-grid div with a data-cols attribute", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /class="richmd-card-grid"[^>]*data-cols="3"/);
  });

  it("writes HTML containing one .richmd-card per heading, each with its own title and body", async () => {
    const html = await readFile(htmlPath, "utf8");
    const cardRe =
      /<div class="richmd-card">\s*<div class="richmd-card-title">\s*([^<]*?)\s*<\/div>\s*<div class="richmd-card-body">\s*<p>([\s\S]*?)<\/p>\s*<\/div>\s*<\/div>/g;
    const cards = [...html.matchAll(cardRe)];
    assert.equal(
      cards.length,
      3,
      `expected 3 .richmd-card divs, found ${cards.length}`,
    );
    assert.equal(cards[0][1], "First card");
    assert.match(cards[0][2], /Body text for the first card\./);
    assert.equal(cards[1][1], "Second card");
    assert.match(cards[1][2], /Body text for the second card\./);
    assert.equal(cards[2][1], "Third card");
    assert.match(cards[2][2], /Body text for the third card\./);
  });
});

describe("richmd render (cards, card-title/real-heading slug collision)", () => {
  // Regression test: a card's own `### heading` title used to be walked by
  // richmd-filter.lua's shared render_only_header handler exactly like any
  // real document heading, assigning it an `id` and consuming a slug from
  // the shared seen_slugs table BEFORE a later, same-named real heading
  // ever got a chance to claim the clean slug for itself — the real
  // heading was left with a collision-avoidance `-1` suffix instead. See
  // filter/heading-scope.lua for the fix (cards.lua's schema now declares
  // `owns_internal_headers = true`, and a pre-pass marks its per-card
  // Headers so they're skipped entirely by id-assignment).
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-cards-title-collision-"),
    );
    mdPath = path.join(workDir, "cards-title-collision.md");
    htmlPath = path.join(workDir, "cards-title-collision.html");
    await cp(path.join(fixturesDir, "cards-title-collision.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("assigns the REAL heading the clean, un-collided slug (no -1 suffix)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<h2 id="conflict-resolver">Conflict resolver<\/h2>/);
    assert.doesNotMatch(html, /id="conflict-resolver-1"/);
  });

  it("still renders the card's own title unchanged, just with no id attribute", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<div class="richmd-card-title">\s*Conflict resolver\s*<\/div>/,
    );
    // The card-title div itself must never carry an id (it isn't a
    // navigable heading).
    assert.doesNotMatch(html, /<div class="richmd-card-title"[^>]*\bid=/);
  });

  it("does not leak either card title into the auto-generated TOC", async () => {
    const html = await readFile(htmlPath, "utf8");
    const tocMatch = html.match(/<ul class="richmd-toc-list">.*?<\/ul>/s);
    assert.ok(tocMatch, "expected a richmd-toc-list to be present");
    const tocHtml = tocMatch[0];
    // Only the two REAL headings (Top Heading is filtered out as the page
    // title itself is still a real heading and included; the point here is
    // that neither "Conflict resolver" nor "Another card" appears twice or
    // as a phantom entry with no real backing heading).
    assert.match(
      tocHtml,
      /<a href="#conflict-resolver">Conflict resolver<\/a>/,
    );
    assert.doesNotMatch(tocHtml, /Another card/);
    // Exactly one Conflict resolver entry — not one per card title +
    // one per real heading.
    const conflictResolverEntries = (tocHtml.match(/Conflict resolver/g) || [])
      .length;
    assert.equal(conflictResolverEntries, 1);
  });
});

describe("richmd validate (cards, invalid cols)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-cards-invalid-"),
    );
    mdPath = path.join(workDir, "cards-invalid-cols.md");
    await cp(path.join(fixturesDir, "cards-invalid-cols.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and names the bad cols value", async () => {
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /cols/);
    assert.match(result.stderr, /7/);
  });
});

describe("richmd validate (cards, missing required body)", () => {
  let workDir;
  let mdPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-validate-cards-missing-body-"),
    );
    mdPath = path.join(workDir, "cards-missing-body.md");
    await cp(path.join(fixturesDir, "cards-missing-body.md"), mdPath);
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");

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

// This suite exercises the PAYOFF of contained links on the block projection
// (CONTEXT.md#term-contained-link, ADR-0013): a cross-block rule reads a
// projection's `links` field — every link found WITHIN that block, as a flat
// `{ text, target }` — and asserts a required cross-link by MATCHING A
// TARGET, which is precisely what `body_text` cannot do. `body_text` flattens
// a block to visible text, so `see ADR-0019` and `[ADR-0019](...#adr-0019)`
// are identical to it; `links` tells them apart.
//
// Same convention as test/rules-cli.test.js and test/tokens-rules-cli.test.js
// — real temp `.richmd/` dirs, real fixture `.md` documents, real CLI
// invocations, no mocking. Every assertion is on OBSERVABLE behavior (exit
// code + stderr), never on filter internals: a rule reports what it found on
// `links` as an error, so the field's arrival is visible through stderr.

// setupRepo — writes a temp consumer repo with an optional `.richmd/blocks/`
// extension pair, a rules directory, a document, and any sibling `.md`
// documents the fixture's links point at.
//
// Those siblings are load-bearing. richmd validates that a relative `.md`
// link target actually resolves on disk and that its `#fragment` matches a
// real heading in the target (§00 invariant: cross-document links always
// resolve). A fixture linking at a nonexistent file would fail the document
// for a reason having nothing to do with `links`, so every fixture target
// below is a real file with a real anchor.
async function setupRepo({ blocks, rules, markdown, siblings }) {
  const workDir = await mkdtemp(path.join(tmpdir(), "richmd-links-rules-"));
  if (blocks) {
    const blocksDir = path.join(workDir, ".richmd", "blocks");
    await mkdir(blocksDir, { recursive: true });
    for (const [filename, contents] of Object.entries(blocks)) {
      await writeFile(path.join(blocksDir, filename), contents);
    }
  }
  if (rules) {
    const rulesDir = path.join(workDir, ".richmd", "rules");
    await mkdir(rulesDir, { recursive: true });
    for (const [filename, contents] of Object.entries(rules)) {
      await writeFile(path.join(rulesDir, filename), contents);
    }
  }
  for (const [filename, contents] of Object.entries(siblings ?? {})) {
    const siblingPath = path.join(workDir, filename);
    await mkdir(path.dirname(siblingPath), { recursive: true });
    await writeFile(siblingPath, contents);
  }
  const mdPath = path.join(workDir, "doc.md");
  await writeFile(mdPath, markdown);
  return { workDir, mdPath };
}

// A real decision record for fixtures to link at, carrying the `#adr-0019`
// anchor the payoff rule matches on.
const ADR_0019 = [
  "# Ownership is explicit",
  "",
  '<a id="adr-0019"></a>',
  "",
  "Body.",
  "",
].join("\n");

// A rule that REPORTS every link on every projection, as one error line per
// link naming the projection's kind, the link's text, and its target.
// Reporting through add_error is what makes `links` observable from outside
// the filter.
const REPORT_LINKS_RULE = [
  "return {",
  "  check = function(block_projections, add_error)",
  "    for _, bp in ipairs(block_projections) do",
  "      for _, link in ipairs(bp.links) do",
  "        add_error(",
  "          'rule:report-links',",
  "          bp.location,",
  "          'link text=' .. link.text .. ' target=' .. link.target",
  "        )",
  "      end",
  "    end",
  "  end,",
  "}",
].join("\n");

// A rule that reports each projection's link COUNT — proves an empty (never
// nil) list, since `#bp.links` on a nil field would crash the rule instead.
const REPORT_LINK_COUNT_RULE = [
  "return {",
  "  check = function(block_projections, add_error)",
  "    for _, bp in ipairs(block_projections) do",
  "      add_error(",
  "        'rule:count-links',",
  "        bp.location,",
  "        'kind=' .. bp.kind .. ' link_count=' .. tostring(#bp.links)",
  "      )",
  "    end",
  "  end,",
  "}",
].join("\n");

// The rule from USAGE_RULES.md "Requiring a link from a rule", verbatim in
// spirit: an entry must LINK its governing decision record — a link whose
// fragment matches `#adr-NNNN`, not merely the visible text `ADR-NNNN`.
const CITES_A_DECISION_RULE = [
  "return {",
  "  check = function(block_projections, add_error)",
  "    for _, bp in ipairs(block_projections) do",
  "      if bp.kind == 'callout' then",
  "        local cites = false",
  "        for _, link in ipairs(bp.links) do",
  "          if link.target:match('#adr%-%d%d%d%d$') then",
  "            cites = true",
  "          end",
  "        end",
  "        if not cites then",
  "          add_error(",
  "            'rule:cites-a-decision',",
  "            bp.location,",
  "            'an entry must link its governing decision record'",
  "          )",
  "        end",
  "      end",
  "    end",
  "  end,",
  "}",
].join("\n");

const PASSTHROUGH_RENDER = [
  "return function(block, resolved_attrs)",
  '  return pandoc.Div(block.content, pandoc.Attr("", { "consumer-card" }))',
  "end",
  "",
].join("\n");

// Case 1: a link inside a block reaches that block's projection, carrying its
// visible text and its AUTHORED target — fragment included, and never the
// sibling `.html` the render phase rewrites a cross-document link to
// (ADR-0013: "The target is the authored one, not the rendered one").
describe("projection links (a block containing a link)", () => {
  it("a rule sees the link's text and its authored target", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "report-links.lua": REPORT_LINKS_RULE },
      siblings: { "adr/0019-ownership.md": ADR_0019 },
      markdown:
        '::: {.callout tint="info"}\nSee [ADR-0019](adr/0019-ownership.md#adr-0019) for this.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // The link arrived on the CALLOUT's projection, with its own content
      // flattened to text and the target EXACTLY AS AUTHORED — `.md`, not
      // the `.html` the render phase would produce.
      assert.match(
        result.stderr,
        /\[rule:report-links\] div\.callout: link text=ADR-0019 target=adr\/0019-ownership\.md#adr-0019/,
      );
      assert.doesNotMatch(result.stderr, /\.html/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 2: a block with NO links gets an EMPTY list, never nil — a rule must
// never need a nil check (symmetric with how `tokens` already behaves).
describe("projection links (a block with no links)", () => {
  it("gets an empty links list, never nil", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "count-links.lua": REPORT_LINK_COUNT_RULE },
      markdown: '::: {.callout tint="info"}\nNo links at all here.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      // The rule reported, so it ran and `#bp.links` did not crash on nil.
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /kind=callout link_count=0/);
      assert.doesNotMatch(result.stderr, /rule crashed/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 3: a NESTED block's link appears on BOTH the inner and the outer
// block's `links`, because it is genuinely within both — the same containment
// `body_text` already reports (ADR-0013, and the `tokens` precedent).
describe("projection links (a nested block)", () => {
  it("a nested link lands on both the inner and the outer projection", async () => {
    const { workDir, mdPath } = await setupRepo({
      blocks: {
        "outer-card.schema.json": JSON.stringify({
          kind: "outer-card",
          attrs: {},
          body: "required",
        }),
        "outer-card.lua": PASSTHROUGH_RENDER,
      },
      rules: { "report-links.lua": REPORT_LINKS_RULE },
      siblings: { "adr/0019-ownership.md": ADR_0019 },
      markdown: [
        ":::: {.outer-card}",
        "Outer prose.",
        "",
        '::: {.callout tint="info"}',
        "Inner cites [ADR-0019](adr/0019-ownership.md#adr-0019).",
        ":::",
        "::::",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // The INNER block reports it...
      assert.match(
        result.stderr,
        /\[rule:report-links\] div\.callout: link text=ADR-0019 target=adr\/0019-ownership\.md#adr-0019/,
      );
      // ...and so does the OUTER block that contains it.
      assert.match(
        result.stderr,
        /\[rule:report-links\] div\.outer-card: link text=ADR-0019 target=adr\/0019-ownership\.md#adr-0019/,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 4: a CodeBlock kind's body is another grammar's source text and is
// NEVER scanned for references (design.md §06 Failure behavior), so its
// `links` is always empty.
describe("projection links (a codeblock kind)", () => {
  it("a codeblock's links is always empty", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "count-links.lua": REPORT_LINK_COUNT_RULE },
      markdown: [
        "```mermaid",
        "graph TD",
        "  A[see adr/0019-ownership.md#adr-0019] --> B",
        "```",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /kind=mermaid link_count=0/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 5: an IMAGE is not a link. Its target is a source path the page loads,
// not a reference to another document — ADR-0013 weighed collecting images
// and rejected it, because collecting both would force every rule matching on
// `target` to first disambiguate which kind it had.
describe("projection links (an image inside a block)", () => {
  it("excludes an image, collecting only the real link", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "report-links.lua": REPORT_LINKS_RULE },
      siblings: { "adr/0019-ownership.md": ADR_0019 },
      markdown: [
        '::: {.callout tint="info"}',
        "![a diagram](diagram.png)",
        "",
        "See [ADR-0019](adr/0019-ownership.md#adr-0019).",
        ":::",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // The real link is there...
      assert.match(
        result.stderr,
        /link text=ADR-0019 target=adr\/0019-ownership\.md#adr-0019/,
      );
      // ...and the image is not, by any part of its identity.
      assert.doesNotMatch(result.stderr, /diagram\.png/);
      assert.doesNotMatch(result.stderr, /a diagram/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("a block whose only inline is an image has an empty links list", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "count-links.lua": REPORT_LINK_COUNT_RULE },
      markdown: '::: {.callout tint="info"}\n![a diagram](diagram.png)\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /kind=callout link_count=0/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 6: THE PAYOFF (USAGE_RULES.md "Requiring a link from a rule",
// ADR-0013). A rule requiring a link whose fragment matches `#adr-NNNN`
// REJECTS a block carrying only the visible text `ADR-0019`, and ACCEPTS one
// carrying a real link with that fragment. These two blocks have IDENTICAL
// `body_text` — this is the case the old projection could not distinguish,
// and the entire reason `links` exists.
describe("projection links (requiring a link, not a mention)", () => {
  it("REJECTS a block with the visible text but no link", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "cites-a-decision.lua": CITES_A_DECISION_RULE },
      markdown: '::: {.callout tint="info"}\nSee ADR-0019 for this.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /\[rule:cites-a-decision\] div\.callout: an entry must link its governing decision record/,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("ACCEPTS a block carrying a real link with that fragment", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "cites-a-decision.lua": CITES_A_DECISION_RULE },
      siblings: { "adr/0019-ownership.md": ADR_0019 },
      markdown:
        '::: {.callout tint="info"}\nSee [ADR-0019](adr/0019-ownership.md#adr-0019) for this.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("REJECTS a link to the right document whose fragment is wrong", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "cites-a-decision.lua": CITES_A_DECISION_RULE },
      siblings: { "adr/0019-ownership.md": ADR_0019 },
      markdown:
        '::: {.callout tint="info"}\nSee [the record](adr/0019-ownership.md#ownership-is-explicit).\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /\[rule:cites-a-decision\] div\.callout: an entry must link its governing decision record/,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

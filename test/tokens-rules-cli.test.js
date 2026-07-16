import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile, access } from "node:fs/promises";
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

// This suite exercises the PAYOFF of token vocabulary resolution (design.md
// §05 Interface, §06 Interacts-with, ADR-0011): a cross-block rule reads a
// block projection's `tokens` field — every resolved token found WITHIN that
// block, from BOTH recognition surfaces (an inline `<vocabulary>:<member>`
// code span in the block's content, and the block's own schema-opted-in
// attr) — and reads a token's properties DIRECTLY, never re-checking
// membership nor scanning `body_text` for a reference.
//
// Same convention as test/rules-cli.test.js, test/tokens-cli.test.js and
// test/tokens-attr-cli.test.js — real temp `.richmd/` dirs, real fixture
// `.md` documents, real CLI invocations, no mocking. Every assertion is on
// OBSERVABLE behavior (exit code + stderr), never on filter internals: a
// rule reports what it found on `tokens` as an error, so the field's arrival
// — properties and all — is visible through stderr.

// setupRepo — writes a temp consumer repo with a tokens directory, an
// optional `.richmd/blocks/` extension pair, a rules directory, and a
// document.
async function setupRepo({ tokens, blocks, rules, markdown }) {
  const workDir = await mkdtemp(path.join(tmpdir(), "richmd-tokens-rules-"));
  if (tokens) {
    const tokensDir = path.join(workDir, ".richmd", "tokens");
    await mkdir(tokensDir, { recursive: true });
    for (const [filename, contents] of Object.entries(tokens)) {
      await writeFile(path.join(tokensDir, filename), contents);
    }
  }
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
  const mdPath = path.join(workDir, "doc.md");
  await writeFile(mdPath, markdown);
  return { workDir, mdPath };
}

// A CONSUMER's hypothetical vocabulary — richmd ships none of its own
// (ADR-0011). Each member carries arbitrary properties richmd never
// interprets. Note `order` here is deliberately NOT in declaration order for
// some members, so a test can prove richmd never sorts by it.
const LENS_VOCABULARY = JSON.stringify({
  members: {
    modeling: { order: 0, label: "Modeling" },
    state: { order: 1, label: "State" },
    composition: { order: 2, label: "Composition" },
  },
});

// A second CONSUMER vocabulary, to prove `tokens` carries the vocabulary
// name and that two vocabularies coexist.
const STATUS_VOCABULARY = JSON.stringify({
  members: {
    draft: { badge: "WIP" },
    final: { badge: "DONE" },
  },
});

const OPTED_IN_SCHEMA = JSON.stringify({
  kind: "lens-card",
  attrs: {
    lens: { required: true, tokens: "lens" },
  },
  body: "required",
});

const PASSTHROUGH_RENDER = [
  "return function(block, resolved_attrs)",
  '  return pandoc.Div(block.content, pandoc.Attr("", { "consumer-card" }))',
  "end",
  "",
].join("\n");

// A rule that REPORTS every token it finds on every projection, as one error
// line per token naming the projection's kind, the token's vocabulary,
// member, a PROPERTY VALUE, and the token's location. Reporting through
// add_error is what makes `tokens` observable from outside the filter.
const REPORT_TOKENS_RULE = [
  "return {",
  "  check = function(block_projections, add_error)",
  "    for _, bp in ipairs(block_projections) do",
  "      for _, tok in ipairs(bp.tokens) do",
  "        add_error(",
  "          'rule:report-tokens',",
  "          bp.location,",
  "          'token ' .. tok.vocabulary .. '/' .. tok.member",
  "            .. ' label=' .. tostring(tok.properties.label)",
  "            .. ' order=' .. tostring(tok.properties.order)",
  "            .. ' at=' .. tostring(tok.location)",
  "        )",
  "      end",
  "    end",
  "  end,",
  "}",
].join("\n");

// A rule that reports each projection's token COUNT — proves multiplicity by
// repetition, and proves an empty (never nil) list.
const REPORT_TOKEN_COUNT_RULE = [
  "return {",
  "  check = function(block_projections, add_error)",
  "    for _, bp in ipairs(block_projections) do",
  "      add_error(",
  "        'rule:count-tokens',",
  "        bp.location,",
  "        'kind=' .. bp.kind .. ' token_count=' .. tostring(#bp.tokens)",
  "      )",
  "    end",
  "  end,",
  "}",
].join("\n");

// A rule that reports each projection's tokens as an ORDERED, joined list —
// proves document order is preserved and nothing is sorted or grouped.
const REPORT_TOKEN_ORDER_RULE = [
  "return {",
  "  check = function(block_projections, add_error)",
  "    for _, bp in ipairs(block_projections) do",
  "      local names = {}",
  "      for _, tok in ipairs(bp.tokens) do",
  "        table.insert(names, tok.member)",
  "      end",
  "      add_error('rule:order-tokens', bp.location, 'order=' .. table.concat(names, ','))",
  "    end",
  "  end,",
  "}",
].join("\n");

// Case 1: a token resolved from an INLINE CODE SPAN inside a block reaches
// that block's projection, with its PROPERTIES intact — the whole point of
// the feature (design.md §05 Interface: "a rule reads a token's properties
// directly").
describe("projection tokens (an inline code span inside a block)", () => {
  it("a rule sees the token with its properties intact", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "report-tokens.lua": REPORT_TOKENS_RULE },
      markdown:
        '::: {.callout tint="info"}\nThis card is about `lens:modeling` work.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // The token arrived on the CALLOUT's projection...
      assert.match(result.stderr, /\[rule:report-tokens\] div\.callout:/);
      // ...naming its vocabulary and member...
      assert.match(result.stderr, /token lens\/modeling/);
      // ...and carrying the CONSUMER's arbitrary properties through.
      assert.match(result.stderr, /label=Modeling/);
      assert.match(result.stderr, /order=0/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 2: a token resolved from the block's OWN OPTED-IN ATTR lands in the
// SAME `tokens` list — both recognition surfaces converge on one field
// (design.md §06 Interface: "Two recognition surfaces").
describe("projection tokens (the block's own opted-in attr)", () => {
  it("a rule sees the attr's token in the same tokens list", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      rules: { "report-tokens.lua": REPORT_TOKENS_RULE },
      markdown: '::: {.lens-card lens="state"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /\[rule:report-tokens\] div\.lens-card:/);
      assert.match(result.stderr, /token lens\/state/);
      assert.match(result.stderr, /label=State/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("both surfaces reach the same block's tokens list together", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      rules: { "count-tokens.lua": REPORT_TOKEN_COUNT_RULE },
      markdown:
        '::: {.lens-card lens="state"}\nAlso mentions `lens:modeling` inline.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // One from the attr, one from the span.
      assert.match(result.stderr, /kind=lens-card token_count=2/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 3: MULTIPLICITY BY REPETITION — a reference is singular, so two
// members cited means two spans, which appear as TWO entries (ADR-0011:
// there is no combinator, by decision).
describe("projection tokens (multiplicity is repetition)", () => {
  it("a block with two references has two entries", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "count-tokens.lua": REPORT_TOKEN_COUNT_RULE },
      markdown:
        '::: {.callout tint="info"}\nBoth `lens:modeling` and `lens:state` apply.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /kind=callout token_count=2/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("the SAME member cited twice is two entries, never deduped", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "count-tokens.lua": REPORT_TOKEN_COUNT_RULE },
      markdown:
        '::: {.callout tint="info"}\nSays `lens:state` and again `lens:state`.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /kind=callout token_count=2/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 4: a block with NO references gets an EMPTY list, never nil — a rule
// must never need a nil check.
describe("projection tokens (a block with no references)", () => {
  it("gets an empty tokens list, never nil", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "count-tokens.lua": REPORT_TOKEN_COUNT_RULE },
      markdown: '::: {.callout tint="info"}\nNo references at all here.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      // The rule reported (so it ran and `#bp.tokens` did not crash on nil).
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /kind=callout token_count=0/);
      assert.doesNotMatch(result.stderr, /rule crashed/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("is an empty list even when NO vocabulary is declared at all", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "count-tokens.lua": REPORT_TOKEN_COUNT_RULE },
      markdown: '::: {.callout tint="info"}\nPlain prose.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /kind=callout token_count=0/);
      assert.doesNotMatch(result.stderr, /rule crashed/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 5: tokens arrive in DOCUMENT ORDER — richmd never sorts, groups, or
// dedupes by any property (ADR-0011: richmd validates membership and never
// interprets a property's meaning). `composition` (order=2) cited BEFORE
// `modeling` (order=0) must stay in that order.
describe("projection tokens (document order, never sorted by a property)", () => {
  it("carries tokens in document order, not property order", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "order-tokens.lua": REPORT_TOKEN_ORDER_RULE },
      markdown:
        '::: {.callout tint="info"}\nFirst `lens:composition`, then `lens:modeling`.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // Document order — NOT sorted by the `order` property (which would
      // have produced `modeling,composition`).
      assert.match(result.stderr, /order=composition,modeling/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 6: a reference OUTSIDE any recognized block still VALIDATES (chunk
// A's behavior, preserved) but belongs to no projection — it appears in no
// projection's `tokens` list.
describe("projection tokens (a reference outside any recognized block)", () => {
  it("an unknown member in a plain paragraph still fails closed", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "count-tokens.lua": REPORT_TOKEN_COUNT_RULE },
      markdown: "A plain paragraph citing `lens:bogus`.\n",
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // Chunk A's validation behavior is untouched.
      assert.match(result.stderr, /\[token:lens\]/);
      assert.match(result.stderr, /unknown member 'bogus'/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("a valid reference outside any block appears in no projection's tokens", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "count-tokens.lua": REPORT_TOKEN_COUNT_RULE },
      markdown:
        "# Heading `lens:modeling`\n\nA paragraph citing `lens:state`.\n\n" +
        '::: {.callout tint="info"}\nNo references here.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // The callout is the only projection, and it has no tokens — the
      // heading's and paragraph's references belong to no block.
      assert.match(result.stderr, /kind=callout token_count=0/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 7: two vocabularies coexist; a token names the vocabulary it came
// from.
describe("projection tokens (two vocabularies coexist)", () => {
  it("each token names its own vocabulary", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": LENS_VOCABULARY,
        "status.json": STATUS_VOCABULARY,
      },
      rules: { "order-tokens.lua": REPORT_TOKEN_ORDER_RULE },
      markdown:
        '::: {.callout tint="info"}\nA `lens:state` that is `status:draft`.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /order=state,draft/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 8: a reference inside a FENCED CODE BLOCK is never scanned, so it
// never reaches a projection's tokens (design.md §06 Failure behavior — that
// text is another grammar's source).
describe("projection tokens (a fenced code block is never scanned)", () => {
  it("a reference in fenced code reaches no projection's tokens", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "count-tokens.lua": REPORT_TOKEN_COUNT_RULE },
      markdown:
        '::: {.callout tint="info"}\n```js\nconst x = "lens:modeling";\n```\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /kind=callout token_count=0/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 9: building the projection list re-derives each block's opted-in attr
// tokens, which means re-running the schema's attr check. That must never
// make a bad attr report TWICE — the validate walk already reported it. An
// error's output must be identical whether or not any rule is loaded.
describe("projection tokens (re-deriving attr tokens never doubles an error)", () => {
  const NOOP_RULE = "return { check = function(bps, add_error) end }";

  async function badAttrRun({ rules }) {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      rules,
      markdown: '::: {.lens-card lens="bogus"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      const occurrences = (result.stderr.match(/unknown member 'bogus'/g) ?? [])
        .length;
      return { result, occurrences };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  it("reports a bad attr exactly once when a rule IS loaded", async () => {
    const { result, occurrences } = await badAttrRun({
      rules: { "noop.lua": NOOP_RULE },
    });
    assert.notEqual(result.code, 0);
    assert.equal(occurrences, 1, `stderr was: ${result.stderr}`);
  });

  it("reports a bad attr exactly once when NO rule is loaded", async () => {
    const { result, occurrences } = await badAttrRun({});
    assert.notEqual(result.code, 0);
    assert.equal(occurrences, 1, `stderr was: ${result.stderr}`);
  });
});

// Case 10: the ADDITIVE-ONLY guarantee — `tokens` arriving never disturbs the
// fields ADR-0008's contract already promised. A rule written against the
// old contract keeps working unchanged.
describe("projection tokens (additive only)", () => {
  it("kind, attrs, location and body_text are unchanged alongside tokens", async () => {
    const RULE = [
      "return {",
      "  check = function(block_projections, add_error)",
      "    for _, bp in ipairs(block_projections) do",
      "      add_error(",
      "        'rule:shape',",
      "        bp.location,",
      "        'kind=' .. bp.kind",
      "          .. ' tint=' .. tostring(bp.attrs.tint)",
      "          .. ' body=' .. bp.body_text",
      "          .. ' tokens=' .. tostring(#bp.tokens)",
      "      )",
      "    end",
      "  end,",
      "}",
    ].join("\n");
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      rules: { "shape.lua": RULE },
      markdown: '::: {.callout tint="info"}\nHello `lens:state` world.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /\[rule:shape\] div\.callout: kind=callout tint=info body=Hello lens:state world\. tokens=1/,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

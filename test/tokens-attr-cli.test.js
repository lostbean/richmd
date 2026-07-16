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

// This suite exercises the SECOND token recognition surface (design.md §06
// Interface, ADR-0011): a block attr is a token reference ONLY when its
// block kind schema carries `tokens=<vocabulary>`, and then holds exactly
// one member. Same convention as test/tokens-cli.test.js and
// test/extension-cli.test.js — real temp `.richmd/` dirs, real fixture `.md`
// documents, real CLI invocations, no mocking.

// setupRepo — writes a temp consumer repo with an optional tokens directory,
// an optional `.richmd/blocks/` extension pair, and a document.
async function setupRepo({ tokens, blocks, markdown }) {
  const workDir = await mkdtemp(path.join(tmpdir(), "richmd-tokens-attr-"));
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
  const mdPath = path.join(workDir, "doc.md");
  await writeFile(mdPath, markdown);
  return { workDir, mdPath };
}

const LENS_VOCABULARY = JSON.stringify({
  members: {
    modeling: { order: 0, label: "Modeling" },
    state: { order: 1, label: "State" },
    composition: { order: 2, label: "Composition" },
  },
});

// A consumer block kind whose `lens` attr is OPTED IN to the lens
// vocabulary via its schema's `tokens` field — the only thing that makes an
// attr a reference (ADR-0011).
const OPTED_IN_SCHEMA = JSON.stringify({
  kind: "lens-card",
  attrs: {
    lens: { required: true, tokens: "lens" },
  },
  body: "required",
});

// A consumer block kind with an attr literally NAMED `lens` that its schema
// does NOT opt in — an ordinary string attr (ADR-0011: never inferred from
// the name).
const NOT_OPTED_IN_SCHEMA = JSON.stringify({
  kind: "plain-card",
  attrs: {
    lens: { required: true, type: "string" },
  },
  body: "required",
});

const PASSTHROUGH_RENDER = [
  "return function(block, resolved_attrs)",
  '  return pandoc.Div(block.content, pandoc.Attr("", { "consumer-card" }))',
  "end",
  "",
].join("\n");

// Case 1: an attr opted into a vocabulary, holding a DECLARED member,
// validates clean (design.md §04 Interface: "its value is then a token
// reference carrying exactly one member, validated against the set").
describe("token attr (a declared member validates clean)", () => {
  it('lens="modeling" against an opted-in schema — exits 0, HTML written', async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="modeling"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 2: an attr opted into a vocabulary, holding an UNDECLARED member, is
// a validation error naming BOTH the vocabulary and the member (design.md
// §06 Failure behavior). Fails closed.
describe("token attr (an undeclared member fails closed)", () => {
  it('lens="bogus" — exits non-zero, stderr names both lens and bogus, no HTML', async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="bogus"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens/);
      assert.match(result.stderr, /bogus/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  // The error is about THIS block's attr, so it reads like every other attr
  // error: the block's own kind is the error source
  // (CONTEXT.md#term-error-source).
  it("the error is sourced to the block's own kind, like every other attr error", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="bogus"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /^richmd: \[lens-card\] div\.lens-card: /m);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 3: THE ADR-0011 pin. An attr is a reference ONLY when its schema says
// so — richmd never infers one from an attr's NAME. An attr literally named
// `lens`, on a block whose schema does NOT opt it in, is an ordinary string
// attr: untouched, even when its value is not a member of the same-named
// declared vocabulary. Inferring from the name "would make an unrelated
// `lens=` attr silently token-validated, and would bind vocabulary names to
// attr names across every consumer schema forever" (ADR-0011).
describe("token attr (never inferred from the attr's name)", () => {
  it('an attr NAMED lens whose schema does not opt it in: lens="bogus" — exits 0', async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "plain-card.schema.json": NOT_OPTED_IN_SCHEMA,
        "plain-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.plain-card lens="bogus"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("an ordinary string attr named lens holding free prose — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "plain-card.schema.json": NOT_OPTED_IN_SCHEMA,
        "plain-card.lua": PASSTHROUGH_RENDER,
      },
      markdown:
        '::: {.plain-card lens="a wide angle lens, 24mm"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 4: a schema opting an attr into a vocabulary that does not exist is a
// broken schema — it must fail LOUDLY naming the block, the attr, and the
// missing vocabulary, never silently pass the attr through as an ordinary
// string (§00: a token reference resolves to a declared member, never to
// prose).
describe("token attr (an opted-in attr with no such vocabulary fails loudly)", () => {
  it("no .richmd/tokens/lens.json at all — exits non-zero, names block, attr, vocabulary", async () => {
    const { workDir, mdPath } = await setupRepo({
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="modeling"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens-card/);
      assert.match(result.stderr, /lens/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("other vocabularies declared but not this one — still fails loudly", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "status.json": JSON.stringify({ members: { draft: {} } }),
      },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="modeling"}\nBody text.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /^richmd: \[lens-card\] div\.lens-card: /m);
      assert.match(result.stderr, /lens/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 4b: `tokens` and the enum/`allowed`-values mechanism are MUTUALLY
// EXCLUSIVE on the same attr — an attr drawing its value from a closed
// vocabulary AND from an inline `allowed` list is a contradiction about
// where the value's truth lives (design.md §04: validated against the set
// "instead of an inline `allowed` list"). A self-contradictory schema is a
// load-time FATAL naming the offending file — the same convention
// extension-loader.lua already holds for a schema whose `kind` disagrees
// with its filename, and tokens-loader.lua for a malformed vocabulary.
// Silently letting one mechanism win would make which one it is a fact a
// consumer could only learn by experiment.
describe("token attr (tokens and enum are mutually exclusive)", () => {
  it("an attr declaring both — fatal at startup, names the file and the attr", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": JSON.stringify({
          kind: "lens-card",
          attrs: {
            lens: {
              required: true,
              tokens: "lens",
              type: "enum",
              enum_values: ["modeling", "state"],
            },
          },
          body: "required",
        }),
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      // Even a document that never uses the kind is refused: the broken
      // schema is fatal at filter startup, before any AST walk.
      markdown: "# Plain doc\n\nNothing fancy.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens-card\.schema\.json/);
      assert.match(result.stderr, /lens/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 5: THE "exactly one member" pin. An opted-in attr holds EXACTLY ONE
// member and richmd never splits it — on a space or any other delimiter.
// `lens="state composition"` is ONE key lookup of the member
// `state composition`, which fails closed even though `state` and
// `composition` are each declared members (ADR-0011: there is no combinator,
// by decision; multiplicity is not this attr's to express).
describe("token attr (exactly one member — never split into parts)", () => {
  it('lens="state composition" fails closed as one whole member key, though both parts are declared', async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="state composition"}\nBody.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // The WHOLE string is the member key — not split into `state` and
      // `composition`, both of which ARE declared members.
      assert.match(result.stderr, /state composition/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('lens="state composition" resolves when that exact key IS declared', async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": JSON.stringify({
          members: { "state composition": { order: 0 } },
        }),
      },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="state composition"}\nBody.\n:::\n',
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('lens="state,composition" is likewise one whole member key — fails closed', async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="state,composition"}\nBody.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /state,composition/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  // The attr carries the BARE member key, never the code span's
  // `<vocabulary>:<member>` shape — the vocabulary is already named by the
  // schema, so a value repeating it is just an undeclared member key.
  it('lens="lens:modeling" is one member key `lens:modeling` — fails closed', async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="lens:modeling"}\nBody.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens:modeling/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 6: an OPTIONAL opted-in attr is only token-validated when present —
// `tokens` opts an attr into a vocabulary, it does not make it required.
describe("token attr (an optional opted-in attr)", () => {
  const OPTIONAL_SCHEMA = JSON.stringify({
    kind: "lens-card",
    attrs: { lens: { required: false, tokens: "lens" } },
    body: "required",
  });

  it("omitted entirely — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTIONAL_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: "::: {.lens-card}\nBody with no lens attr.\n:::\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("present with an undeclared member — still fails closed", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTIONAL_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.lens-card lens="bogus"}\nBody.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /bogus/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 7: an attr token error is collected alongside every other error —
// never fail-fast on the first (§00 all-errors-collected). Both recognition
// surfaces contribute to the same error set in one run.
describe("token attr (errors are collected, never fail-fast)", () => {
  it("two blocks with undeclared members produce TWO collected errors", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: [
        '::: {.lens-card lens="bogus-one"}',
        "First.",
        ":::",
        "",
        '::: {.lens-card lens="modeling"}',
        "Fine.",
        ":::",
        "",
        '::: {.lens-card lens="bogus-two"}',
        "Second.",
        ":::",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /bogus-one/);
      assert.match(result.stderr, /bogus-two/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("an attr token error and an inline span token error are collected together", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: [
        '::: {.lens-card lens="attr-bogus"}',
        "Body.",
        ":::",
        "",
        "Prose citing `lens:span-bogus`.",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // The attr's error is sourced to the block's own kind; the span's to
      // `token:<vocabulary>` — the two surfaces, reported as what each is
      // about (CONTEXT.md#term-error-source).
      assert.match(result.stderr, /^richmd: \[lens-card\] div\.lens-card: /m);
      assert.match(result.stderr, /^richmd: \[token:lens\] /m);
      assert.match(result.stderr, /attr-bogus/);
      assert.match(result.stderr, /span-bogus/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("an attr token error and a plain schema error are collected together", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      blocks: {
        "lens-card.schema.json": OPTED_IN_SCHEMA,
        "lens-card.lua": PASSTHROUGH_RENDER,
      },
      // Undeclared member AND an empty body (schema says body required).
      markdown: '::: {.lens-card lens="bogus"}\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /bogus/);
      assert.match(
        result.stderr,
        /^richmd: \[lens-card\] div\.lens-card: body is required but was empty$/m,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 8: a schema may opt several attrs in, each into its own vocabulary —
// every opted-in attr is one independent, exact member lookup.
describe("token attr (two attrs opted into two vocabularies)", () => {
  it("two attrs opted into two different vocabularies each resolve independently", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": LENS_VOCABULARY,
        "status.json": JSON.stringify({
          members: { draft: {}, shipped: {} },
        }),
      },
      blocks: {
        "two-card.schema.json": JSON.stringify({
          kind: "two-card",
          attrs: {
            lens: { required: true, tokens: "lens" },
            status: { required: true, tokens: "status" },
          },
          body: "required",
        }),
        "two-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.two-card lens="modeling" status="draft"}\nBody.\n:::\n',
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("one good attr and one bad — only the bad one is reported", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": LENS_VOCABULARY,
        "status.json": JSON.stringify({
          members: { draft: {}, shipped: {} },
        }),
      },
      blocks: {
        "two-card.schema.json": JSON.stringify({
          kind: "two-card",
          attrs: {
            lens: { required: true, tokens: "lens" },
            status: { required: true, tokens: "status" },
          },
          body: "required",
        }),
        "two-card.lua": PASSTHROUGH_RENDER,
      },
      markdown: '::: {.two-card lens="modeling" status="bogus"}\nBody.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /bogus/);
      assert.match(result.stderr, /status/);
      // The lens attr resolved cleanly — its member is never reported.
      assert.doesNotMatch(result.stderr, /modeling/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

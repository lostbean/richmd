import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  access,
  readFile,
} from "node:fs/promises";
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

// This suite exercises the full wiring of filter/tokens-loader.lua into
// filter/richmd-filter.lua's validate phase (design.md §06 Token vocabulary
// resolution, ADR-0011), through real CLI invocations against real temp
// `.richmd/tokens/*.json` files and real fixture `.md` documents — same
// convention as test/rules-cli.test.js and test/extension-cli.test.js: no
// mocking, `execFile` against bin/richmd.js.

async function setupRepo({ tokens, markdown }) {
  const workDir = await mkdtemp(path.join(tmpdir(), "richmd-tokens-cli-"));
  if (tokens) {
    const tokensDir = path.join(workDir, ".richmd", "tokens");
    await mkdir(tokensDir, { recursive: true });
    for (const [filename, contents] of Object.entries(tokens)) {
      await writeFile(path.join(tokensDir, filename), contents);
    }
  }
  const mdPath = path.join(workDir, "doc.md");
  await writeFile(mdPath, markdown);
  return { workDir, mdPath };
}

// A vocabulary declares EXACTLY ONE field — `members`, a map of member key
// to that member's arbitrary consumer-owned properties (ADR-0011: no `name`
// field, the filename is the key; no `references` field, placement is a
// cross-block rule's job).
const LENS_VOCABULARY = JSON.stringify({
  members: {
    modeling: { order: 0, label: "Modeling" },
    state: { order: 1, label: "State" },
    composition: { order: 2, label: "Composition" },
  },
});

// Case 1: a reference to a declared member of a declared vocabulary
// resolves — no error.
describe("token vocabulary (a declared member resolves)", () => {
  it("`lens:modeling` against a lens vocabulary containing modeling — exits 0, HTML written", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\nThis section is about `lens:modeling` work.\n",
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

// Case 2: a reference naming a declared vocabulary but an undeclared member
// is a validation error naming BOTH the vocabulary and the member
// (design.md §06 Failure behavior). Fails closed.
describe("token vocabulary (an undeclared member fails closed)", () => {
  it("`lens:bogus` — exits non-zero, stderr names both lens and bogus, no HTML", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\nThis cites `lens:bogus` which is not declared.\n",
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
});

// Case 3: a code span whose prefix matches NO declared vocabulary is
// ordinary prose, not an error — richmd recognizes references only for
// vocabularies a consumer actually declared (design.md §06 Failure
// behavior).
describe("token vocabulary (an undeclared vocabulary's prefix is ordinary prose)", () => {
  it("`foo:bar` with no foo vocabulary declared — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\nRun `foo:bar` in your shell. Also `git:commit`.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("`lens:bogus` when NO vocabulary is declared at all — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      markdown:
        "# Doc\n\nA bare `lens:bogus` span, no vocabularies declared.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("a code span with no colon at all — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\nJust `modeling` on its own, and `lens` alone.\n",
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

// Case 4: a reference inside a fenced code block is NEVER recognized — that
// text is another grammar's source, not richmd's (design.md §06, ADR-0011).
// A `Code` INLINE span and a `CodeBlock` are different Pandoc node types;
// this distinction is the whole rule.
describe("token vocabulary (a fenced code block is never scanned)", () => {
  it("`lens:bogus` inside a fenced code block — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: [
        "# Doc",
        "",
        "```",
        "lens:bogus",
        "lens:also-not-declared",
        "```",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("a mermaid block containing lens:bogus still validates — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: [
        "# Doc",
        "",
        "```mermaid",
        "graph TD",
        "  A[lens:bogus] --> B[lens:modeling]",
        "```",
        "",
      ].join("\n"),
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

// Case 5: recognition happens WHEREVER a Code inline appears — a heading's
// code span is an ordinary code span (ADR-0011: recognized structurally).
describe("token vocabulary (a Code span in a heading resolves exactly like one in a paragraph)", () => {
  it("a declared member in a heading — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Heading with `lens:modeling`\n\nBody text.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("an undeclared member in a heading fails closed, naming both", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Heading with `lens:bogus`\n\nBody text.\n",
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens/);
      assert.match(result.stderr, /bogus/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("an undeclared member inside a recognized block's body fails closed", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown:
        '::: {.callout tint="info"}\nCites `lens:bogus` inside a block.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens/);
      assert.match(result.stderr, /bogus/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 6: richmd's own fixed syntax splits on the FIRST colon only, so a
// member key may itself contain colons (ADR-0011: the one parse richmd owns,
// deliberately not a knob).
describe("token vocabulary (first-colon split: a member key may contain colons)", () => {
  it("a declared member `a:b` resolves via `lens:a:b` — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": JSON.stringify({ members: { "a:b": { order: 0 } } }),
      },
      markdown: "# Doc\n\nCites `lens:a:b` which is a declared member.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("`lens:a:b` when only `a` is declared fails closed, naming the full member key `a:b`", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": JSON.stringify({ members: { a: { order: 0 } } }),
      },
      markdown: "# Doc\n\nCites `lens:a:b`.\n",
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /a:b/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 7: a reference is SINGULAR — richmd never splits it on any further
// delimiter (ADR-0011 rejected the combinator outright). `lens:state+composition`
// is ONE key lookup of the member `state+composition`.
describe("token vocabulary (a reference is singular — never split into parts)", () => {
  it("`lens:state+composition` fails closed as one whole member key when undeclared", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\nCites `lens:state+composition`.\n",
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // The whole string is the member key — NOT split into `state` and
      // `composition`, both of which ARE declared members.
      assert.match(result.stderr, /state\+composition/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("`lens:state+composition` resolves when that exact key IS declared", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": JSON.stringify({
          members: { "state+composition": { order: 0 } },
        }),
      },
      markdown: "# Doc\n\nCites `lens:state+composition`.\n",
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

// Case 8: multiple references each resolve independently, and every unknown
// member is collected — never fail-fast on the first (§00 invariant "all
// errors collected").
describe("token vocabulary (multiple references resolve independently; all errors collected)", () => {
  it("two unknown members produce TWO collected errors in one run", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: [
        "# Doc",
        "",
        "First cites `lens:bogus-one` and this is fine: `lens:modeling`.",
        "",
        "Second cites `lens:bogus-two`.",
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

  it("two vocabularies each resolve their own references independently", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": LENS_VOCABULARY,
        "status.json": JSON.stringify({
          members: { draft: {}, shipped: {} },
        }),
      },
      markdown: [
        "# Doc",
        "",
        "Good: `lens:modeling` and `status:draft`.",
        "",
        "Bad: `status:bogus`.",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /status/);
      assert.match(result.stderr, /bogus/);
      // The lens reference resolved cleanly — its own member is never
      // reported.
      assert.doesNotMatch(result.stderr, /modeling/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("a token error and a per-block schema error are collected together in one run", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: [
        // Empty body -> per-block schema error (callout's body is required).
        "::: {.callout}",
        ":::",
        "",
        "Cites `lens:bogus`.",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /^richmd: \[callout\] div\.callout: body is required but was empty$/m,
      );
      assert.match(result.stderr, /bogus/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 9: the token error source is `token:`-prefixed so it can never
// collide with a same-named block kind's bare error source — the same
// convention `rule:` already holds (CONTEXT.md#term-error-source).
describe("token vocabulary (error source prefix never collides with a same-named block kind)", () => {
  it("a vocabulary named callout reports [token:callout], distinct from a real [callout] error", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "callout.json": JSON.stringify({ members: { known: {} } }),
      },
      // Trips the built-in callout schema (body required but empty) so BOTH
      // a genuine [callout] error and a [token:callout] error appear.
      markdown: "::: {.callout}\n:::\n\nCites `callout:bogus`.\n",
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /^richmd: \[token:callout\] /m);
      assert.match(result.stderr, /^richmd: \[callout\] div\.callout:/m);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 10: a malformed vocabulary file is FATAL at filter startup, naming
// the offending file — never a silently skipped vocabulary (design.md §06
// Failure behavior).
describe("token vocabulary (a malformed vocabulary file is a fatal startup error)", () => {
  it("invalid JSON: exits non-zero, names the file, no HTML", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "broken.json": "{ this is not ) valid json (((" },
      markdown: "# Plain doc\n\nNothing fancy.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /broken\.json/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("missing 'members' field: exits non-zero, names the file and the missing field", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": JSON.stringify({ notmembers: {} }) },
      markdown: "# Plain doc\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens\.json/);
      assert.match(result.stderr, /members/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("non-object 'members' field (a string): exits non-zero, names the file", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": JSON.stringify({ members: "nope" }) },
      markdown: "# Plain doc\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens\.json/);
      assert.match(result.stderr, /members/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("non-object 'members' field (a non-empty array): exits non-zero, names the file", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": JSON.stringify({ members: ["modeling"] }) },
      markdown: "# Plain doc\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /lens\.json/);
      assert.match(result.stderr, /members/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("one malformed file among valid ones is still fatal — never silently skipped", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": LENS_VOCABULARY,
        "broken.json": "{{{",
      },
      markdown: "# Plain doc\n\nCites `lens:modeling`.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /broken\.json/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 11: the tokens directory is OPTIONAL — absent means zero
// vocabularies, no error, and documents validate exactly as before
// (CONTEXT.md#term-tokens-directory). The whole feature is inert.
describe("token vocabulary (an absent tokens directory is not an error)", () => {
  it("no .richmd/tokens/ at all: a normal document still validates and renders", async () => {
    const { workDir, mdPath } = await setupRepo({
      markdown: '::: {.callout tint="info"}\nHello.\n:::\n',
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("an empty .richmd/tokens/ directory: still renders", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {},
      markdown:
        "# Hello\n\nPlain doc with a `lens:bogus` span and no vocabularies.\n",
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

// Case 13: a recognized token reference is ADDRESSING, not prose (ADR-0012):
// it contributes nothing to its heading's slug, so tagging a heading keeps
// the anchor it had before it was tagged. The exclusion is exactly
// coextensive with what richmd RECOGNIZES — an ordinary code span, and a span
// naming an undeclared vocabulary, are both prose and slug normally.
describe("token vocabulary (a recognized reference never enters a heading's slug)", () => {
  it("`## Invariants `lens:invariants`` — heading id is `invariants`, not `invariants-lensinvariants`", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": JSON.stringify({
          members: { invariants: {}, robustness: {} },
        }),
      },
      markdown: "# Doc\n\n## Invariants `lens:invariants`\n\nBody.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const html = await readFile(path.join(workDir, "doc.html"), "utf8");
      assert.match(html, /id="invariants"/);
      assert.doesNotMatch(html, /id="invariants-lensinvariants"/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("two references in one heading — both excluded from the slug, both rendered as hooks", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": JSON.stringify({
          members: { invariants: {}, robustness: {} },
        }),
      },
      markdown:
        "# Doc\n\n## Invariants `lens:invariants` `lens:robustness`\n\nBody.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const html = await readFile(path.join(workDir, "doc.html"), "utf8");
      assert.match(html, /id="invariants"/);
      assert.doesNotMatch(html, /lensinvariants|lensrobustness/);
      assert.match(html, /data-member="invariants"/);
      assert.match(html, /data-member="robustness"/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  // The regression guard ADR-0012 names explicitly: excluding EVERY Code
  // inline would silently rewrite this anchor to `uses-in-prose`.
  it("`## Uses `code` in prose` — an ordinary code span is prose, id stays `uses-code-in-prose`", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\n## Uses `code` in prose\n\nBody.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const html = await readFile(path.join(workDir, "doc.html"), "utf8");
      assert.match(html, /id="uses-code-in-prose"/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("`## Cites `foo:bar`` with no foo vocabulary — undeclared prefix is prose, slugs as before", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\n## Cites `foo:bar`\n\nBody.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const html = await readFile(path.join(workDir, "doc.html"), "utf8");
      assert.match(html, /id="cites-foobar"/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 14: the render-phase heading id and the validate-phase `#fragment`
// resolution must agree EXACTLY (§00 invariant: fragment resolution "checks
// the identical id a target heading actually receives"). The validate phase
// re-parses target documents independently, so token-awareness has to reach
// that caller too — this is the bug ADR-0012 fixes: a link to a tagged
// heading's real anchor used to fail.
describe("token vocabulary (validate and render agree on a tagged heading's anchor)", () => {
  it("a cross-document #invariants link to a heading tagged `lens:invariants` validates clean", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "richmd-tokens-anchor-"));
    try {
      const tokensDir = path.join(workDir, ".richmd", "tokens");
      await mkdir(tokensDir, { recursive: true });
      await writeFile(
        path.join(tokensDir, "lens.json"),
        JSON.stringify({ members: { invariants: {} } }),
      );
      await writeFile(
        path.join(workDir, "target.md"),
        "# Target\n\n## Invariants `lens:invariants`\n\nBody.\n",
      );
      const mainPath = path.join(workDir, "main.md");
      await writeFile(
        mainPath,
        "# Main\n\nSee [the invariants](target.md#invariants).\n",
      );

      const result = await runCli(["validate", mainPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("a #fragment naming the OLD polluted anchor no longer resolves", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "richmd-tokens-anchor-"));
    try {
      const tokensDir = path.join(workDir, ".richmd", "tokens");
      await mkdir(tokensDir, { recursive: true });
      await writeFile(
        path.join(tokensDir, "lens.json"),
        JSON.stringify({ members: { invariants: {} } }),
      );
      await writeFile(
        path.join(workDir, "target.md"),
        "# Target\n\n## Invariants `lens:invariants`\n\nBody.\n",
      );
      const mainPath = path.join(workDir, "main.md");
      await writeFile(
        mainPath,
        "# Main\n\nSee [stale](target.md#invariants-lensinvariants).\n",
      );

      const result = await runCli(["validate", mainPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /invariants-lensinvariants/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 15: a recognized reference renders as a token HOOK
// (CONTEXT.md#term-token-hook, ADR-0012): the vocabulary prefix leaves the
// visible text because it is addressing; the member stays. The hook carries
// the vocabulary and member ONLY — never a member's properties, which are the
// consumer's and which richmd never interprets (ADR-0011/ADR-0012).
describe("token vocabulary (a recognized reference renders as a token hook)", () => {
  it('`lens:state` becomes <code class="richmd-token" data-vocabulary data-member>state</code>', async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\nThis is `lens:state` work.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      // Pandoc's HTML writer soft-wraps long lines, so the attributes of a
      // single tag can land on separate lines. Collapse whitespace before
      // asserting on the tag's exact shape — the markup is the contract, its
      // line breaks are not.
      const html = (
        await readFile(path.join(workDir, "doc.html"), "utf8")
      ).replace(/\s+/g, " ");
      assert.match(
        html,
        /<code class="richmd-token" data-vocabulary="lens" data-member="state">state<\/code>/,
      );
      // The vocabulary prefix is addressing — it never reaches the reader.
      assert.doesNotMatch(html, />lens:state</);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("never emits a member's properties into the page (ADR-0012: the hook carries no properties)", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": JSON.stringify({
          members: {
            state: { label: "State Lens", color: "#ff0000", order: 7 },
          },
        }),
      },
      markdown: "# Doc\n\nThis is `lens:state` work.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const html = await readFile(path.join(workDir, "doc.html"), "utf8");
      assert.match(html, /data-member="state"/);
      assert.doesNotMatch(html, /State Lens|#ff0000|data-label|data-color/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("an ordinary code span renders as a plain <code> — no hook, no data attributes", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\nRun `npm test` and also `foo:bar` sometime.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const html = await readFile(path.join(workDir, "doc.html"), "utf8");
      assert.match(html, /<code>npm test<\/code>/);
      assert.match(html, /<code>foo:bar<\/code>/);
      assert.doesNotMatch(html, /richmd-token/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("a reference inside a fenced code block is never recognized — no hook", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: { "lens.json": LENS_VOCABULARY },
      markdown: "# Doc\n\n```\nlens:state\nlens:bogus\n```\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const html = await readFile(path.join(workDir, "doc.html"), "utf8");
      assert.doesNotMatch(html, /richmd-token/);
      assert.match(html, /lens:state/);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 12: richmd validates MEMBERSHIP and never reads a property's meaning
// — properties are opaque payload, of any JSON shape (ADR-0011).
describe("token vocabulary (properties are opaque payload richmd never interprets)", () => {
  it("members with arbitrary nested/empty properties all resolve — exits 0", async () => {
    const { workDir, mdPath } = await setupRepo({
      tokens: {
        "lens.json": JSON.stringify({
          members: {
            empty: {},
            nested: { deep: { list: [1, 2, 3], flag: true }, n: null },
            scalars: { order: 0, label: "Scalars" },
          },
        }),
      },
      markdown: "# Doc\n\n`lens:empty` `lens:nested` `lens:scalars`\n",
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

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");
const filterDir = path.join(repoRoot, "filter");

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

// This suite exercises the full wiring of filter/rules-loader.lua into
// filter/richmd-filter.lua (design.md §05, ADR-0008), through real CLI
// invocations against real temp `.richmd/rules/*.lua` files and real
// fixture `.md` documents — same convention as test/extension-cli.test.js
// and test/config-dir.test.js: no mocking, `execFile` against
// bin/richmd.js.

async function setupRepo({ rules, markdown }) {
  const workDir = await mkdtemp(path.join(tmpdir(), "richmd-rules-cli-"));
  const rulesDir = path.join(workDir, ".richmd", "rules");
  await mkdir(rulesDir, { recursive: true });
  for (const [filename, contents] of Object.entries(rules ?? {})) {
    await writeFile(path.join(rulesDir, filename), contents);
  }
  const mdPath = path.join(workDir, "doc.md");
  await writeFile(mdPath, markdown);
  return { workDir, rulesDir, mdPath };
}

// A cardinality rule: at most 1 callout block allowed. Uses the block
// projection's `kind` field, and reports the LATEST offending block's
// location (design.md §05 Interface: "its <location> names the latest
// block the rule found offending").
const AT_MOST_ONE_CALLOUT_RULE = [
  "return {",
  "  check = function(block_projections, add_error)",
  "    local count = 0",
  "    for _, bp in ipairs(block_projections) do",
  "      if bp.kind == 'callout' then",
  "        count = count + 1",
  "        if count > 1 then",
  "          add_error('rule:at-most-one-callout', bp.location, 'at most one callout block is allowed per document')",
  "        end",
  "      end",
  "    end",
  "  end,",
  "}",
].join("\n");

// Case 1: no .richmd/rules/ directory at all — zero rules loaded, existing
// per-block validation behavior completely unaffected.
describe("cross-block rules (no .richmd/rules/ directory at all)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    const workRoot = await mkdtemp(path.join(tmpdir(), "richmd-no-rules-"));
    workDir = workRoot;
    mdPath = path.join(workDir, "doc.md");
    await writeFile(mdPath, '::: {.callout tint="info"}\nHello.\n:::\n');
    htmlPath = path.join(workDir, "doc.html");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("zero rules loaded: a normal document still validates and renders", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });
});

// Case 2 & 3: a single valid rule, passing on a compliant doc, failing on a
// non-compliant one.
describe("cross-block rules (cardinality rule: at most one callout)", () => {
  it("passes on a compliant document — exits 0, HTML written", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "at-most-one-callout.lua": AT_MOST_ONE_CALLOUT_RULE },
      markdown: '::: {.callout tint="info"}\nOnly one.\n:::\n',
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("fails on a non-compliant document — exits non-zero, error printed with the LAST offending location, no HTML", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "at-most-one-callout.lua": AT_MOST_ONE_CALLOUT_RULE },
      markdown: [
        '::: {.callout tint="info"}',
        "First.",
        ":::",
        "",
        '::: {.callout tint="warning"}',
        "Second.",
        ":::",
        "",
        '::: {.callout tint="danger"}',
        "Third.",
        ":::",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /^richmd: \[rule:at-most-one-callout\] div\.callout: at most one callout block is allowed per document$/m,
      );
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 4: a rule's error source never collides with a same-named block
// kind's error format — a rule file literally named callout.lua reports
// [rule:callout], visibly distinct from a genuine callout block's
// [callout] error.
describe("cross-block rules (error source prefix never collides with a same-named block kind)", () => {
  it("a rule file named callout.lua reports [rule:callout], distinct from a real [callout] error", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: {
        "callout.lua": [
          "return {",
          "  check = function(block_projections, add_error)",
          "    add_error('rule:callout', 'div.callout', 'the rule fired')",
          "  end,",
          "}",
        ].join("\n"),
      },
      // Also trips the built-in callout schema (body is required but empty)
      // so BOTH a genuine [callout] error and a [rule:callout] error are
      // present in the same run.
      markdown: "::: {.callout}\n:::\n",
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /^richmd: \[rule:callout\] div\.callout: the rule fired$/m,
      );
      assert.match(result.stderr, /^richmd: \[callout\] div\.callout:/m);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 5: a rule's check receives block projections only after per-block
// validation completes, and rules run REGARDLESS of whether per-block
// errors already exist — both a per-block error and a rule error are
// collected together in the same errors list (design.md §05: "run each
// loaded cross-block rule once against that list" — runs unconditionally
// after the per-block/link/grammar walk, contributing to the SAME list).
describe("cross-block rules (rules run after per-block validation, regardless of per-block errors, into the SAME collected list)", () => {
  it("both the per-block schema error AND the rule's error are reported together", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "at-most-one-callout.lua": AT_MOST_ONE_CALLOUT_RULE },
      markdown: [
        // Empty body -> per-block schema error (callout's body is required).
        "::: {.callout}",
        ":::",
        "",
        '::: {.callout tint="warning"}',
        "Second.",
        ":::",
        "",
      ].join("\n"),
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // Per-block schema error present.
      assert.match(
        result.stderr,
        /^richmd: \[callout\] div\.callout: body is required but was empty$/m,
      );
      // Rule error present too, in the same run.
      assert.match(
        result.stderr,
        /^richmd: \[rule:at-most-one-callout\] div\.callout: at most one callout block is allowed per document$/m,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 6: a malformed rule file (bad Lua syntax) is fatal — filter refuses
// to run entirely.
describe("cross-block rules (malformed rule file — bad Lua syntax — is a fatal startup error)", () => {
  it("exits non-zero, no HTML, message names the offending file", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "broken.lua": "this is not ) valid lua (((" },
      markdown: "# Plain doc\n\nNothing fancy.\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /broken\.lua/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 7: a rule file that loads fine but returns neither a function nor
// {check=...} is a fatal load-time error naming the file and the illegal
// shape.
describe("cross-block rules (rule file returns an illegal shape — is a fatal startup error)", () => {
  it("a bare number: exits non-zero naming the file and the illegal shape", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "not-a-function.lua": "return 42" },
      markdown: "# Plain doc\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /not-a-function\.lua/);
      assert.match(
        result.stderr,
        /neither a function nor a table with a 'check' function field/,
      );
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("a table with a non-function check field: exits non-zero naming the file and the illegal shape", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: { "bad-check.lua": "return { check = 'nope' }" },
      markdown: "# Plain doc\n",
    });
    try {
      const result = await runCli(["render", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /bad-check\.lua/);
      assert.match(
        result.stderr,
        /neither a function nor a table with a 'check' function field/,
      );
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 8: a rule's check function itself raising a Lua runtime error
// partway through is a hard filter failure: every error already collected
// (from an earlier per-block check, or an earlier rule in load order) is
// still printed; the crash itself names the crashing rule, not a block
// location; non-zero exit; rules after the crashing one never run.
describe("cross-block rules (a rule's check crashing at runtime preserves prior errors and names the rule)", () => {
  it("prior per-block error and earlier rule's error are both printed; crash names the rule; later rule never runs", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: {
        // Loaded/run before the crashing rule (alphabetically first — 'a-'
        // prefix), so its own error must survive the later crash.
        "a-earlier-rule.lua": [
          "return {",
          "  check = function(block_projections, add_error)",
          "    add_error('rule:a-earlier-rule', 'div.callout', 'earlier rule error')",
          "  end,",
          "}",
        ].join("\n"),
        "b-crashing-rule.lua": [
          "return {",
          "  check = function(block_projections, add_error)",
          "    error('boom: something went wrong inside the rule')",
          "  end,",
          "}",
        ].join("\n"),
        "c-never-runs.lua": [
          "return {",
          "  check = function(block_projections, add_error)",
          "    add_error('rule:c-never-runs', 'div.callout', 'should never appear')",
          "  end,",
          "}",
        ].join("\n"),
      },
      // Empty body -> per-block schema error too (callout's body is required).
      markdown: "::: {.callout}\n:::\n",
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      // Per-block error, collected before rules ran, survives.
      assert.match(
        result.stderr,
        /\[callout\] div\.callout: body is required but was empty/,
      );
      // Earlier rule's error, collected before the crash, survives.
      assert.match(
        result.stderr,
        /\[rule:a-earlier-rule\] div\.callout: earlier rule error/,
      );
      // The crash itself names the crashing rule, not a block location.
      assert.match(result.stderr, /rule:b-crashing-rule/);
      assert.match(result.stderr, /boom: something went wrong inside the rule/);
      // The rule after the crashing one never ran.
      assert.doesNotMatch(result.stderr, /should never appear/);
      await assert.rejects(() => access(path.join(workDir, "doc.html")));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 9: multiple rules loaded, all run, all their violations collected
// together.
describe("cross-block rules (multiple rules all run, all violations collected)", () => {
  it("two independently-violated rules both report", async () => {
    const { workDir, mdPath } = await setupRepo({
      rules: {
        "rule-one.lua": [
          "return {",
          "  check = function(block_projections, add_error)",
          "    add_error('rule:rule-one', 'div.callout', 'violation one')",
          "  end,",
          "}",
        ].join("\n"),
        "rule-two.lua": [
          "return {",
          "  check = function(block_projections, add_error)",
          "    add_error('rule:rule-two', 'div.callout', 'violation two')",
          "  end,",
          "}",
        ].join("\n"),
      },
      markdown: '::: {.callout tint="info"}\nHello.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /\[rule:rule-one\] div\.callout: violation one/,
      );
      assert.match(
        result.stderr,
        /\[rule:rule-two\] div\.callout: violation two/,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

// Case 10: a rule using the block projection's attrs and body_text fields
// meaningfully.
describe("cross-block rules (block projection carries usable attrs and body_text)", () => {
  it("a rule checking every callout's body_text contains a required substring", async () => {
    const rule = [
      "return {",
      "  check = function(block_projections, add_error)",
      "    for _, bp in ipairs(block_projections) do",
      "      if bp.kind == 'callout' then",
      "        if not string.find(bp.body_text, 'REQUIRED') then",
      "          add_error('rule:body-must-mention-required', bp.location, 'callout body must mention REQUIRED')",
      "        end",
      "        if bp.attrs.tint ~= 'info' then",
      "          add_error('rule:body-must-mention-required', bp.location, 'callout tint attr must be info, got ' .. tostring(bp.attrs.tint))",
      "        end",
      "      end",
      "    end",
      "  end,",
      "}",
    ].join("\n");

    const { workDir, mdPath } = await setupRepo({
      rules: { "body-must-mention-required.lua": rule },
      markdown:
        '::: {.callout tint="warning"}\nThis body lacks the magic word.\n:::\n',
    });
    try {
      const result = await runCli(["validate", mdPath]);
      assert.notEqual(result.code, 0);
      assert.match(
        result.stderr,
        /\[rule:body-must-mention-required\] div\.callout: callout body must mention REQUIRED/,
      );
      assert.match(
        result.stderr,
        /\[rule:body-must-mention-required\] div\.callout: callout tint attr must be info, got warning/,
      );
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it("passes when attrs and body_text both satisfy the rule", async () => {
    const rule = [
      "return {",
      "  check = function(block_projections, add_error)",
      "    for _, bp in ipairs(block_projections) do",
      "      if bp.kind == 'callout' then",
      "        if not string.find(bp.body_text, 'REQUIRED') then",
      "          add_error('rule:body-must-mention-required', bp.location, 'callout body must mention REQUIRED')",
      "        end",
      "      end",
      "    end",
      "  end,",
      "}",
    ].join("\n");

    const { workDir, mdPath } = await setupRepo({
      rules: { "body-must-mention-required.lua": rule },
      markdown:
        '::: {.callout tint="info"}\nThis body has the REQUIRED word.\n:::\n',
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

// Regression: an existing extension-cli-style test still passes unmodified
// with rules-loader wired in (no rules dir at all in that scenario).
describe("cross-block rules wiring does not affect an unrelated repo with no rules dir", () => {
  it("a plain document with no .richmd at all still renders", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "richmd-rules-none-"));
    try {
      const mdPath = path.join(workDir, "doc.md");
      await writeFile(mdPath, "# Hello\n\nPlain doc, no richmd blocks.\n");
      const result = await runCli(["render", mdPath]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      await access(path.join(workDir, "doc.html"));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});

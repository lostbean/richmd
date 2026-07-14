// CLI-level (subprocess, execFile against bin/richmd.js) integration tests
// for the chart built-in block kind (design.md §04.1, ADR-0006). Mirrors
// test/vega-lite.test.js's pattern exactly: chart is a composition kind that
// expands a markdown table into a vega-lite spec and must render
// byte-for-byte the same way a hand-authored ```vega-lite block does — the
// same .richmd-diagram/.richmd-vega container, the same CDN/offline runtime.

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

describe("richmd render (chart, bar type, 2-column table)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-chart-bar-"));
    mdPath = path.join(workDir, "chart-bar-valid.md");
    htmlPath = path.join(workDir, "chart-bar-valid.html");
    await cp(path.join(fixturesDir, "chart-bar-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
  });

  it("produces a working vega-lite bar chart with the first column bound to x and the second to y, rendered in the exact same container a hand-authored vega-lite block uses", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<div class="richmd-diagram">/);
    assert.match(html, /<div id="[^"]*" class="richmd-vega">/);
    assert.match(
      html,
      /<script type="application\/json" class="richmd-vega-lite-spec">/,
    );
    assert.match(html, /"mark":\s*"bar"/);
    assert.match(html, /"field":\s*"Fruit"/);
    assert.match(html, /"field":\s*"Count"/);
    // Values from the table body must appear in the generated spec's data.
    assert.match(html, /"Apple"/);
    assert.match(html, /"Pear"/);
  });

  it("uses the exact same CDN/offline vega runtime as a hand-authored vega-lite block", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<script[^>]*src="[^"]*cdn\.jsdelivr\.net\/npm\/vega[^"]*"/,
    );
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/vega-embed/);
    assert.match(html, /vegaEmbed\(/);
    assert.match(html, /richmdDiagramTheme/);
  });
});

describe("richmd render (chart, line type, 2-column table)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-chart-line-"));
    mdPath = path.join(workDir, "chart-line-valid.md");
    htmlPath = path.join(workDir, "chart-line-valid.html");
    await cp(path.join(fixturesDir, "chart-line-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and produces a vega-lite line chart with x/y encoding from the table's first two columns", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /"mark":\s*"line"/);
    assert.match(html, /"field":\s*"Day"/);
    assert.match(html, /"field":\s*"Events"/);
  });
});

describe("richmd render (chart, bar type, non-alphabetical row order) — regression", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-chart-bar-unordered-"),
    );
    mdPath = path.join(workDir, "chart-bar-unordered.md");
    htmlPath = path.join(workDir, "chart-bar-unordered.html");
    await cp(path.join(fixturesDir, "chart-bar-unordered.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("preserves the markdown table's row order instead of Vega-Lite's default alphabetical nominal sort", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");

    // The x channel must explicitly disable Vega-Lite's default
    // ascending-alphabetical nominal sort, so data.values order (i.e. the
    // markdown table's row order) is what actually renders.
    assert.match(html, /"x":\s*\{[^}]*"sort":\s*null[^}]*\}/);

    // "Low estimate" appears before "High estimate" in the source table,
    // which is NOT alphabetical order — data.values must preserve that.
    const lowIndex = html.indexOf("Low estimate");
    const highIndex = html.indexOf("High estimate");
    assert.ok(lowIndex >= 0, "expected 'Low estimate' to appear in output");
    assert.ok(highIndex >= 0, "expected 'High estimate' to appear in output");
    assert.ok(
      lowIndex < highIndex,
      "expected 'Low estimate' to appear before 'High estimate' (document order), not alphabetical order",
    );
  });
});

describe("richmd render (chart, bar type, x-axis label angle) — regression", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-chart-bar-label-angle-"),
    );
    mdPath = path.join(workDir, "chart-bar-valid.md");
    htmlPath = path.join(workDir, "chart-bar-valid.html");
    await cp(path.join(fixturesDir, "chart-bar-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("sets the x channel's axis labelAngle to 0 rather than leaving rotation unset (prevents Vega-Lite's eager auto-rotation from truncating short category labels)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /"x":\s*\{[^}]*"axis":\s*\{\s*"labelAngle":\s*0\s*\}[^}]*\}/,
    );
  });
});

describe("richmd render (chart, bar type, color channel) — categorical palette", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-chart-bar-color-"),
    );
    mdPath = path.join(workDir, "chart-bar-valid.md");
    htmlPath = path.join(workDir, "chart-bar-valid.html");
    await cp(path.join(fixturesDir, "chart-bar-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("adds a color channel keyed to the same field the x channel binds to, so bars are colored by category via the shared categorical palette (ADR-0007, design.md §04.1)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /"color":\s*\{\s*"field":\s*"Fruit",\s*"type":\s*"nominal"\s*\}/,
    );
  });

  it("does NOT set legend: null on the color channel — the legend stays visible (design-session decision, reversing an earlier 'hide as redundant' draft instinct) — regression guard", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    const colorChannelMatch = html.match(/"color":\s*\{[^}]*\}/);
    assert.ok(
      colorChannelMatch,
      "expected to find a color channel in the encoding",
    );
    assert.doesNotMatch(colorChannelMatch[0], /"legend"\s*:\s*null/);
    // Also confirm no legend:null appears anywhere in the embedded spec JSON
    // at all for this bar chart, not just scoped to the color channel match.
    assert.doesNotMatch(html, /"legend"\s*:\s*null/);
  });
});

describe("richmd render (chart, pie type, 2-column table)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-chart-pie-"));
    mdPath = path.join(workDir, "chart-pie-valid.md");
    htmlPath = path.join(workDir, "chart-pie-valid.html");
    await cp(path.join(fixturesDir, "chart-pie-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and produces a vega-lite arc mark with theta/color encoding (the real pie/donut idiom, not x/y)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /"mark":\s*"arc"/);
    assert.match(html, /"theta":\s*\{[^}]*"field":\s*"Share"/);
    assert.match(html, /"color":\s*\{[^}]*"field":\s*"Browser"/);
    // pie encoding must NOT use x/y channels.
    assert.doesNotMatch(html, /"encoding":\s*\{[^}]*"x":/);
    // color/category channel must not fall back to Vega-Lite's default
    // ascending-alphabetical nominal sort — document order wins.
    assert.match(html, /"color":\s*\{[^}]*"sort":\s*null[^}]*\}/);
  });
});

describe("richmd render (chart, pie type) — inherits the shared categorical palette with zero chart.lua code changes", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-chart-pie-palette-"),
    );
    mdPath = path.join(workDir, "chart-pie-valid.md");
    htmlPath = path.join(workDir, "chart-pie-valid.html");
    await cp(path.join(fixturesDir, "chart-pie-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // ADR-0007 / design.md §04.1: chart.lua's pie branch already emits a
  // color channel and needs ZERO code changes — it picks up the new
  // theme-aware categorical palette purely because vega-lite.lua's shared
  // base config (vega_lite_base_config_js, injected for EVERY rendered
  // vega-lite spec, chart-derived or hand-authored) now wires
  // `range: { category: c.categorical }` in unconditionally. This mirrors
  // test/vega-lite.test.js's "nominal color channel with no explicit
  // range" check, applied to a chart-derived pie spec specifically, to
  // prove the base config actually reaches chart output and not just
  // hand-authored ```vega-lite blocks.
  it("exits 0 and the embedded base config JS includes range.category sourced from richmdDiagramTheme()'s categorical field, reaching the chart-derived pie spec exactly like a hand-authored vega-lite block", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /range:\s*\{\s*category:\s*c\.categorical\s*,?\s*\}/);
  });

  it("the merged config actually carries a 6-entry range.category array end to end for the pie chart's rendered output (base config function invoked with a real richmdDiagramTheme()-shaped color object)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");

    const scriptMatches = [
      ...html.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    const script = scriptMatches.find(
      (s) => s.includes("richmdMergeConfig") && s.includes("range"),
    );
    assert.ok(script, "expected to find the script building the base config");

    const baseConfigFnSource = script.match(
      /function \(c\) \{[\s\S]*?\n {2}\}/,
    );
    assert.ok(
      baseConfigFnSource,
      "expected to isolate the base-config-building function's own source",
    );

    const fn = new Function("return (" + baseConfigFnSource[0] + ");");
    const baseConfigFn = fn();
    const fakeColors = {
      textMuted: "#666666",
      border: "#dddddd",
      fontBody: "Inter, sans-serif",
      categorical: [
        "#4f46e5",
        "#0891b2",
        "#16a34a",
        "#b45309",
        "#db2777",
        "#b91c1c",
      ],
    };
    const config = baseConfigFn(fakeColors);
    assert.ok(Array.isArray(config.range.category));
    assert.equal(config.range.category.length, 6);
    assert.deepEqual(config.range.category, fakeColors.categorical);
  });
});

describe("richmd render (chart, 3+ column table, no explicit x=/y=) — fail-closed gate", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-chart-ambiguous-"),
    );
    mdPath = path.join(workDir, "chart-ambiguous-columns.md");
    htmlPath = path.join(workDir, "chart-ambiguous-columns.html");
    await cp(path.join(fixturesDir, "chart-ambiguous-columns.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("names the chart block and the column-binding ambiguity specifically, never guessing or truncating to 2 columns", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /chart/);
    assert.match(result.stderr, /x=|y=|ambigu|column/i);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd render (chart, 3+ column table WITH explicit x=/y= attrs) — succeeds", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-chart-explicit-xy-"),
    );
    mdPath = path.join(workDir, "chart-explicit-xy-columns.md");
    htmlPath = path.join(workDir, "chart-explicit-xy-columns.html");
    await cp(path.join(fixturesDir, "chart-explicit-xy-columns.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and binds x/y to the explicitly named columns rather than the first two positionally", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /"field":\s*"Fruit"/);
    assert.match(html, /"field":\s*"Count"/);
  });
});

describe("richmd render (chart, invalid type value) — fail-closed gate", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-chart-invalid-type-"),
    );
    mdPath = path.join(workDir, "chart-invalid-type.md");
    htmlPath = path.join(workDir, "chart-invalid-type.html");
    await cp(path.join(fixturesDir, "chart-invalid-type.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero and writes no HTML", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /chart/);
    assert.match(result.stderr, /type/);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd validate (chart) — parity with render's validation", () => {
  let workDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-validate-chart-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 for a valid chart block, writes no HTML", async () => {
    const mdPath = path.join(workDir, "chart-bar-valid.md");
    await cp(path.join(fixturesDir, "chart-bar-valid.md"), mdPath);
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await assert.rejects(() =>
      access(path.join(workDir, "chart-bar-valid.html")),
    );
  });

  it("exits non-zero for a 3+ column table with no explicit x=/y= binding", async () => {
    const mdPath = path.join(workDir, "chart-ambiguous-columns.md");
    await cp(path.join(fixturesDir, "chart-ambiguous-columns.md"), mdPath);
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /chart/);
  });

  it("exits non-zero for an invalid type value", async () => {
    const mdPath = path.join(workDir, "chart-invalid-type.md");
    await cp(path.join(fixturesDir, "chart-invalid-type.md"), mdPath);
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /chart/);
    assert.match(result.stderr, /type/);
  });

  it("exits 0 for a 3+ column table WITH explicit x=/y= attrs", async () => {
    const mdPath = path.join(workDir, "chart-explicit-xy-columns.md");
    await cp(path.join(fixturesDir, "chart-explicit-xy-columns.md"), mdPath);
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
  });
});

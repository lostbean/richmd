// CLI-level (subprocess, execFile against bin/richmd.js) integration tests
// for the vega-lite block kind — mirrors test/mermaid.test.js's pattern
// exactly. Direct, in-process tests for the underlying grammar-check
// helper live in test/vega-lite-check.test.js.

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

describe("richmd render (vega-lite, valid input)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-valid-"),
    );
    mdPath = path.join(workDir, "vega-lite-valid.md");
    htmlPath = path.join(workDir, "vega-lite-valid.html");
    await cp(path.join(fixturesDir, "vega-lite-valid.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and writes a sibling .html file", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await access(htmlPath); // throws if missing
  });

  it("writes HTML containing the raw vega-lite JSON spec embedded in a recognizable container with the richmd-vega class", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<div id="[^"]*" class="richmd-vega">/);
    assert.doesNotMatch(html, /class="richmd-vega-lite"/);
    assert.match(html, /"mark":\s*"bar"/);
    assert.match(html, /"field":\s*"a"/);
  });

  it("writes HTML containing CDN script references for the vega-lite/vega-embed runtime", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(
      html,
      /<script[^>]*src="[^"]*cdn\.jsdelivr\.net\/npm\/vega[^"]*"/,
    );
    assert.match(html, /cdn\.jsdelivr\.net\/npm\/vega-embed/);
  });

  it("wraps the chart in the shared .richmd-diagram panel, with no title div when no title attr is set", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /<div class="richmd-diagram">/);
    // No actual title <div> element (the .richmd-diagram-title selector
    // text legitimately appears in the inlined theme <style> block, so
    // check for the element itself, not the bare class name substring).
    assert.doesNotMatch(html, /<div class="richmd-diagram-title">/);
    assert.match(
      html,
      /<div class="richmd-diagram">\s*<div id="[^"]*" class="richmd-vega">/,
    );
  });

  it("builds a base config from live --richmd-* CSS colors (via the shared richmdDiagramTheme helper) and passes it to vegaEmbed", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /richmdDiagramTheme/);
    assert.match(html, /background:\s*['"]transparent['"]/);
    assert.match(html, /axis:/);
    assert.match(html, /legend:/);
    assert.match(html, /vegaEmbed\(/);
  });

  it("pushes its render function onto the shared window.richmdDiagramRerenders array", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /window\.richmdDiagramRerenders\.push\(/);
  });

  // Bug fix: vega-lite charts previously rendered at vega-lite's own ~200px
  // built-in default width regardless of their actual container's width
  // (confirmed via direct browser inspection: a chart in a 662px-wide
  // .richmd-diagram panel rendered its actual canvas at only 218px), because
  // the author's spec was embedded verbatim with no `width` ever injected.
  // The fix measures the target container's REAL rendered width in the
  // browser at render time (richmdMeasureVegaWidth, using
  // getBoundingClientRect — this can only be known once the DOM has laid
  // out, never at Lua/build time) and injects it into the spec's `width`
  // UNLESS the author's own spec already set one explicitly.
  it("defines richmdMeasureVegaWidth and only injects width when the merged spec doesn't already have one", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /function\s+richmdMeasureVegaWidth/);
    assert.match(
      html,
      /typeof mergedSpec\.width === ['"]undefined['"]/,
      "expected the injection to be gated on the author's spec NOT already setting width",
    );
    assert.match(html, /mergedSpec\.width\s*=\s*measuredWidth/);
  });

  it("richmdMeasureVegaWidth itself: returns the measured width when positive, and null (meaning 'do not override') when the container measures 0 or has no getBoundingClientRect (executed in isolation via a fake element)", async () => {
    const html = await readFile(htmlPath, "utf8");
    const scriptMatches = [
      ...html.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    const script = scriptMatches.find((s) =>
      s.includes("richmdMeasureVegaWidth"),
    );
    assert.ok(
      script,
      "expected to find the script defining richmdMeasureVegaWidth",
    );

    const fnSource = script.match(
      /function richmdMeasureVegaWidth\([\s\S]*?\n {2}\}/,
    );
    assert.ok(
      fnSource,
      "expected to isolate richmdMeasureVegaWidth's own source",
    );

    const fn = new Function(fnSource[0] + "\n;return richmdMeasureVegaWidth;");
    const richmdMeasureVegaWidth = fn();

    assert.equal(
      richmdMeasureVegaWidth({ getBoundingClientRect: () => ({ width: 662 }) }),
      662,
    );
    assert.equal(
      richmdMeasureVegaWidth({ getBoundingClientRect: () => ({ width: 0 }) }),
      null,
    );
    assert.equal(richmdMeasureVegaWidth(null), null);
    assert.equal(richmdMeasureVegaWidth({}), null);
  });

  it("registers a window resize listener that re-runs the same render function (so charts re-measure and re-fit on viewport changes)", async () => {
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /addEventListener\(\s*['"]resize['"]/);
    // The resize handler must re-invoke the SAME embedRichmdVega_<id>
    // function pushed onto richmdDiagramRerenders (one re-render code path
    // shared by "on load", "on theme toggle", and "on resize" — never a
    // second, divergent resize-only rendering path), and it must be
    // debounced via requestAnimationFrame rather than firing synchronously
    // on every single resize event during a drag-resize.
    assert.match(html, /requestAnimationFrame\(/);
    assert.match(html, /cancelAnimationFrame\(/);
  });
});

describe("richmd render (vega-lite, spec with its own explicit width) — author's width is never overridden", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-explicit-width-"),
    );
    mdPath = path.join(workDir, "vega-lite-explicit-width.md");
    htmlPath = path.join(workDir, "vega-lite-explicit-width.html");
    await cp(path.join(fixturesDir, "vega-lite-explicit-width.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and the embedded spec JSON still has the author's own width value verbatim", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /"width":\s*321/);
  });

  it("the width-injection guard is present and would skip this spec (typeof check on mergedSpec.width, which is 321, not undefined)", async () => {
    const html = await readFile(htmlPath, "utf8");
    // Structural proof the injection is conditional at all (the dedicated
    // no-explicit-width describe block above proves the injection actually
    // fires when absent; a real headless-browser check — see this chunk's
    // work order report — additionally confirmed the rendered chart stays
    // at the author's own 321px-derived plot width across a window resize,
    // never growing to fill the container).
    assert.match(html, /typeof mergedSpec\.width === ['"]undefined['"]/);
  });
});

describe("richmd render (vega-lite, spec with its own config) — author config wins over richmd's base config", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-authorconfig-"),
    );
    mdPath = path.join(workDir, "vega-lite-author-config.md");
    htmlPath = path.join(workDir, "vega-lite-author-config.html");
    await cp(path.join(fixturesDir, "vega-lite-author-config.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and embeds a deep-merge call so the author's own config values are never silently overridden", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    // The author's spec config (a distinctive axis.labelColor the fixture
    // sets) must still be present verbatim in the embedded spec JSON.
    assert.match(html, /"labelColor":\s*"#ff00ff"/);
    // richmd's own merge logic must be present (a generic deep-merge
    // helper, not a hardcoded field-by-field copy) so it actually runs at
    // render time rather than the fixture's value merely surviving because
    // nothing touched it.
    assert.match(html, /function\s+richmdMergeConfig/);
  });

  it("deep-merges rather than shallow-replacing: richmd's other axis fields (e.g. gridColor) survive alongside the author's labelColor override", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    // Extract richmdMergeConfig and actually execute it against a base
    // config shaped like richmd's own (axis has gridColor + labelColor)
    // and an override shaped like the fixture's author config (axis has
    // ONLY labelColor) — proves the merge is a real recursive deep-merge,
    // not a top-level Object.assign that would drop richmd's gridColor
    // entirely once the author sets any axis field.
    const scriptMatches = [
      ...html.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    const script = scriptMatches.find((s) => s.includes("richmdMergeConfig"));
    assert.ok(script, "expected to find the script defining richmdMergeConfig");

    // The script is a self-invoking IIFE (richmd's own emitted shape),
    // which immediately touches `document`/`vegaEmbed` on load — rather
    // than stub a fake DOM/vegaEmbed just to let the whole IIFE run, this
    // isolates richmdMergeConfig's own function source (it has no closure
    // dependency on the surrounding IIFE scope — a pure, self-contained
    // recursive function) and evaluates just that.
    const mergeFnSource = script.match(
      /function richmdMergeConfig\([\s\S]*?\n {2}\}/,
    );
    assert.ok(
      mergeFnSource,
      "expected to isolate richmdMergeConfig's own source",
    );

    const fn = new Function(
      mergeFnSource[0] +
        "\n;return richmdMergeConfig({axis:{gridColor:'g',labelColor:'l'}}, {axis:{labelColor:'#ff00ff'}});",
    );
    const merged = fn();
    assert.equal(merged.axis.labelColor, "#ff00ff");
    assert.equal(merged.axis.gridColor, "g");
  });
});

describe("richmd render (vega-lite, spec with its own config.range.category) — author's categorical range wins over richmd's injected palette", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-author-range-"),
    );
    mdPath = path.join(workDir, "vega-lite-author-range-category.md");
    htmlPath = path.join(workDir, "vega-lite-author-range-category.html");
    await cp(
      path.join(fixturesDir, "vega-lite-author-range-category.md"),
      mdPath,
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and the embedded spec JSON still has the author's own config.range.category verbatim", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /"category":\s*\[\s*"#111111",\s*"#222222"\s*\]/);
  });

  it("richmdMergeConfig itself: given a base config with richmd's 6-color categorical range and an override with the author's own 2-color range, the merged result is the author's array VERBATIM — not concatenated, not element-wise merged (this is the mechanism the ADR-0007 'author wins' guarantee actually depends on)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    const scriptMatches = [
      ...html.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    const script = scriptMatches.find((s) => s.includes("richmdMergeConfig"));
    assert.ok(script, "expected to find the script defining richmdMergeConfig");

    const mergeFnSource = script.match(
      /function richmdMergeConfig\([\s\S]*?\n {2}\}/,
    );
    assert.ok(
      mergeFnSource,
      "expected to isolate richmdMergeConfig's own source",
    );

    const fn = new Function(
      mergeFnSource[0] +
        "\n;return richmdMergeConfig(" +
        "{range: {category: ['#4f46e5', '#0891b2', '#16a34a', '#b45309', '#db2777', '#b91c1c']}}, " +
        "{range: {category: ['#111111', '#222222']}}" +
        ");",
    );
    const merged = fn();
    assert.deepEqual(merged.range.category, ["#111111", "#222222"]);
  });

  it("the merged config's range.category is NOT richmd's 6-color palette (would falsely pass if the merge silently ignored the author's override or concatenated arrays instead of replacing wholesale)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.doesNotMatch(html, /"category":\s*\[\s*"#4f46e5"/);
  });
});

describe("richmd render (vega-lite, nominal color channel with no explicit range) — richmd's categorical palette applies by default", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-default-range-"),
    );
    mdPath = path.join(workDir, "vega-lite-nominal-color-no-range.md");
    htmlPath = path.join(workDir, "vega-lite-nominal-color-no-range.html");
    await cp(
      path.join(fixturesDir, "vega-lite-nominal-color-no-range.md"),
      mdPath,
    );
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 and the base config JS includes a range.category key sourced from richmdDiagramTheme()'s categorical field", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");
    assert.match(html, /range:\s*\{\s*category:\s*c\.categorical\s*,?\s*\}/);
  });

  it("the merged config actually carries a 6-entry range.category array end to end (base config function invoked with a real richmdDiagramTheme()-shaped color object)", async () => {
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    const html = await readFile(htmlPath, "utf8");

    // Isolate the base-config-building function (an anonymous `function (c) {
    // ... }` assigned inline as an argument to richmdMergeConfig's call
    // site) the same way the existing author-config test isolates
    // richmdMergeConfig itself, then invoke it with a fake theme color
    // object shaped exactly like richmdDiagramTheme()'s real return value.
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

describe("richmd render (vega-lite, valid input with title attr)", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-titled-"),
    );
    mdPath = path.join(workDir, "vega-lite-valid-titled.md");
    htmlPath = path.join(workDir, "vega-lite-valid-titled.html");
    await cp(path.join(fixturesDir, "vega-lite-valid-titled.md"), mdPath);
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
      /<div class="richmd-diagram">\s*<div class="richmd-diagram-title">Vega-Lite — daily events, last 14 days<\/div>\s*<div id="[^"]*" class="richmd-vega">/,
    );
  });
});

describe("richmd render (vega-lite, malformed JSON) — fail-closed gate", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-malformed-json-"),
    );
    mdPath = path.join(workDir, "vega-lite-malformed-json.md");
    htmlPath = path.join(workDir, "vega-lite-malformed-json.html");
    await cp(path.join(fixturesDir, "vega-lite-malformed-json.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("names the vega-lite block and calls out invalid JSON specifically", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /vega-lite/);
    assert.match(result.stderr, /JSON/i);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd render (vega-lite, valid JSON but invalid schema) — fail-closed gate", () => {
  let workDir;
  let mdPath;
  let htmlPath;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-vega-lite-invalid-schema-"),
    );
    mdPath = path.join(workDir, "vega-lite-invalid-schema.md");
    htmlPath = path.join(workDir, "vega-lite-invalid-schema.html");
    await cp(path.join(fixturesDir, "vega-lite-invalid-schema.md"), mdPath);
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits non-zero", async () => {
    const result = await runCli(["render", mdPath]);
    assert.notEqual(result.code, 0);
  });

  it("names the vega-lite block and the missing 'mark' field specifically, not a generic JSON error", async () => {
    const result = await runCli(["render", mdPath]);
    assert.match(result.stderr, /vega-lite/);
    assert.match(result.stderr, /mark/);
    // Distinguishing check: this is NOT the "not valid JSON" failure mode —
    // the JSON itself parses fine, only the vega-lite shape is wrong.
    assert.doesNotMatch(result.stderr, /not valid JSON/);
  });

  it("writes no HTML", async () => {
    await runCli(["render", mdPath]);
    await assert.rejects(() => access(htmlPath));
  });
});

describe("richmd validate (vega-lite)", () => {
  let workDir;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-validate-vega-lite-"));
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 0 for a valid vega-lite block, writes no HTML", async () => {
    const mdPath = path.join(workDir, "vega-lite-valid.md");
    await cp(path.join(fixturesDir, "vega-lite-valid.md"), mdPath);
    const result = await runCli(["validate", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    await assert.rejects(() =>
      access(path.join(workDir, "vega-lite-valid.html")),
    );
  });

  it("exits non-zero for a schema-invalid vega-lite block", async () => {
    const mdPath = path.join(workDir, "vega-lite-invalid-schema.md");
    await cp(path.join(fixturesDir, "vega-lite-invalid-schema.md"), mdPath);
    const result = await runCli(["validate", mdPath]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /vega-lite/);
  });
});

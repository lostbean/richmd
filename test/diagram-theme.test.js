// Tests for the shared diagram-theme runtime script (design.md §07): a
// single inline <script> emitted once per page (richmd-filter.lua's
// diagram_theme_script_html(), alongside theme_toggle_script_html()) that
// defines `window.richmdDiagramTheme()` (reads live --richmd-* CSS custom
// properties via getComputedStyle and maps them into a plain color object
// both mermaid.lua and vega-lite.lua consume) and
// `window.richmdRerenderDiagrams()` (a tiny pub/sub every diagram render
// script pushes its own re-render callback onto, invoked when the toggle
// dispatches a `richmd-theme-changed` DOM CustomEvent).
//
// Mirrors test/theme-shell.test.js's pattern exactly: extract the real
// script text from a real rendered page, then eval it against a fake
// document/getComputedStyle double to prove the *logic* actually works —
// not just that certain substrings appear in the output.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliPath = path.join(repoRoot, "bin", "richmd.js");

async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, ...args],
      { cwd: repoRoot, ...options },
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

function extractDiagramThemeScript(html) {
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  return scriptMatches.find((s) => s.includes("richmdDiagramTheme"));
}

function extractToggleScript(html) {
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1],
  );
  return scriptMatches.find(
    (s) => s.includes("addEventListener") && s.includes("click"),
  );
}

describe("richmd render — shared diagram-theme script", () => {
  let workDir;
  let mdPath;
  let htmlPath;
  let html;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-render-diagram-theme-"),
    );
    mdPath = path.join(workDir, "plain.md");
    htmlPath = path.join(workDir, "plain.html");
    await writeFile(mdPath, "# Hello\n\nJust a plain paragraph.\n");
    const result = await runCli(["render", mdPath]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    html = await readFile(htmlPath, "utf8");
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("emits exactly one shared diagram-theme script per page", async () => {
    const matches = [...html.matchAll(/richmdDiagramTheme\s*=\s*function/g)];
    assert.equal(matches.length, 1);
  });

  it("defines window.richmdDiagramTheme and window.richmdRerenderDiagrams", async () => {
    assert.match(html, /window\.richmdDiagramTheme\s*=\s*function/);
    assert.match(html, /window\.richmdRerenderDiagrams\s*=\s*function/);
    assert.match(html, /window\.richmdDiagramRerenders/);
  });

  it("listens for a richmd-theme-changed custom event and re-renders", async () => {
    assert.match(html, /addEventListener\(\s*["']richmd-theme-changed["']/);
  });

  it("is emitted BEFORE .richmd-container, so window.richmdDiagramTheme already exists when a diagram's own auto-invoked render script parses (regression: diagrams inside the container call richmdDiagramTheme() synchronously at parse time, not deferred to DOMContentLoaded — if this script were emitted after the container instead, richmdDiagramTheme would be undefined during every diagram's first render, and mermaid's real theme-color-math throws on undefined values, confirmed via a headless-browser reproduction)", async () => {
    const diagramThemeIdx = html.indexOf("richmdDiagramTheme = function");
    // This fixture has no `richmd-layout` frontmatter, so it gets the wide
    // default (design.md §07) — both richmd-container and
    // richmd-container--wide classes (see test/layout.test.js for dedicated
    // richmd-layout frontmatter coverage).
    const containerIdx = html.indexOf(
      '<div class="richmd-container richmd-container--wide">',
    );
    assert.ok(diagramThemeIdx >= 0 && containerIdx >= 0);
    assert.ok(
      diagramThemeIdx < containerIdx,
      "expected the shared diagram-theme script to appear before .richmd-container in the emitted HTML",
    );
  });

  it("never hardcodes a literal hex color — only reads --richmd-* custom properties (with generic fallbacks)", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script, "expected to find the diagram-theme script");
    // Every CSS custom property literal referenced by the script must be a
    // --richmd-* variable (read indirectly via a small `v(name, fallback)`
    // helper that calls cs.getPropertyValue(name) — the literal strings
    // appear as the helper's call-site arguments, not inside
    // getPropertyValue itself).
    const propertyReads = [
      ...script.matchAll(/v\(\s*["'](--[a-zA-Z0-9-]+)["']/g),
    ].map((m) => m[1]);
    assert.ok(
      propertyReads.length > 0,
      "expected at least one CSS variable read",
    );
    for (const prop of propertyReads) {
      assert.match(prop, /^--richmd-/);
    }
    // No literal hex color anywhere in the script itself (fallbacks may use
    // hex/rgba, so this only checks there's no hex value NOT inside a
    // fallback-looking string literal following a comma) — simplest strong
    // check: the script's own logic never assigns a bare hex constant to a
    // *.color* style property outside of the `fallback` parameter default
    // position. We assert instead that every returned field is produced by
    // calling `v(...)`, not a bare string literal.
    const returnedAssignments = [...script.matchAll(/(\w+):\s*v\(/g)].map(
      (m) => m[1],
    );
    assert.ok(
      returnedAssignments.length >= 10,
      "expected the color object's fields to each be produced via v(...)",
    );
  });

  it("reads live getComputedStyle values and maps them into the color object the diagram kinds consume (executed via a DOM stub)", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    const fakeCssVars = {
      "--richmd-color-bg": "#111111",
      "--richmd-color-bg-alt": "#222222",
      "--richmd-color-surface": "#1c2440",
      "--richmd-color-surface-2": "#131a2e",
      "--richmd-color-border": "rgba(226,232,248,0.22)",
      "--richmd-color-border-strong": "rgba(226,232,248,0.4)",
      "--richmd-color-text": "#e7ebf7",
      "--richmd-color-text-muted": "rgba(231,235,247,0.66)",
      "--richmd-color-text-faint": "rgba(231,235,247,0.4)",
      "--richmd-color-accent-solid": "#818cf8",
      "--richmd-color-accent-text": "#a5b4fc",
      "--richmd-color-accent-tint": "#232c4d",
      "--richmd-color-accent2-solid": "#22d3ee",
      "--richmd-color-accent2-text": "#67e8f9",
      "--richmd-font-body": "Inter, system-ui, sans-serif",
    };

    const fakeDocEl = { tagName: "DIV" };
    const fakeDocument = {
      querySelector(sel) {
        if (sel.includes("richmd-doc")) return fakeDocEl;
        return null;
      },
      documentElement: fakeDocEl,
      addEventListener() {},
    };

    function fakeGetComputedStyle(el) {
      return {
        getPropertyValue(name) {
          return fakeCssVars[name] || "";
        },
      };
    }

    const fn = new Function(
      "document",
      "getComputedStyle",
      "window",
      script + "\n;return window.richmdDiagramTheme();",
    );
    const fakeWindow = {};
    const colors = fn(fakeDocument, fakeGetComputedStyle, fakeWindow);

    assert.equal(colors.surface, "#1c2440");
    assert.equal(colors.border, "rgba(226,232,248,0.22)");
    assert.equal(colors.text, "#e7ebf7");
    assert.equal(colors.textMuted, "rgba(231,235,247,0.66)");
    assert.equal(colors.accentSolid, "#818cf8");
    assert.equal(colors.accent2Solid, "#22d3ee");
    assert.equal(colors.fontBody, "Inter, system-ui, sans-serif");
  });

  it("categorical field: a 6-entry array whose first two entries are the SAME values as accentSolid/accent2Solid (reused, not re-read), and whose remaining four are read from --richmd-color-cat-3..6 (executed via the same DOM stub)", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    const fakeCssVars = {
      "--richmd-color-accent-solid": "#818cf8",
      "--richmd-color-accent2-solid": "#22d3ee",
      "--richmd-color-cat-3": "#22a355",
      "--richmd-color-cat-4": "#c98500",
      "--richmd-color-cat-5": "#d55181",
      "--richmd-color-cat-6": "#d9483f",
    };

    const fakeDocEl = { tagName: "DIV" };
    const fakeDocument = {
      querySelector(sel) {
        if (sel.includes("richmd-doc")) return fakeDocEl;
        return null;
      },
      documentElement: fakeDocEl,
      addEventListener() {},
    };

    function fakeGetComputedStyle() {
      return {
        getPropertyValue(name) {
          return fakeCssVars[name] || "";
        },
      };
    }

    const fn = new Function(
      "document",
      "getComputedStyle",
      "window",
      script + "\n;return window.richmdDiagramTheme();",
    );
    const colors = fn(fakeDocument, fakeGetComputedStyle, {});

    assert.ok(Array.isArray(colors.categorical));
    assert.equal(colors.categorical.length, 6);
    assert.deepEqual(colors.categorical, [
      "#818cf8",
      "#22d3ee",
      "#22a355",
      "#c98500",
      "#d55181",
      "#d9483f",
    ]);
    // The first two entries must literally equal the already-computed
    // accentSolid/accent2Solid fields — proving reuse, not a second
    // independent CSS read.
    assert.equal(colors.categorical[0], colors.accentSolid);
    assert.equal(colors.categorical[1], colors.accent2Solid);
  });

  it("categorical field falls back to hardcoded defaults (matching theme/default.css's light-mode values) when the CSS custom properties are absent", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    const fakeDocEl = { tagName: "DIV" };
    const fakeDocument = {
      querySelector(sel) {
        if (sel.includes("richmd-doc")) return fakeDocEl;
        return null;
      },
      documentElement: fakeDocEl,
      addEventListener() {},
    };
    function fakeGetComputedStyle() {
      return { getPropertyValue: () => "" };
    }

    const fn = new Function(
      "document",
      "getComputedStyle",
      "window",
      script + "\n;return window.richmdDiagramTheme();",
    );
    const colors = fn(fakeDocument, fakeGetComputedStyle, {});

    assert.equal(colors.categorical.length, 6);
    assert.equal(colors.categorical[2], "#16a34a");
    assert.equal(colors.categorical[3], "#b45309");
    assert.equal(colors.categorical[4], "#db2777");
    assert.equal(colors.categorical[5], "#b91c1c");
  });

  // --- OKLCH normalization (Fix 3) ---------------------------------------
  //
  // design.md §09 "Theme and diagram runtime": a diagram's colors are read
  // live from --richmd-* at render time, never hardcoded. Chrome returns
  // oklch() values unchanged from getComputedStyle, but mermaid throws on
  // oklch and vega throws "Unsupported color format" — so the moment any
  // diagram-facing token is an oklch() value, every diagram silently fails.
  // richmdDiagramTheme() therefore normalizes each color field: oklch() ->
  // #rrggbb hex; everything else passes through unchanged (byte-stability of
  // existing rgb/rgba/hex theme values). This is format conversion, not a
  // color choice — the live-read contract (P3) is preserved.

  function evalTheme(script, cssVars) {
    const fakeDocEl = { tagName: "DIV" };
    const fakeDocument = {
      querySelector(sel) {
        if (sel.includes("richmd-doc")) return fakeDocEl;
        return null;
      },
      documentElement: fakeDocEl,
      addEventListener() {},
    };
    function fakeGetComputedStyle() {
      return {
        getPropertyValue(name) {
          return cssVars[name] || "";
        },
      };
    }
    const fn = new Function(
      "document",
      "getComputedStyle",
      "window",
      script + "\n;return window.richmdDiagramTheme();",
    );
    return fn(fakeDocument, fakeGetComputedStyle, {});
  }

  const HEX6 = /^#[0-9a-f]{6}$/;

  it("normalizes every color field (and every categorical entry) to comma-free #rrggbb hex when the tokens are oklch() values — no oklch, no comma anywhere", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    // Every diagram-facing token set to an oklch() value.
    const cssVars = {
      "--richmd-color-bg": "oklch(98% 0.005 300)",
      "--richmd-color-bg-alt": "oklch(95% 0.01 300)",
      "--richmd-color-surface": "oklch(97% 0.008 260)",
      "--richmd-color-surface-2": "oklch(93% 0.012 260)",
      "--richmd-color-border": "oklch(85% 0.02 260)",
      "--richmd-color-border-strong": "oklch(75% 0.03 260)",
      "--richmd-color-text": "oklch(25% 0.02 260)",
      "--richmd-color-text-muted": "oklch(45% 0.02 260)",
      "--richmd-color-text-faint": "oklch(60% 0.02 260)",
      "--richmd-color-accent-solid": "oklch(55% 0.2 275)",
      "--richmd-color-accent-text": "oklch(50% 0.2 275)",
      "--richmd-color-accent-tint": "oklch(92% 0.05 275)",
      "--richmd-color-accent2-solid": "oklch(70% 0.15 195)",
      "--richmd-color-accent2-text": "oklch(60% 0.15 195)",
      "--richmd-color-cat-3": "oklch(65% 0.18 145)",
      "--richmd-color-cat-4": "oklch(70% 0.16 70)",
      "--richmd-color-cat-5": "oklch(65% 0.2 350)",
      "--richmd-color-cat-6": "oklch(58% 0.22 25)",
      "--richmd-font-body": "Inter, system-ui, sans-serif",
    };

    const colors = evalTheme(script, cssVars);

    const colorFields = [
      "bg",
      "bgAlt",
      "surface",
      "surface2",
      "border",
      "borderStrong",
      "text",
      "textMuted",
      "textFaint",
      "accentSolid",
      "accentText",
      "accentTint",
      "accent2Solid",
      "accent2Text",
    ];
    for (const field of colorFields) {
      assert.match(
        colors[field],
        HEX6,
        `expected ${field} to be #rrggbb, got ${colors[field]}`,
      );
    }
    for (let i = 0; i < colors.categorical.length; i++) {
      assert.match(
        colors.categorical[i],
        HEX6,
        `expected categorical[${i}] to be #rrggbb, got ${colors.categorical[i]}`,
      );
    }

    // fontBody is a font stack, not a color — must NOT be touched.
    assert.equal(colors.fontBody, "Inter, system-ui, sans-serif");

    // Belt-and-braces: no oklch and no comma survives in any color field.
    const allColorValues = colorFields
      .map((f) => colors[f])
      .concat(colors.categorical);
    for (const val of allColorValues) {
      assert.ok(!/oklch/i.test(val), `oklch survived in ${val}`);
      assert.ok(!val.includes(","), `comma survived in ${val}`);
    }
  });

  it("locks the OKLCH -> sRGB conversion math against a hand-verified reference value (CSS Color 4 sRGB-red anchor oklch(62.8% 0.25768 29.234) === #ff0000)", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    // oklch(62.8% 0.25768 29.234) is the CSS Color 4 spec's OKLCH encoding
    // of pure sRGB red (#ff0000) — an exact, externally-verifiable anchor
    // that locks the full OKLCH->OKLab->linear->gamma pipeline.
    const red = evalTheme(script, {
      "--richmd-color-accent-solid": "oklch(62.8% 0.25768 29.234)",
    });
    assert.equal(red.accentSolid, "#ff0000");

    // A second value computed by this repo's own reference math, to lock the
    // whole pipeline (L as percentage, mid-chroma, arbitrary hue).
    const teal = evalTheme(script, {
      "--richmd-color-accent-solid": "oklch(45% 0.08 190)",
    });
    assert.equal(teal.accentSolid, "#00635f");

    // L given as a plain number (0..1) rather than a percentage.
    const lavender = evalTheme(script, {
      "--richmd-color-accent-solid": "oklch(0.96 0.025 300)",
    });
    assert.equal(lavender.accentSolid, "#f4eeff");

    // An optional "/ alpha" component is ignored (we emit opaque hex).
    const tealAlpha = evalTheme(script, {
      "--richmd-color-accent-solid": "oklch(45% 0.08 190 / 0.5)",
    });
    assert.equal(tealAlpha.accentSolid, "#00635f");
  });

  it("passes rgb()/rgba()/hex/named values through UNCHANGED (byte-stability regression guard — only oklch is transformed)", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    const colors = evalTheme(script, {
      "--richmd-color-border": "rgba(226,232,248,0.22)",
      "--richmd-color-surface": "#1c2440",
      "--richmd-color-bg": "rgb(17, 17, 17)",
      "--richmd-color-text": "white",
      "--richmd-color-accent-solid": "#818cf8",
    });

    assert.equal(colors.border, "rgba(226,232,248,0.22)");
    assert.equal(colors.surface, "#1c2440");
    assert.equal(colors.bg, "rgb(17, 17, 17)");
    assert.equal(colors.text, "white");
    assert.equal(colors.accentSolid, "#818cf8");
  });

  it("categorical[0] still === accentSolid after normalization (reuse preserved, both normalized)", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    const colors = evalTheme(script, {
      "--richmd-color-accent-solid": "oklch(55% 0.2 275)",
      "--richmd-color-accent2-solid": "oklch(70% 0.15 195)",
    });

    assert.equal(colors.categorical[0], colors.accentSolid);
    assert.equal(colors.categorical[1], colors.accent2Solid);
    assert.match(colors.categorical[0], HEX6);
    assert.match(colors.categorical[1], HEX6);
  });

  it("a mermaid classDef string and a vega config built from the normalized object contain no oklch and no comma-in-color that would throw (lightweight consumer-shape guard; a real render-without-throwing assertion needs a headless browser and is intentionally NOT added — the repo has no browser dep)", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    const c = evalTheme(script, {
      "--richmd-color-bg": "oklch(98% 0.005 300)",
      "--richmd-color-surface": "oklch(97% 0.008 260)",
      "--richmd-color-border": "oklch(85% 0.02 260)",
      "--richmd-color-text": "oklch(25% 0.02 260)",
      "--richmd-color-accent-solid": "oklch(55% 0.2 275)",
      "--richmd-color-accent2-solid": "oklch(70% 0.15 195)",
      "--richmd-color-cat-3": "oklch(65% 0.18 145)",
    });

    // A mermaid classDef line, exactly the shape mermaid's classDef parser
    // chokes on when a fill contains commas (rgb(...)) or oklch(...).
    const classDef = `classDef n fill:${c.surface},stroke:${c.border},color:${c.text};`;
    assert.ok(!/oklch/i.test(classDef));
    // Only the two literal separators the classDef syntax itself uses may
    // appear — no comma inside a color token.
    for (const token of [c.surface, c.border, c.text, c.accentSolid]) {
      assert.ok(
        !token.includes(","),
        `classDef color token has comma: ${token}`,
      );
    }

    // A vega config fragment (range.category is c.categorical) — must
    // serialize with no oklch and every category color comma-free.
    const vegaConfig = {
      background: c.bg,
      range: { category: c.categorical },
      axis: { gridColor: c.border, labelColor: c.text },
    };
    const serialized = JSON.stringify(vegaConfig);
    assert.ok(!/oklch/i.test(serialized));
    for (const token of c.categorical) {
      assert.ok(
        !token.includes(","),
        `vega category color has comma: ${token}`,
      );
    }
  });

  it("richmdRerenderDiagrams calls every callback pushed onto richmdDiagramRerenders, and richmd-theme-changed triggers it", async () => {
    const script = extractDiagramThemeScript(html);
    assert.ok(script);

    let listener;
    const fakeDocEl = { tagName: "DIV" };
    const fakeDocument = {
      querySelector() {
        return fakeDocEl;
      },
      addEventListener(type, fn) {
        if (type === "richmd-theme-changed") listener = fn;
      },
    };
    function fakeGetComputedStyle() {
      return { getPropertyValue: () => "" };
    }

    const fakeWindow = {};
    const fn = new Function(
      "document",
      "getComputedStyle",
      "window",
      script + "\n;return window;",
    );
    const win = fn(fakeDocument, fakeGetComputedStyle, fakeWindow);

    let calledA = false;
    let calledB = false;
    win.richmdDiagramRerenders.push(() => {
      calledA = true;
    });
    win.richmdDiagramRerenders.push(() => {
      calledB = true;
    });

    assert.ok(
      listener,
      "expected a richmd-theme-changed listener to be registered",
    );
    listener();

    assert.equal(calledA, true);
    assert.equal(calledB, true);
  });

  it("end-to-end: clicking the real toggle script's button dispatches richmd-theme-changed, which the real diagram-theme script's listener catches and uses to call every registered rerender callback", async () => {
    // Combines BOTH real emitted scripts (the toggle's click handler and
    // the shared diagram-theme script) in one fake DOM/event-loop — proving
    // the actual wiring between them, not just that each script
    // individually contains the right substrings.
    const diagramThemeScript = extractDiagramThemeScript(html);
    const toggleScript = extractToggleScript(html);
    assert.ok(diagramThemeScript);
    assert.ok(toggleScript);

    class FakeClassList {
      constructor() {
        this.set = new Set();
      }
      add(c) {
        this.set.add(c);
      }
      remove(c) {
        this.set.delete(c);
      }
      contains(c) {
        return this.set.has(c);
      }
    }

    function makeFakeEl() {
      const attrs = {};
      return {
        attrs,
        classList: new FakeClassList(),
        textContent: "",
        listeners: {},
        setAttribute(name, value) {
          attrs[name] = String(value);
        },
        getAttribute(name) {
          return Object.hasOwn(attrs, name) ? attrs[name] : null;
        },
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        querySelector(sel) {
          if (sel.includes("richmd-theme-toggle-label")) return fakeLabelEl;
          if (sel.includes("richmd-theme-toggle-icon")) return fakeIconEl;
          return null;
        },
      };
    }

    const fakeLabelEl = { textContent: "" };
    const fakeIconEl = { textContent: "" };
    const fakeDocEl = makeFakeEl();
    const fakeButtonEl = makeFakeEl();

    // A single shared fake `document` both scripts run against — a real
    // EventTarget-like object so `dispatchEvent` on it actually invokes
    // listeners registered via `addEventListener`, exactly like the real
    // browser DOM does (this is the part that proves real wiring, not just
    // parallel independent stubs).
    const documentListeners = {};
    const fakeLocalStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    const fakeDocument = {
      querySelector(sel) {
        if (sel.includes("richmd-doc")) return fakeDocEl;
        if (sel.includes("richmd-theme-toggle-label")) return fakeLabelEl;
        if (sel.includes("richmd-theme-toggle-icon")) return fakeIconEl;
        if (sel.includes("richmd-theme-toggle")) return fakeButtonEl;
        return null;
      },
      addEventListener(type, fn) {
        if (type === "DOMContentLoaded") {
          fn();
          return;
        }
        documentListeners[type] = documentListeners[type] || [];
        documentListeners[type].push(fn);
      },
      dispatchEvent(event) {
        (documentListeners[event.type] || []).forEach((fn) => fn(event));
      },
      readyState: "complete",
    };

    class FakeCustomEvent {
      constructor(type) {
        this.type = type;
      }
    }

    function fakeGetComputedStyle() {
      return { getPropertyValue: () => "" };
    }

    // Load the diagram-theme script first (registers the
    // richmd-theme-changed listener + defines window.richmdRerenderDiagrams),
    // then the toggle script (registers the button's click listener) —
    // matching the real page's own script order.
    const fakeWindow = {};
    const loadDiagramTheme = new Function(
      "document",
      "getComputedStyle",
      "window",
      diagramThemeScript + "\n;return window;",
    );
    const win = loadDiagramTheme(
      fakeDocument,
      fakeGetComputedStyle,
      fakeWindow,
    );

    let mermaidRerenderCalled = false;
    let vegaRerenderCalled = false;
    win.richmdDiagramRerenders.push(() => {
      mermaidRerenderCalled = true;
    });
    win.richmdDiagramRerenders.push(() => {
      vegaRerenderCalled = true;
    });

    const loadToggle = new Function(
      "document",
      "localStorage",
      "window",
      "CustomEvent",
      toggleScript + "\n;return true;",
    );
    loadToggle(fakeDocument, fakeLocalStorage, win, FakeCustomEvent);

    assert.ok(
      fakeButtonEl.listeners.click,
      "expected the real toggle button to have a click listener",
    );
    assert.ok(
      documentListeners["richmd-theme-changed"],
      "expected the real diagram-theme script to have registered a richmd-theme-changed listener",
    );

    // Real click, on the real button, using the real toggle script.
    fakeButtonEl.listeners.click();

    assert.equal(
      mermaidRerenderCalled,
      true,
      "expected the toggle click to have triggered the mermaid-style rerender callback via the real richmd-theme-changed wiring",
    );
    assert.equal(
      vegaRerenderCalled,
      true,
      "expected the toggle click to have triggered the vega-lite-style rerender callback via the real richmd-theme-changed wiring",
    );
  });
});

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

// Every rendered page must wrap its content in the .richmd-doc/.richmd-topbar/
// .richmd-container shell that theme/default.css already fully styles
// (design.md §07 "inject one default stylesheet... into every rendered
// page" — page-shell injection is the same responsibility, just extended to
// the body). This is a plain document with no richmd blocks at all, so the
// shell must not depend on any particular block kind being present.
describe("richmd render (page shell + theme toggle)", () => {
  let workDir;
  let mdPath;
  let htmlPath;
  let html;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-shell-"));
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

  it("wraps body content in a .richmd-doc shell directly inside <body>", async () => {
    assert.match(html, /<body>\s*<div class="richmd-doc"/);
  });

  it("does not hardcode a data-richmd-theme value, letting CSS's prefers-color-scheme decide by default", async () => {
    // The shell's default should defer to the OS/CSS media query rather than
    // force either theme; the toggle script sets the attribute only once a
    // user has made an explicit choice (persisted to localStorage).
    assert.doesNotMatch(html, /<div class="richmd-doc"[^>]*data-richmd-theme=/);
  });

  it("includes a .richmd-topbar with .richmd-brand and the theme toggle button", async () => {
    assert.match(html, /<div class="richmd-topbar">/);
    assert.match(html, /<div class="richmd-brand">richmd<\/div>/);
    assert.match(html, /<button[^>]*class="richmd-theme-toggle"/);
  });

  it("wraps the actual document content in .richmd-container, nested inside .richmd-doc", async () => {
    // The anti-flash script (see the dedicated test below) legitimately sits
    // between .richmd-doc's opening tag and .richmd-topbar, ahead of
    // everything else so it runs before first paint — so this only asserts
    // relative order (topbar before container), not strict adjacency.
    // This fixture has no `richmd-layout` frontmatter at all, so it gets the
    // wide default (design.md §07) — both richmd-container and
    // richmd-container--wide classes (see test/layout.test.js for the
    // dedicated richmd-layout frontmatter coverage, narrow included).
    assert.match(
      html,
      /<div class="richmd-doc"[^>]*>[\s\S]*?<div class="richmd-topbar">[\s\S]*?<\/div>\s*<div class="richmd-container richmd-container--wide">/,
    );
    assert.match(
      html,
      /<div class="richmd-container richmd-container--wide">[\s\S]*Just a plain paragraph\.[\s\S]*<\/div>/,
    );
  });

  it("the topbar appears before the container inside .richmd-doc, and content stays inside the container", async () => {
    const docOpenIdx = html.indexOf('<div class="richmd-doc"');
    const topbarIdx = html.indexOf('<div class="richmd-topbar">');
    const containerIdx = html.indexOf(
      '<div class="richmd-container richmd-container--wide">',
    );
    const contentIdx = html.indexOf("Just a plain paragraph.");
    assert.ok(docOpenIdx >= 0 && topbarIdx > docOpenIdx);
    assert.ok(containerIdx > topbarIdx);
    assert.ok(contentIdx > containerIdx);
  });

  it("toggle button has a sun-icon+Light and moon-icon+Dark label structure", async () => {
    // theme/default.css's .richmd-theme-toggle expects a small icon element
    // followed by text; the script swaps both based on current state.
    assert.match(html, /richmd-theme-toggle-icon/);
    assert.match(html, /richmd-theme-toggle-label/);
  });

  it("static pre-JS markup pairs the sun icon with the Light label (matching the light CSS default)", async () => {
    assert.match(
      html,
      /<span class="richmd-theme-toggle-icon">☀<\/span><span class="richmd-theme-toggle-label">Light<\/span>/,
    );
  });

  it("emits an inline anti-flash script that runs before body content, applying any stored theme immediately", async () => {
    // The anti-flash script must read localStorage and set
    // data-richmd-theme on .richmd-doc BEFORE the rest of the body paints —
    // i.e. it must appear as the first child of .richmd-doc, ahead of the
    // topbar and container.
    assert.match(
      html,
      /<div class="richmd-doc"[^>]*>\s*<script>[\s\S]*?localStorage[\s\S]*?<\/script>\s*<div class="richmd-topbar">/,
    );
  });

  it("emits a toggle script that reads/writes the richmd-theme localStorage key and toggles data-richmd-theme", async () => {
    assert.match(html, /localStorage\.getItem\(\s*["']richmd-theme["']\s*\)/);
    assert.match(html, /localStorage\.setItem\(\s*["']richmd-theme["']/);
    assert.match(html, /data-richmd-theme/);
    assert.match(html, /addEventListener\(\s*["']click["']/);
  });

  it("toggle script logic actually flips light<->dark and updates label/icon (executed via a DOM stub)", async () => {
    // Build a tiny fake DOM/localStorage double and eval the toggle script's
    // logic in isolation to prove the click handler really flips the
    // attribute and label text, not just that the substrings are present.
    const scriptMatches = [
      ...html.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    // Distinguish the toggle script from the shared diagram-theme script
    // (richmd-filter.lua's diagram_theme_script_html()) — both scripts
    // legitimately use addEventListener (the toggle for its button's click,
    // the diagram-theme script for a richmd-theme-changed listener), so
    // match on the toggle's own distinctive click-handling shape instead.
    const toggleScript = scriptMatches.find(
      (s) =>
        s.includes("addEventListener") && s.includes("richmd-theme-toggle"),
    );
    assert.ok(
      toggleScript,
      "expected to find the toggle's click-handling script",
    );

    const store = {};
    const fakeLocalStorage = {
      getItem: (k) => (Object.hasOwn(store, k) ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    };

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
        removeAttribute(name) {
          delete attrs[name];
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

    const dispatchedEvents = [];
    const fakeDocument = {
      querySelector(sel) {
        if (sel.includes("richmd-doc")) return fakeDocEl;
        if (sel.includes("richmd-theme-toggle-label")) return fakeLabelEl;
        if (sel.includes("richmd-theme-toggle-icon")) return fakeIconEl;
        if (sel.includes("richmd-theme-toggle")) return fakeButtonEl;
        return null;
      },
      addEventListener(type, fn) {
        if (type === "DOMContentLoaded") fn();
      },
      dispatchEvent(event) {
        dispatchedEvents.push(event);
      },
      readyState: "complete",
    };

    // A minimal CustomEvent stub: the toggle script only needs `new
    // CustomEvent(type)` to construct an object it hands to
    // document.dispatchEvent — jsdom/browsers do much more, but nothing
    // else is observed here.
    class FakeCustomEvent {
      constructor(type) {
        this.type = type;
      }
    }

    const fn = new Function(
      "document",
      "localStorage",
      "window",
      "CustomEvent",
      toggleScript + "\n;return true;",
    );
    fn(
      fakeDocument,
      fakeLocalStorage,
      { localStorage: fakeLocalStorage },
      FakeCustomEvent,
    );

    assert.ok(
      fakeButtonEl.listeners.click,
      "expected the toggle button to have a click listener registered",
    );

    // Simulate a click starting from light (no attribute set = light default
    // per CSS's prefers-color-scheme fallback in this stub).
    fakeDocEl.setAttribute("data-richmd-theme", "light");
    fakeButtonEl.listeners.click();
    assert.equal(fakeDocEl.getAttribute("data-richmd-theme"), "dark");
    assert.equal(store["richmd-theme"], "dark");
    // Label/icon reflect the theme now ACTIVE (moon + "Dark"), not the
    // theme a further click would switch to.
    assert.equal(fakeLabelEl.textContent, "Dark");
    assert.equal(fakeIconEl.textContent, "☽");
    // The click must also dispatch a richmd-theme-changed DOM CustomEvent
    // (design.md §07 / this chunk's work order) — diagrams listen for this
    // on `document` to know when to re-render with fresh colors, so a
    // toggle click that flips the attribute WITHOUT firing this event would
    // silently leave every diagram frozen in its stale theme.
    assert.equal(dispatchedEvents.length, 1);
    assert.equal(dispatchedEvents[0].type, "richmd-theme-changed");

    fakeButtonEl.listeners.click();
    assert.equal(fakeDocEl.getAttribute("data-richmd-theme"), "light");
    assert.equal(store["richmd-theme"], "light");
    assert.equal(fakeLabelEl.textContent, "Light");
    assert.equal(fakeIconEl.textContent, "☀");
    assert.equal(dispatchedEvents.length, 2);
    assert.equal(dispatchedEvents[1].type, "richmd-theme-changed");
  });
});

// The anti-flash script must ALWAYS set data-richmd-theme on .richmd-doc to
// the RESOLVED active theme — stored choice if present, else the OS
// preference — from first paint, and keep it in sync with OS changes (unless
// an explicit stored choice wins). These tests eval the REAL emitted
// anti-flash script text against fake document/matchMedia/localStorage
// doubles, proving the resolution logic, not just substrings.
describe("richmd render — anti-flash resolved-theme attribute", () => {
  let workDir;
  let mdPath;
  let htmlPath;
  let html;

  before(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), "richmd-render-antiflash-"));
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

  function extractAntiFlashScript(pageHtml) {
    const scriptMatches = [
      ...pageHtml.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    // The anti-flash script is the one that reads localStorage and touches
    // data-richmd-theme via document.currentScript.parentElement — distinct
    // from the toggle script (which finds .richmd-doc via querySelector and
    // attaches a button click listener).
    return scriptMatches.find(
      (s) =>
        s.includes("localStorage") &&
        s.includes("currentScript") &&
        s.includes("data-richmd-theme"),
    );
  }

  // Builds the fake DOM/matchMedia/localStorage double the anti-flash script
  // runs against. `stored` is the localStorage value ("light"/"dark"/null),
  // `osDark` whether the OS prefers dark. Returns handles to inspect the
  // resolved attribute and to fire the media-query change listener.
  function runAntiFlash(script, { stored = null, osDark = false } = {}) {
    const attrs = {};
    const parentEl = {
      setAttribute(name, value) {
        attrs[name] = String(value);
      },
      getAttribute(name) {
        return Object.hasOwn(attrs, name) ? attrs[name] : null;
      },
    };

    const store = {};
    if (stored != null) store["richmd-theme"] = stored;
    const fakeLocalStorage = {
      getItem: (k) => (Object.hasOwn(store, k) ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    };

    let mqlDark = osDark;
    let changeListener = null;
    const mql = {
      get matches() {
        return mqlDark;
      },
      addEventListener(type, fn) {
        if (type === "change") changeListener = fn;
      },
      addListener(fn) {
        changeListener = fn;
      },
    };
    const fakeWindow = {
      matchMedia: (q) => {
        // Only the dark query is asked for by the script.
        assert.match(q, /prefers-color-scheme:\s*dark/);
        return mql;
      },
    };

    const dispatchedEvents = [];
    const fakeDocument = {
      currentScript: { parentElement: parentEl },
      dispatchEvent(event) {
        dispatchedEvents.push(event);
      },
    };

    class FakeCustomEvent {
      constructor(type) {
        this.type = type;
      }
    }

    const fn = new Function(
      "document",
      "window",
      "localStorage",
      "CustomEvent",
      script,
    );
    fn(fakeDocument, fakeWindow, fakeLocalStorage, FakeCustomEvent);

    return {
      resolved: () => parentEl.getAttribute("data-richmd-theme"),
      fireOsChange(nextDark) {
        mqlDark = nextDark;
        assert.ok(
          changeListener,
          "expected the anti-flash script to register an OS change listener",
        );
        changeListener();
      },
      dispatchedEvents,
      store,
    };
  }

  it("sets a matchMedia change listener via addEventListener('change') and always resolves the attribute on load", async () => {
    const script = extractAntiFlashScript(html);
    assert.ok(script, "expected to find the anti-flash script");
    const run = runAntiFlash(script, { stored: null, osDark: false });
    assert.equal(run.resolved(), "light");
  });

  it("OS-driven resolution: no stored choice, OS dark -> attribute 'dark'; OS light -> 'light'", async () => {
    const script = extractAntiFlashScript(html);
    assert.equal(runAntiFlash(script, { osDark: true }).resolved(), "dark");
    assert.equal(runAntiFlash(script, { osDark: false }).resolved(), "light");
  });

  it("stored choice wins on load: stored 'light' while OS is dark -> 'light'", async () => {
    const script = extractAntiFlashScript(html);
    const run = runAntiFlash(script, { stored: "light", osDark: true });
    assert.equal(run.resolved(), "light");
  });

  it("falls back to 'light' when window.matchMedia is not a function (older/headless)", async () => {
    const script = extractAntiFlashScript(html);
    const attrs = {};
    const parentEl = {
      setAttribute(n, v) {
        attrs[n] = String(v);
      },
      getAttribute(n) {
        return Object.hasOwn(attrs, n) ? attrs[n] : null;
      },
    };
    const fakeLocalStorage = { getItem: () => null, setItem: () => {} };
    const fakeDocument = {
      currentScript: { parentElement: parentEl },
      dispatchEvent() {},
    };
    const fn = new Function(
      "document",
      "window",
      "localStorage",
      "CustomEvent",
      script,
    );
    fn(fakeDocument, {}, fakeLocalStorage, class {});
    assert.equal(parentEl.getAttribute("data-richmd-theme"), "light");
  });

  it("OS-change sync (no stored choice): firing the media-query change updates the attribute AND dispatches richmd-theme-changed", async () => {
    const script = extractAntiFlashScript(html);
    const run = runAntiFlash(script, { stored: null, osDark: false });
    assert.equal(run.resolved(), "light");
    run.fireOsChange(true);
    assert.equal(run.resolved(), "dark");
    assert.equal(run.dispatchedEvents.length, 1);
    assert.equal(run.dispatchedEvents[0].type, "richmd-theme-changed");
  });

  it("OS-change ignored when a stored choice exists: stored 'light', OS flips to dark -> attribute STAYS 'light', no event", async () => {
    const script = extractAntiFlashScript(html);
    const run = runAntiFlash(script, { stored: "light", osDark: false });
    assert.equal(run.resolved(), "light");
    run.fireOsChange(true);
    assert.equal(run.resolved(), "light");
    assert.equal(run.dispatchedEvents.length, 0);
  });

  it("end-to-end: the OS-change event the anti-flash script dispatches drives a registered diagram rerender callback (via the real diagram-theme script)", async () => {
    const scriptMatches = [
      ...html.matchAll(/<script>([\s\S]*?)<\/script>/g),
    ].map((m) => m[1]);
    const antiFlash = extractAntiFlashScript(html);
    const diagramTheme = scriptMatches.find((s) =>
      s.includes("richmdDiagramTheme"),
    );
    assert.ok(antiFlash && diagramTheme);

    // One shared fake document so the anti-flash script's dispatchEvent
    // actually reaches the diagram-theme script's registered listener — the
    // real cross-script wiring, not parallel stubs.
    const documentListeners = {};
    const attrs = {};
    const parentEl = {
      setAttribute(n, v) {
        attrs[n] = String(v);
      },
      getAttribute(n) {
        return Object.hasOwn(attrs, n) ? attrs[n] : null;
      },
    };
    const fakeDocument = {
      currentScript: { parentElement: parentEl },
      querySelector() {
        return parentEl;
      },
      addEventListener(type, fn) {
        documentListeners[type] = documentListeners[type] || [];
        documentListeners[type].push(fn);
      },
      dispatchEvent(event) {
        (documentListeners[event.type] || []).forEach((fn) => fn(event));
      },
    };
    function fakeGetComputedStyle() {
      return { getPropertyValue: () => "" };
    }
    class FakeCustomEvent {
      constructor(type) {
        this.type = type;
      }
    }
    let mqlDark = false;
    let changeListener = null;
    const mql = {
      get matches() {
        return mqlDark;
      },
      addEventListener(type, fn) {
        if (type === "change") changeListener = fn;
      },
    };
    const fakeWindow = { matchMedia: () => mql };
    const fakeLocalStorage = { getItem: () => null, setItem: () => {} };

    // Load the diagram-theme script first (registers the
    // richmd-theme-changed listener), matching real page order.
    const loadDiagram = new Function(
      "document",
      "getComputedStyle",
      "window",
      diagramTheme + "\n;return window;",
    );
    const win = loadDiagram(fakeDocument, fakeGetComputedStyle, fakeWindow);

    let rerendered = false;
    win.richmdDiagramRerenders.push(() => {
      rerendered = true;
    });

    const loadAntiFlash = new Function(
      "document",
      "window",
      "localStorage",
      "CustomEvent",
      antiFlash,
    );
    loadAntiFlash(fakeDocument, win, fakeLocalStorage, FakeCustomEvent);

    assert.ok(changeListener, "expected an OS change listener");
    mqlDark = true;
    changeListener();

    assert.equal(parentEl.getAttribute("data-richmd-theme"), "dark");
    assert.equal(
      rerendered,
      true,
      "expected the OS-change event to drive a diagram rerender via the real wiring",
    );
  });

  it("byte-stability: two renders of the same input are byte-identical AND the .richmd-doc element carries no baked-in data-richmd-theme attribute (runtime-only)", async () => {
    // Same input file rendered twice to the same output path — the emitted
    // HTML (title included) must be a pure function of the input, so the two
    // renders are byte-identical.
    const stablePath = path.join(workDir, "stable.md");
    const stableHtml = path.join(workDir, "stable.html");
    const md = "# Stable\n\nA paragraph with a `code` span.\n";
    await writeFile(stablePath, md);
    const r1 = await runCli(["render", stablePath]);
    const out1 = await readFile(stableHtml, "utf8");
    const r2 = await runCli(["render", stablePath]);
    const out2 = await readFile(stableHtml, "utf8");
    assert.equal(r1.code, 0, `stderr: ${r1.stderr}`);
    assert.equal(r2.code, 0, `stderr: ${r2.stderr}`);
    assert.equal(out1, out2, "expected two renders to be byte-identical");
    // The attribute is set only at runtime by the anti-flash script; it must
    // never appear baked onto the .richmd-doc element in the static output
    // (that would break --check). Scoped to the .richmd-doc opening tag on
    // purpose: the inlined theme/default.css legitimately mentions
    // `[data-richmd-theme="…"]` in its CSS selectors/comments — those are not
    // a build-time attribute on the element, so a bare document-wide search
    // would give a false positive.
    assert.doesNotMatch(
      out1,
      /<div class="richmd-doc"[^>]*data-richmd-theme=/,
      "static HTML must not bake a data-richmd-theme attribute onto .richmd-doc",
    );
  });
});

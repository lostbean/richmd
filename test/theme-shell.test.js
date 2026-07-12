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
    assert.match(
      html,
      /<div class="richmd-doc"[^>]*>[\s\S]*?<div class="richmd-topbar">[\s\S]*?<\/div>\s*<div class="richmd-container">/,
    );
    assert.match(
      html,
      /<div class="richmd-container">[\s\S]*Just a plain paragraph\.[\s\S]*<\/div>/,
    );
  });

  it("the topbar appears before the container inside .richmd-doc, and content stays inside the container", async () => {
    const docOpenIdx = html.indexOf('<div class="richmd-doc"');
    const topbarIdx = html.indexOf('<div class="richmd-topbar">');
    const containerIdx = html.indexOf('<div class="richmd-container">');
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
    const toggleScript = scriptMatches.find((s) =>
      s.includes("addEventListener"),
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
      readyState: "complete",
    };

    const fn = new Function(
      "document",
      "localStorage",
      "window",
      toggleScript + "\n;return true;",
    );
    fn(fakeDocument, fakeLocalStorage, { localStorage: fakeLocalStorage });

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

    fakeButtonEl.listeners.click();
    assert.equal(fakeDocEl.getAttribute("data-richmd-theme"), "light");
    assert.equal(store["richmd-theme"], "light");
    assert.equal(fakeLabelEl.textContent, "Light");
    assert.equal(fakeIconEl.textContent, "☀");
  });
});

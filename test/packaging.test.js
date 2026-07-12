// Proves the Nix-packaged richmd binary actually works end to end — not
// just that `nix build` succeeds, but that the resulting derivation's
// `bin/richmd` correctly finds its OWN bundled filter/ and theme/ assets
// (via the same fileURLToPath(import.meta.url)-relative resolution
// bin/richmd.js already uses) and produces correct HTML, from a cwd that
// has nothing to do with the source checkout, with no devShell active.
//
// This is packaging/infrastructure work (chunk 7 / issue #8, ADR-0001): the
// "red" state before packages.default existed was `nix build` failing
// outright ("does not provide attribute 'packages'"). The "green" state is
// this test passing against the built derivation.
//
// Slow (invokes `nix build`, which touches the Nix store) — skipped
// entirely when `nix` isn't on PATH so `npm test` still runs cleanly in a
// non-Nix environment.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const fixturesDir = path.join(__dirname, "fixtures");

async function hasNix() {
  try {
    await execFileAsync("nix", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

describe(
  "packaged richmd (nix build .#default)",
  { concurrency: false },
  () => {
    let skip = false;
    let resultBin;
    let workDir;
    let mdPath;
    let htmlPath;

    before(async () => {
      if (!(await hasNix())) {
        skip = true;
        return;
      }

      // Build the flake package. Relies on the Nix store for caching, so a
      // prior build (e.g. from CI or a developer's local store) makes this
      // fast; a fully cold build is the slow path this test accepts.
      const { stdout } = await execFileAsync(
        "nix",
        ["build", ".#default", "--no-link", "--print-out-paths"],
        { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 },
      );
      const outPath = stdout.trim().split("\n").pop();
      resultBin = path.join(outPath, "bin", "richmd");

      workDir = await mkdtemp(path.join(tmpdir(), "richmd-packaging-"));
      mdPath = path.join(workDir, "callout-valid.md");
      htmlPath = path.join(workDir, "callout-valid.html");
      await cp(path.join(fixturesDir, "callout-valid.md"), mdPath);
    });

    after(async () => {
      if (workDir) {
        await rm(workDir, { recursive: true, force: true });
      }
    });

    it("nix build produces a runnable bin/richmd", (t) => {
      if (skip) {
        t.skip("nix not available in this environment");
        return;
      }
      assert.ok(resultBin, "expected an output path from nix build");
    });

    it("the packaged binary renders a real fixture end to end, from a cwd outside the repo, with no devShell active", async (t) => {
      if (skip) {
        t.skip("nix not available in this environment");
        return;
      }

      // Deliberately strip PATH down to bare essentials (no devShell pandoc)
      // to prove the derivation's own wrapped pandoc dependency is what makes
      // this work, not an ambient devShell.
      const strippedEnv = { PATH: "/usr/bin:/bin" };

      const { stdout: _out } = await execFileAsync(resultBin, [
        "render",
        mdPath,
      ]).catch((err) => {
        throw new Error(
          `packaged richmd render failed: ${err.stderr ?? err.message}`,
        );
      });
      void _out;

      const html = await readFile(htmlPath, "utf8");
      assert.match(html, /This is a valid callout body\./);
      assert.match(html, /--richmd-color-info-tint/);

      // Re-run once more with a hostile PATH to prove the wrapper's injected
      // pandoc is really what's being used, not one found on the ambient PATH.
      await rm(htmlPath, { force: true });
      await execFileAsync(resultBin, ["render", mdPath], { env: strippedEnv });
      const html2 = await readFile(htmlPath, "utf8");
      assert.match(html2, /This is a valid callout body\./);
    });
  },
);

// Proves scripts/example-hash-check's contract by running the REAL script
// against the REAL example docs and CLI (no mocks, matching the convention
// of every other script/CLI test in this suite, e.g. test/gate.test.js).
//
// The load-bearing property here is the one this script exists to protect
// and once violated: a check must not mutate the artifact it checks. The
// examples/*.html files are COMMITTED, TRACKED artifacts, and richmd's
// `render` writes its output as a sibling .html next to the source .md — so
// a script that rendered examples/<name>.md in place would silently
// overwrite the tracked file on every run, leaving the tree dirty (and, once
// `nix fmt` reflowed it, in tension with `nix flake check`, the repo's own
// formatted-tree gate). The script renders a copy in a temp dir instead;
// "leaves examples/ byte-for-byte untouched" is the regression test for that.
//
// These tests assert BEHAVIOR only — exit codes, output, and whether files
// changed on disk. Never which temp path the script picked, or anything else
// about how it renders away from examples/: that is the implementation's
// business, and pinning it here would just re-freeze the bug this fix
// removed.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  cp,
  readdir,
  readFile,
  stat,
  symlink,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.join(repoRoot, "scripts", "example-hash-check");
const examplesDir = path.join(repoRoot, "examples");

// Runs the real script. `options.scriptPath` overrides which copy of it to
// run (the mismatch case runs a throwaway copy of the repo); everything else
// is passed through to execFile.
async function runScript(args, options = {}) {
  const { scriptPath: overridePath, ...execOptions } = options;
  try {
    const { stdout, stderr } = await execFileAsync(
      overridePath ?? scriptPath,
      args,
      {
        cwd: repoRoot,
        ...execOptions,
      },
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

// A content+mtime fingerprint of every file under examples/ — strong enough
// to catch both a rewritten file and a byte-identical rewrite (which would
// still move the mtime, and would still be a write into a tracked tree).
async function fingerprintExamples() {
  const entries = await readdir(examplesDir, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .sort();
  const out = [];
  for (const file of files) {
    const [content, stats] = await Promise.all([
      readFile(file, "utf8"),
      stat(file),
    ]);
    out.push(
      `${path.relative(examplesDir, file)}\t${stats.mtimeMs}\t${content.length}\t${content}`,
    );
  }
  return out.join("\n");
}

describe("scripts/example-hash-check — leaves examples/ untouched", () => {
  // Every shipped example, so no doc's render path is silently exempt.
  for (const name of [
    "data-status-report",
    "architecture-report",
    "design-doc",
    "custom-theme-demo",
  ]) {
    it(`does not write, touch, or reflow any file under examples/ when checking ${name}`, async () => {
      const before = await fingerprintExamples();
      const result = await runScript([name]);
      assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
      const after = await fingerprintExamples();
      assert.equal(
        after,
        before,
        "examples/ changed on disk — the check must never write the artifact it checks",
      );
    });
  }
});

describe("scripts/example-hash-check — exit codes", () => {
  it("exits 0 and names the matching hash when the render matches the committed golden", async () => {
    const result = await runScript([]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stdout, /example-hash-check OK/);
    // The OK message names the hash it matched.
    assert.match(result.stdout, /\b[0-9a-f]{64}\b/);
  });

  it("defaults to data-status-report when given no example name", async () => {
    const result = await runScript([]);
    assert.equal(result.code, 0, `stderr was: ${result.stderr}`);
    assert.match(result.stdout, /data-status-report\.html\.sha256/);
  });

  it("exits 2 when the example source does not exist", async () => {
    const result = await runScript(["no-such-example-doc"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /example source not found/);
  });

  it("exits 2 on an unknown flag", async () => {
    const result = await runScript(["--not-a-real-flag"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /usage:/);
  });
});

// A mismatch is exercised against a throwaway COPY of the repo's rendering
// inputs with a deliberately altered example source — never by touching the
// real examples/ tree or a committed golden. The copy's own examples/ dir is
// what the script under test reads, since it resolves every path relative to
// its own location.
describe("scripts/example-hash-check — a mismatch fails loudly", () => {
  let workDir;
  let result;

  before(async () => {
    workDir = await mkdtemp(
      path.join(tmpdir(), "richmd-example-hash-mismatch-"),
    );
    for (const dir of [
      "bin",
      "filter",
      "helpers",
      "theme",
      "scripts",
      "examples",
    ]) {
      await cp(path.join(repoRoot, dir), path.join(workDir, dir), {
        recursive: true,
      });
    }
    await cp(
      path.join(repoRoot, "package.json"),
      path.join(workDir, "package.json"),
    );
    // node_modules is symlinked rather than copied: the CLI needs its deps,
    // and copying a full node_modules per test run would dominate the suite's
    // runtime for no added signal.
    await symlink(
      path.join(repoRoot, "node_modules"),
      path.join(workDir, "node_modules"),
    );

    // Alter the example's source so its render genuinely differs from the
    // (copied) committed golden — a real content drift, exactly what this
    // check exists to catch.
    await appendFile(
      path.join(workDir, "examples", "design-doc.md"),
      "\nA deliberately added sentence, to drift the rendered output.\n",
    );

    // Run the COPY's script, not the repo's, so every path it resolves stays
    // inside workDir.
    result = await runScript(["design-doc"], {
      cwd: workDir,
      scriptPath: path.join(workDir, "scripts", "example-hash-check"),
    });
  });

  after(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("exits 1", () => {
    assert.equal(result.code, 1);
  });

  it("says FAILED and shows both the committed and the fresh hash", () => {
    assert.match(result.stdout, /example-hash-check: FAILED/);
    assert.match(result.stdout, /committed hash: [0-9a-f]{64}/);
    assert.match(result.stdout, /fresh hash:\s+[0-9a-f]{64}/);
  });

  it("tells the contributor how to update the golden if the change was intentional", () => {
    assert.match(result.stdout, /npm run example:update-hash/);
  });
});

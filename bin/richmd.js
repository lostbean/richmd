#!/usr/bin/env node
// richmd CLI entry (design.md §02).
//
// `richmd render <file>` invokes Pandoc with richmd's Lua filter
// (--lua-filter, not a wrapper library — design.md §03) and writes the
// resulting HTML to a sibling `.html` file. Exits 0 on success; the Lua
// filter itself exits non-zero and writes nothing when the validate phase
// collects any errors (the fail-closed gate, §00).
//
// `richmd validate <file>` runs the exact same Lua filter — never a forked
// copy — but sets RICHMD_VALIDATE_ONLY=1 in the child's environment. The
// filter (richmd-filter.lua, Pandoc(doc)) checks that variable right after
// the validate phase and exits before ever reaching the render phase, on
// both success and failure. Both subcommands share the same exit-code
// contract: 0 = zero validation errors, 1 = errors collected.
//
// `richmd render <file> --offline` sets RICHMD_OFFLINE=1 in the child's
// environment, following the exact same env-var-signal pattern as
// RICHMD_VALIDATE_ONLY above. The Lua filter's render phase is the only
// thing that reads it (filter/blocks/mermaid.lua) — it has no effect on the
// validate phase or the fail-closed gate (design.md §02/§07, ADR-0004,
// issue #7).
//
// `richmd render <file> --check` (design.md §02 CLI entry) runs the exact
// same full pipeline (validate + render phases) as a normal render — every
// other flag on the same invocation (`--offline`, `--tree=<path>...`)
// shapes the in-memory result exactly as it would shape a write — but the
// generated HTML is captured via Pandoc's own stdout (`-o -`, the same
// stdout-capture mechanism `validate` already relies on below) instead of
// being written to the sibling `.html` path. That in-memory result is then
// byte-compared against whatever already exists at the sibling path:
// identical -> exit 0; the sibling is missing -> non-zero with a "missing"
// message; different -> non-zero with a textual diff. In every outcome
// `--check` never writes the sibling path — not on success, not on
// failure, not partially. If the validate phase collects errors, `--check`
// behaves exactly like a normal `render` without `--check`: non-zero exit,
// errors printed, nothing written AND nothing compared (checking freshness
// of a document that doesn't even validate is meaningless) — `runFilter`
// already returns non-zero and writes nothing in that case, so `--check`
// simply never reaches the comparison step.
//
// `richmd render <file> --tree=<path>` (design.md §02/§06, ADR-0005) is
// repeatable — a caller can pass it any number of times to build up a set
// of `.md` paths that should be classified as "in-tree" links wherever they
// appear as a rewritten cross-document link target. Unlike `--offline`
// (a single boolean), this carries a LIST of values, so it cannot reuse
// `env.X = "1"` directly — all occurrences are collected from `rest` first,
// then joined into one RICHMD_TREE env var (empty/unset when no `--tree`
// flag was given at all, so the Lua filter's module-level read sees exactly
// `nil` and behaves identically to before this flag existed).
//
// Delimiter choice: comma. A comma is not a valid character in a POSIX
// filename passed as a literal path segment in practice for this tool's
// use case (richmd's own fixtures, docs, and examples never use one), and
// unlike a null byte, a comma round-trips safely through `env.X = "..."`
// (a JS string), a real process environment variable (some platforms'
// APIs mishandle embedded NULs in env values), and back out through Lua's
// `os.getenv` + `string.gmatch` with no escaping machinery needed. richmd
// does not accept glob-expanded or shell-escaped paths here (no glob
// expansion happens inside richmd at all — the CLI contract says the shell
// or caller already expanded any globs before argv reaches richmd), so the
// paths seen here are always plain literal `.md` paths, never containing
// commas in the realistic case this flag is designed for.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lift } from "../filter/directive-lift.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filterPath = path.join(__dirname, "..", "filter", "richmd-filter.lua");

// Does this document declare its own title (so Pandoc's `<title>` comes from
// the document, not the input filename)? Covers Pandoc's two markdown title
// sources: a leading percent-line (`% Title`) and a YAML metadata block with a
// top-level `title:` key. Used only to decide whether the directive-lift temp
// file needs a `pagetitle` override so a native-form render stays byte-identical
// (see runFilter). A conservative check on these two documented forms — if a
// title is present we must NOT override it, so any borderline case biases toward
// "declares a title" only when clearly one of these forms.
function declaresOwnTitle(source) {
  // Percent-style title: a `% ...` line at the very top of the document
  // (optionally after a UTF-8 BOM), with actual text after the `%`.
  if (/^﻿?%\s*\S/.test(source)) {
    return true;
  }
  // YAML metadata block: `---` on its own line at the very top, then any lines
  // up to a closing `---` or `...`, scanned for a top-level `title:` key.
  const yamlMatch =
    /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(
      source,
    );
  if (yamlMatch) {
    const block = yamlMatch[1];
    // A top-level `title:` key (no leading indentation — nested keys don't set
    // the document title) with a non-empty value on the same line.
    if (/^title:[ \t]*\S/m.test(block)) {
      return true;
    }
  }
  return false;
}

function usage() {
  process.stderr.write(
    "usage: richmd render <file> [--offline] [--tree=<path>...] [--check]\n",
  );
  process.stderr.write("       richmd validate <file>\n");
}

// captureOutput: true routes Pandoc's rendered HTML back to the caller in
// memory (via the same `-o -` stdout mechanism `validate` already relies on
// to avoid writing anything) instead of writing it to `outputPath` and/or
// forwarding it to this process's own stdout. Used by `--check` (below) so
// it can byte-compare the in-memory result against the sibling `.html` file
// without ever touching that file.
function runFilter(
  inputPath,
  { validateOnly, outputPath, offline, tree, captureOutput },
) {
  // document-css=false suppresses Pandoc's own default template stylesheet
  // (which includes `body { max-width: 36em; ... }`) — richmd's theme owns
  // layout width entirely via .richmd-container/.richmd-container--wide, so
  // Pandoc's default must never compete with it.
  //
  // -f markdown-auto_identifiers disables Pandoc's OWN built-in heading-id
  // auto-assignment (the `auto_identifiers` markdown extension, on by
  // default): left enabled, Pandoc's reader sets a non-empty `identifier`
  // on EVERY heading during its own parse — including one with no authored
  // `{#id}` at all — which made richmd-filter.lua's heading_anchor_id
  // helper unable to tell "author wrote an explicit id" apart from "Pandoc
  // auto-slugified it", since both looked identical (a non-empty
  // `header.identifier`) by the time the Lua filter ever saw the AST.
  // Disabling this extension means `header.identifier` is empty unless the
  // author wrote `### Heading {#id}` themselves, restoring the exact
  // distinction design.md §00's "explicit id, else slug" invariant depends
  // on — richmd's OWN slugify function (filter/slugify.lua) still assigns
  // every other heading's id, completely unaffected, since it never relied
  // on this Pandoc extension being on in the first place.
  const args = [
    "--lua-filter",
    filterPath,
    "--standalone",
    "-f",
    "markdown-auto_identifiers",
    "-M",
    "document-css=false",
  ];
  if (outputPath) {
    args.push("-o", outputPath);
  } else {
    // No output path: either we're capturing stdout in memory (--check), or
    // we only care about the exit code and stderr (validate). Pandoc still
    // needs a sink, so send it to /dev/null-equivalent via a null output
    // target is not portable — instead just let it print to stdout.
    args.push("-o", "-");
  }

  const env = { ...process.env };
  if (validateOnly) {
    env.RICHMD_VALIDATE_ONLY = "1";
  }
  if (offline) {
    env.RICHMD_OFFLINE = "1";
  }
  if (tree && tree.length > 0) {
    env.RICHMD_TREE = tree.join(",");
  }

  // Directive lift (design.md §02.1, ADR-0010): normalize any bareword
  // directive (`:::kind {attrs}`) into native form (`::: {.kind attrs}`)
  // BEFORE Pandoc parses, so an attr-bearing bareword block becomes a real Div
  // that reaches validation instead of being silently read as prose.
  //
  // SEAM CONTRACT: the lift must NOT change the document's directory as Pandoc
  // sees it. The Lua filter derives doc_dir from PANDOC_STATE.input_files[1]
  // and uses it for both config-directory discovery (ADR-0009) and relative
  // `.md` cross-document link resolution. Feeding transformed text via stdin
  // would make input_files[1] become "-" and silently break both. So when the
  // lift changes anything, we write the lifted text to a temp file that is a
  // SIBLING of the original input (same directory), hand Pandoc that sibling,
  // and delete it afterward (try/finally, so it is removed even on throw). If
  // the lift is a no-op we pass the original path straight through.
  const original = readFileSync(inputPath, "utf8");
  const lifted = lift(original);
  let effectiveInput = inputPath;
  let tempInput = null;
  const pandocArgs = [...args];
  if (lifted !== original) {
    const parsed = path.parse(inputPath);
    tempInput = path.join(
      parsed.dir || ".",
      `.richmd-lift-${process.pid}-${Math.random().toString(36).slice(2)}.md`,
    );
    writeFileSync(tempInput, lifted);
    effectiveInput = tempInput;
    // Pandoc's standalone HTML template fills `<title>` from `pagetitle`, which
    // Pandoc sets to the document's own title if it declares one, else to the
    // input file's basename. Handing Pandoc a uniquely-named temp file would
    // leak that random name into the title in the no-title case. So when (and
    // only when) the document declares NO title of its own, pin `pagetitle` to
    // the ORIGINAL file's stem — exactly the fallback Pandoc would have used for
    // the original path. When the document DOES declare a title, we leave
    // `pagetitle` alone so the document's own title still wins, identical to a
    // native render. Either way the output stays byte-identical to rendering
    // the original path directly (the example hash checks depend on this).
    if (!declaresOwnTitle(lifted)) {
      pandocArgs.push("-M", `pagetitle=${parsed.name}`);
    }
  }

  try {
    const result = spawnSync("pandoc", [...pandocArgs, effectiveInput], {
      encoding: "utf8",
      env,
      // Default (1MB) is too small once --check routes a full render
      // (potentially including an --offline-embedded runtime bundle) through
      // stdout via `-o -` instead of writing it straight to a file.
      maxBuffer: 64 * 1024 * 1024,
    });

    if (result.error) {
      process.stderr.write(
        `richmd: failed to invoke pandoc: ${result.error.message}\n`,
      );
      return { status: 1, stdout: "" };
    }

    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    // In validate-only mode and in --check's capture mode, Pandoc's stdout is
    // never forwarded to this process's own stdout — `richmd validate` must
    // never produce output artifacts, and `--check`'s captured HTML is only
    // ever used in memory for the byte comparison, never printed wholesale.
    if (result.stdout && !validateOnly && !captureOutput) {
      process.stdout.write(result.stdout);
    }

    return { status: result.status ?? 1, stdout: result.stdout ?? "" };
  } finally {
    if (tempInput) {
      rmSync(tempInput, { force: true });
    }
  }
}

function render(inputPath, { offline, tree }) {
  const parsed = path.parse(inputPath);
  const outputPath = path.join(parsed.dir || ".", `${parsed.name}.html`);
  const { status } = runFilter(inputPath, {
    validateOnly: false,
    outputPath,
    offline,
    tree,
    captureOutput: false,
  });
  return status;
}

function validate(inputPath) {
  const { status } = runFilter(inputPath, {
    validateOnly: true,
    outputPath: null,
    offline: false,
    tree: [],
    captureOutput: false,
  });
  return status;
}

// Minimal line-based unified-style diff — enough for a CI log reader to see
// what changed, not a sophisticated visual diff (interface contract). No
// new dependency: richmd's Nix packaging pins npmDepsHash, so pulling in a
// diff library is a needless build-graph change for a CI-log convenience.
function lineDiff(expectedLabel, actualLabel, expected, actual) {
  const a = expected.split("\n");
  const b = actual.split("\n");
  const max = Math.max(a.length, b.length);
  const lines = [`--- ${expectedLabel}`, `+++ ${actualLabel}`];
  for (let i = 0; i < max; i++) {
    const lineA = a[i];
    const lineB = b[i];
    if (lineA === lineB) {
      continue;
    }
    if (lineA !== undefined) {
      lines.push(`-${lineA}`);
    }
    if (lineB !== undefined) {
      lines.push(`+${lineB}`);
    }
  }
  return lines.join("\n") + "\n";
}

// `richmd render <file> --check` (design.md §02 CLI entry, see file-header
// comment above). Runs the full pipeline, captures what would have been
// written, and byte-compares it against the existing sibling `.html`
// instead of writing it.
function check(inputPath, { offline, tree }) {
  const parsed = path.parse(inputPath);
  const outputPath = path.join(parsed.dir || ".", `${parsed.name}.html`);

  const { status, stdout } = runFilter(inputPath, {
    validateOnly: false,
    outputPath: null,
    offline,
    tree,
    captureOutput: true,
  });

  // Validate phase collected errors: identical behavior to a normal render
  // without --check — errors are already printed via stderr forwarding
  // above. Nothing written, nothing compared; checking freshness of a
  // document that doesn't even validate is meaningless.
  if (status !== 0) {
    return status;
  }

  if (!existsSync(outputPath)) {
    process.stderr.write(
      `richmd: --check failed: '${outputPath}' does not exist (nothing committed yet)\n`,
    );
    return 1;
  }

  const committed = readFileSync(outputPath, "utf8");
  if (committed === stdout) {
    return 0;
  }

  process.stderr.write(
    `richmd: --check failed: '${outputPath}' is stale (does not match a fresh render)\n`,
  );
  process.stderr.write(
    lineDiff(outputPath, "<fresh render>", committed, stdout),
  );
  return 1;
}

function main(argv) {
  const [command, file, ...rest] = argv;

  if (!file || (command !== "render" && command !== "validate")) {
    usage();
    return 1;
  }

  if (command === "validate") {
    // `--offline` and `--tree` are both render-only flags (interface
    // contract, issue #7 and design.md §02) — `validate`'s argument shape is
    // completely unchanged by either, so neither is even parsed out of
    // `rest` here. `--check` is render-only too, for the same reason.
    return validate(file);
  }

  // The only recognized optional flags, and only for `render`.
  const offline = rest.includes("--offline");
  const tree = rest
    .filter((arg) => arg.startsWith("--tree="))
    .map((arg) => arg.slice("--tree=".length));
  const checkOnly = rest.includes("--check");

  if (checkOnly) {
    return check(file, { offline, tree });
  }

  return render(file, { offline, tree });
}

process.exit(main(process.argv.slice(2)));

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
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filterPath = path.join(__dirname, "..", "filter", "richmd-filter.lua");

function usage() {
  process.stderr.write(
    "usage: richmd render <file> [--offline] [--tree=<path>...]\n",
  );
  process.stderr.write("       richmd validate <file>\n");
}

function runFilter(inputPath, { validateOnly, outputPath, offline, tree }) {
  // document-css=false suppresses Pandoc's own default template stylesheet
  // (which includes `body { max-width: 36em; ... }`) — richmd's theme owns
  // layout width entirely via .richmd-container/.richmd-container--wide, so
  // Pandoc's default must never compete with it.
  const args = [
    "--lua-filter",
    filterPath,
    "--standalone",
    "-M",
    "document-css=false",
  ];
  if (outputPath) {
    args.push("-o", outputPath);
  } else {
    // No output path: discard stdout, we only care about the exit code and
    // stderr. Pandoc still needs a sink, so send it to /dev/null-equivalent
    // via a null output target is not portable — instead just let it print
    // to stdout and we simply never read/write it anywhere.
    args.push("-o", "-");
  }
  args.push(inputPath);

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

  const result = spawnSync("pandoc", args, { encoding: "utf8", env });

  if (result.error) {
    process.stderr.write(
      `richmd: failed to invoke pandoc: ${result.error.message}\n`,
    );
    return 1;
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  // In validate-only mode, Pandoc's stdout (if any) is discarded rather than
  // forwarded — `richmd validate` must never produce output artifacts.
  if (result.stdout && !validateOnly) {
    process.stdout.write(result.stdout);
  }

  return result.status ?? 1;
}

function render(inputPath, { offline, tree }) {
  const parsed = path.parse(inputPath);
  const outputPath = path.join(parsed.dir || ".", `${parsed.name}.html`);
  return runFilter(inputPath, {
    validateOnly: false,
    outputPath,
    offline,
    tree,
  });
}

function validate(inputPath) {
  return runFilter(inputPath, {
    validateOnly: true,
    outputPath: null,
    offline: false,
    tree: [],
  });
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
    // `rest` here.
    return validate(file);
  }

  // The only recognized optional flags, and only for `render`.
  const offline = rest.includes("--offline");
  const tree = rest
    .filter((arg) => arg.startsWith("--tree="))
    .map((arg) => arg.slice("--tree=".length));

  return render(file, { offline, tree });
}

process.exit(main(process.argv.slice(2)));

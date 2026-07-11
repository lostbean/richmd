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

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filterPath = path.join(__dirname, "..", "filter", "richmd-filter.lua");

function usage() {
  process.stderr.write("usage: richmd render <file> [--offline]\n");
  process.stderr.write("       richmd validate <file>\n");
}

function runFilter(inputPath, { validateOnly, outputPath, offline }) {
  const args = ["--lua-filter", filterPath, "--standalone"];
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

function render(inputPath, { offline }) {
  const parsed = path.parse(inputPath);
  const outputPath = path.join(parsed.dir || ".", `${parsed.name}.html`);
  return runFilter(inputPath, { validateOnly: false, outputPath, offline });
}

function validate(inputPath) {
  return runFilter(inputPath, {
    validateOnly: true,
    outputPath: null,
    offline: false,
  });
}

function main(argv) {
  const [command, file, ...rest] = argv;

  if (!file || (command !== "render" && command !== "validate")) {
    usage();
    return 1;
  }

  // The only recognized optional flag, and only for `render` — `validate`'s
  // argument shape is unchanged (interface contract, issue #7).
  const offline = rest.includes("--offline");

  if (command === "validate") {
    return validate(file);
  }
  return render(file, { offline });
}

process.exit(main(process.argv.slice(2)));

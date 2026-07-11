#!/usr/bin/env node
// richmd CLI entry (design.md §02).
//
// `richmd render <file>` invokes Pandoc with richmd's Lua filter
// (--lua-filter, not a wrapper library — design.md §03) and writes the
// resulting HTML to a sibling `.html` file. Exits 0 on success; the Lua
// filter itself exits non-zero and writes nothing when the validate phase
// collects any errors (the fail-closed gate, §00).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filterPath = path.join(__dirname, "..", "filter", "richmd-filter.lua");

function usage() {
  process.stderr.write("usage: richmd render <file>\n");
}

function render(inputPath) {
  const parsed = path.parse(inputPath);
  const outputPath = path.join(parsed.dir || ".", `${parsed.name}.html`);

  const result = spawnSync(
    "pandoc",
    ["--lua-filter", filterPath, "--standalone", "-o", outputPath, inputPath],
    { encoding: "utf8" },
  );

  if (result.error) {
    process.stderr.write(
      `richmd: failed to invoke pandoc: ${result.error.message}\n`,
    );
    return 1;
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  return result.status ?? 1;
}

function main(argv) {
  const [command, file] = argv;

  if (command !== "render" || !file) {
    usage();
    return 1;
  }

  return render(file);
}

process.exit(main(process.argv.slice(2)));

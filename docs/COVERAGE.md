# richmd — coverage map

One row per meaningful system part. Every part is `captured` (a design
section describes it), `standard` (plain infrastructure, reason given), or
`out-of-scope`.

| Part                                              | Status       | Notes                                                                    |
| ------------------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| CLI entry (arg parsing, subcommands, `--offline`) | captured     | [design.md §02](design/design.md#02-cli-entry)                           |
| Pandoc Lua filter core (two-phase orchestration)  | captured     | [design.md §03](design/design.md#03-filter-core)                         |
| Block kind registry + extension loading           | captured     | [design.md §04](design/design.md#04-block-kind-registry)                 |
| Diagram/chart grammar validators (Node helpers)   | captured     | [design.md §05](design/design.md#05-grammar-validators)                  |
| Link resolver + slugifier                         | captured     | [design.md §06](design/design.md#06-link-resolver-and-slugifier)         |
| Theme/CSS asset + client-side diagram rendering   | captured     | [design.md §07](design/design.md#07-theme-and-diagram-runtime)           |
| Nix flake packaging                               | captured     | [ADR-0001](adr/0001-nix-flake-primary-npm-thin-wrapper.md#adr-0001)      |
| npm thin-wrapper package                          | captured     | [ADR-0001](adr/0001-nix-flake-primary-npm-thin-wrapper.md#adr-0001)      |
| Node helper dependency lockfile                   | standard     | conventional `package-lock.json`, pinned and committed; no bespoke logic |
| CI / pre-commit wiring                            | captured     | [design.md §08](design/design.md#08-ci)                                  |
| Hosting/publishing the rendered HTML              | out-of-scope | explicit no-goal — richmd only produces the `.html` file                 |

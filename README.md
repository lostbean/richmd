# richmd

Rich markdown to validated static HTML, via Pandoc + Lua filters. Convert
extended-markdown documents — callouts, cards, stat tiles, a table of
contents, typed labeled statements, embedded SVGs, mermaid diagrams,
vega-lite charts — into self-contained static HTML, with real grammar
validation that fails closed _before_ anything is written.

```
::: {.callout tint="warning"}
Rebuilding this index takes about ten minutes.
:::
```

```
richmd render docs.md   # writes docs.html, or fails with no output at all
```

## Why

Markdown alone can't express diagrams, callouts, or structured data
visuals. richmd adds a small, documented vocabulary of blocks on top of
standard markdown, validates every one of them before writing any output,
and renders the result as one self-contained HTML page. See
[`docs/design/design.md`](docs/design/design.md) for the full design and
[`USAGE_RULES.md`](USAGE_RULES.md) for the complete authoring reference.

## Install

### Nix (primary, reproducible)

```
nix run github:lostbean/richmd -- render <file>
```

or, as a flake input in another repo, reference
`richmd.packages.${system}.default`. This path bundles a pinned `pandoc`
(`haskellPackages.pandoc-cli`, built with Lua support) as a runtime
dependency of the derivation — nothing else needs to be installed, and
after the first build it requires no network access. See
[`docs/adr/0001-nix-flake-primary-npm-thin-wrapper.md`](docs/adr/0001-nix-flake-primary-npm-thin-wrapper.md)
for the rationale.

### npm (thin wrapper, non-Nix consumers)

```
npm install -g richmd   # or: npx richmd, or npm link in a checkout
```

The npm package is a thin wrapper: it ships `bin/richmd.js` plus the
`filter/`, `helpers/`, and `theme/` assets it needs, but it does **not**
vendor `pandoc`. You must have `pandoc` (built with Lua filter support) on
`PATH` yourself. This is intentional — only the Nix path is
self-contained/reproducible per ADR-0001.

## Usage

```
richmd render <file.md>              # writes a sibling <file>.html
richmd render <file.md> --offline    # same, but embeds diagram/chart
                                      # runtimes instead of CDN references
richmd validate <file.md>            # runs the same gate, writes nothing
```

Both commands exit `0` on success and `1` on any validation error, printing
every collected error (never just the first) to stderr. See
[`USAGE_RULES.md`](USAGE_RULES.md) for the full block vocabulary, the
extension mechanism for adding your own block kinds, and common pitfalls.

## What richmd is not

- Not a static-site generator — one document in, one page out; no
  navigation or search scaffolding.
- Not a WYSIWYG editor.
- Not a hosting or publishing tool — its job ends at a written `.html` file.
- Not a semantic validator — mermaid/vega-lite grammar is checked, but a
  chart referencing a field that doesn't exist in its data still passes.

See [`docs/design/design.md`](docs/design/design.md) §00 for the full goals
and no-goals.

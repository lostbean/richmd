# richmd

Rich markdown to validated static HTML, via Pandoc + Lua filters.

## Install

### Nix (primary, reproducible)

```
nix run github:lostbean/richmd -- render <file>
```

or, as a flake input in another repo, reference
`richmd.packages.${system}.default`. This path bundles a pinned
`pandoc` (`haskellPackages.pandoc-cli`, built with Lua support) as a
runtime dependency of the derivation — nothing else needs to be
installed, and after the first build it requires no network access.
See `docs/adr/0001-nix-flake-primary-npm-thin-wrapper.md` for the
rationale.

### npm (thin wrapper, non-Nix consumers)

```
npm install -g richmd   # or: npx richmd, or npm link in a checkout
```

The npm package is a thin wrapper: it ships `bin/richmd.js` plus the
`filter/` and `theme/` assets it needs, but it does **not** vendor
`pandoc`. You must have `pandoc` (built with Lua filter support) on
`PATH` yourself. This is intentional — only the Nix path is
self-contained/reproducible per ADR-0001.

## Usage

```
richmd render <file.md>     # writes a sibling <file>.html
richmd validate <file.md>   # runs the same gate, writes nothing
```

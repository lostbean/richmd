# Distribute richmd as a Nix flake, npm as a thin wrapper

<a id="adr-0001"></a>

richmd depends on Pandoc, Lua filters, and small Node helper scripts for
mermaid/vega-lite grammar validation — a mixed toolchain that is easy to let
drift across consumer repos. We considered npm as the primary distribution
(most repos already have Node tooling) with Nix as an optional wrapper, but
that makes reproducibility secondary infrastructure rather than a guarantee.
We chose a Nix flake as the primary package (Pandoc and Node helpers pinned,
Node dependencies built via `buildNpmPackage` with a committed lockfile,
fully reproducible and network-free after first build), with a thin npm
package wrapping the same CLI for non-Nix consumers who only want `npx
richmd`. This is hard to reverse once other repos depend on the flake output,
and it was a real trade-off against the more common npm-first path.

Amended: "Node helpers pinned" means pinned at _run_ time as well as build
time. The Lua filters invoke the helpers as a bare `node` resolved through
PATH, so the flake's packaged wrapper must put Node on PATH alongside Pandoc
— pinning Node only for the build left `nix run` broken on a host with no
Node, which is exactly the standalone guarantee this decision records. The
npm path deliberately does not match: the thin wrapper inherits whatever Node
invoked it, since pinning one there would defeat its purpose as the
non-Nix consumer path. That asymmetry is intentional.

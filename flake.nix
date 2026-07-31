{
  description = "richmd — rich markdown to static HTML, via Pandoc + Lua filters";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-utils.url = "github:numtide/flake-utils";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      nixpkgs,
      flake-utils,
      treefmt-nix,
      ...
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        treefmtEval = treefmt-nix.lib.evalModule pkgs {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
          programs.prettier = {
            enable = true;
            # richmd owns every HTML file it generates, byte for byte
            # (docs/adr/0002 spirit: one tool owns one artifact's
            # formatting) — letting prettier reformat one makes the
            # corresponding `--check` perpetually report false staleness,
            # since the check compares richmd's own raw output against
            # whatever is on disk. This covers both generated families: the
            # design documents (design-render --check) and the rendered
            # examples (richmd render --check, run over examples/ in CI).
            excludes = [
              "**/design.html"
              "examples/*.html"
            ];
          };
        };
        # Same rationale as the devShell below: the top-level `pandoc`
        # attribute lacks Lua support in this nixpkgs revision;
        # haskellPackages.pandoc-cli is the same version built through the
        # Haskell package set directly, with Lua filters enabled (`pandoc
        # --version` reports `+lua`). The packaged CLI needs this on its PATH
        # at *run* time, not just in the devShell (ADR-0001: `nix run` must
        # work standalone, without a separately-activated devShell).
        pandoc = pkgs.haskellPackages.pandoc-cli;

        richmd = pkgs.buildNpmPackage {
          pname = "richmd";
          version = "0.1.0";

          src = ./.;

          # richmd now has real runtime npm dependencies (mermaid + linkedom,
          # design.md §05 grammar validator — issue #4/chunk 3; ajv, added
          # for the vega-lite grammar validator's JSON-schema check — issue
          # #11): the package-lock.json is no longer dependency-free, so
          # forceEmptyCache no longer applies. npmDepsHash is pinned to the
          # real dependency cache's fixed-output hash so the build stays
          # reproducible and network-free after the first fetch.
          npmDepsHash = "sha256-dnyStPTbB2X77q0ZoHXOu3u/1x6S85hGJRmNej4ztj8=";

          # There's nothing to compile — bin/richmd.js and the Lua filters
          # ship as-is — so skip the default `npm run build`.
          dontNpmBuild = true;

          # Only ship what the CLI actually needs at runtime: the entry
          # point, the Lua filter tree it shells out to, and the theme CSS
          # asset it embeds. Excluding test/, docs/, scripts/ etc. keeps the
          # derivation's closure minimal and its content (hence hash)
          # unaffected by unrelated repo-tree changes.
          npmPackFlags = [ "--ignore-scripts" ];

          # bin/richmd.js resolves the filter directory relative to its own
          # location via fileURLToPath(import.meta.url), so once installed
          # under $out/lib/node_modules/richmd it finds $out's own bundled
          # filter/ and theme/ regardless of install prefix — no extra
          # wiring needed here beyond making sure those directories are
          # actually part of the npm package contents (package.json "files").

          nativeBuildInputs = [ pkgs.makeWrapper ];

          # With zero real dependencies, `npm install` never creates a
          # node_modules directory at all; npmInstallHook's install step
          # unconditionally does `find node_modules -maxdepth 1 ...` before
          # copying it into place, which aborts the build the moment
          # node_modules is missing. Give it an empty one to satisfy that
          # step — there's nothing to prune or copy either way.
          preInstall = ''
            mkdir -p node_modules
          '';

          # Wrap the installed bin so `pandoc` is guaranteed on PATH at run
          # time — this is what makes `nix run .#richmd` work standalone,
          # without requiring the devShell to be active (point 2 of the work
          # order).
          #
          # `nodejs` belongs on that same PATH for a less obvious reason.
          # Nix rewrites the helpers' `#!/usr/bin/env node` shebangs to
          # absolute store paths, so running a helper *directly* would be
          # self-contained — but the Lua filters never do that. They shell
          # out as `io.popen("node <helper> < <tmp>")` (filter/blocks/
          # mermaid.lua, filter/blocks/vega-lite.lua), a bare `node`
          # resolved through PATH at run time by /bin/sh. With no host node
          # installed that lookup fails, the helper never runs, and the
          # filter reports the missing-validator diagnostic instead of
          # rendering. Pinning node here is what makes ADR-0001's "Node
          # helpers pinned" true at *run* time and not merely at build time.
          #
          # No further wiring is needed for the helpers' own npm imports
          # (mermaid, linkedom, ajv): buildNpmPackage installs node_modules/
          # as a sibling of helpers/ under $out/lib/node_modules/richmd, so
          # Node's ordinary parent-directory resolution finds them from the
          # helper's own location, independent of cwd and NODE_PATH.
          postInstall = ''
            wrapProgram $out/bin/richmd \
              --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pandoc
                  pkgs.nodejs
                ]
              }
          '';

          meta = {
            description = "Rich markdown to validated static HTML, via Pandoc + Lua filters";
            mainProgram = "richmd";
          };
        };
      in
      {
        packages.default = richmd;
        packages.richmd = richmd;

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            lefthook
            nodejs
            # The top-level `pandoc` attribute is built without Lua support
            # in this nixpkgs revision; haskellPackages.pandoc-cli is the
            # same version built through the Haskell package set directly,
            # with Lua filters enabled (`pandoc --version` reports `+lua`).
            haskellPackages.pandoc-cli
          ];
        };

        formatter = treefmtEval.config.build.wrapper;

        checks.formatting = treefmtEval.config.build.check ./.;
      }
    );
}

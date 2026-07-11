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
          programs.prettier.enable = true;
        };
      in
      {
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

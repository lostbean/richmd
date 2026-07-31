<!-- agent-skills:begin -->
<!-- framework-commit: 6f5e8af9a89a185391f4206241b96a5be408c1b7 origin: git@github.com:lostbean/skills.git -->

(machine-owned; do not edit inside this fence — re-run setup to refresh)

## Agent skills

**Design layer** — the design document is `docs/design/design.md` (rendered
`docs/design/design.html`); terms are defined in `docs/design/CONTEXT.md`;
decisions are recorded in `docs/adr/`. Single-context layout, so there is no
`CONTEXT-MAP.md`.

**Tracker** — GitHub issues on `lostbean/richmd` via `gh issue list --repo
lostbean/richmd` / `gh issue create --repo lostbean/richmd` / `gh issue view
<n> --repo lostbean/richmd`. Labels: `needs-triage` → needs-triage,
`needs-info` → needs-info, `ready-for-agent` → ready-for-agent,
`ready-for-human` → ready-for-human, `in-progress` → in-progress, `done` →
done, `wontfix` → wontfix, `bug` → bug, `enhancement` → enhancement.

**AI disclaimer** — every AI-authored tracker comment starts with:
`[AI-authored — Claude Code]`.

**Design gate** — `node bin/richmd.js render <each design.md> --check`,
`scripts/layer-integrity .`, and a `.richmd/` projection-freshness check (the
config re-projects from `scripts/design-schema.json` and must match) check the
design layer (exit 0 clean, 1 violation, 2 error). This repo renders with its
own working-tree richmd rather than a pinned release, because a pinned binary
cannot catch a rendering regression in the tree it is gating. The richmd
config lives under `docs/design/.richmd/` and is generated, never hand-edited.

**Staleness** — if the system has moved many commits since the design
documents last changed, reconcile design and code before relying on the
layer.

<!-- agent-skills:end -->

## Conventions

Clean commit messages — no trailers, no attribution, no Co-Authored-By, no
"Generated with" footers.

Keep `USAGE_RULES.md` updated whenever a block kind, attr, or CLI flag
changes — it's the user-facing interface contract, and letting it drift
from the implementation is a breaking change to the user, not a docs nit.

## Tooling

- `nix develop` (or direnv, via `.envrc`) — dev shell with Node, Pandoc, and
  lefthook.
- `nix fmt` — formats the whole repo (nixfmt for Nix, prettier for
  JS/TS/JSON/Markdown/YAML) via treefmt.
- `nix flake check` — fails if the tree is not formatted.
- Pre-commit (lefthook): formats staged files and re-stages them, then runs
  the design gate (`node bin/richmd.js render --check` on every `design.md`,
  `scripts/layer-integrity .`, and `.richmd/` projection freshness).

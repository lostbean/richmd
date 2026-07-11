<!-- agent-skills:begin -->

(machine-owned; do not edit inside this fence — re-run setup to refresh)

## Agent skills

**Design layer** — `CONTEXT-MAP.md` indexes the design documents
(`design.md`, rendered `design.html`); terms are defined in each context's
`CONTEXT.md`; decisions are recorded in `docs/adr/`. Pending — the design
layer has not been created yet.

**Tracker** — GitHub issues on `lostbean/richmd` via `gh issue list --repo
lostbean/richmd` / `gh issue create --repo lostbean/richmd` / `gh issue view
<n> --repo lostbean/richmd`. Labels: `needs-triage` → needs-triage,
`needs-info` → needs-info, `ready-for-agent` → ready-for-agent,
`ready-for-human` → ready-for-human, `wontfix` → wontfix, `bug` → bug,
`enhancement` → enhancement.

**AI disclaimer** — every AI-authored tracker comment starts with:
`[AI-authored — Claude Code]`.

**Design gate** — `scripts/design-render --check <each design.md>` and
`scripts/layer-integrity .` check the design layer (exit 0 clean, 1
violation, 2 error).

**Staleness** — if the system has moved many commits since the design
documents last changed, reconcile design and code before relying on the
layer.

<!-- agent-skills:end -->

## Conventions

Clean commit messages — no trailers, no attribution, no Co-Authored-By, no
"Generated with" footers.

## Tooling

- `nix develop` (or direnv, via `.envrc`) — dev shell with Node, Pandoc, and
  lefthook.
- `nix fmt` — formats the whole repo (nixfmt for Nix, prettier for
  JS/TS/JSON/Markdown/YAML) via treefmt.
- `nix flake check` — fails if the tree is not formatted.
- Pre-commit (lefthook): formats staged files and re-stages them, then runs
  the design gate (`scripts/design-render --check` on every `design.md`,
  `scripts/layer-integrity .`).

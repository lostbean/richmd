# Config directory discovery walks upward from the document, bounded at the repo root

<a id="adr-0009"></a>

richmd resolves `.richmd/blocks/` (and now `.richmd/rules/`,
[ADR-0008](0008-cross-block-rules-as-block-projection-lua-hook.md#adr-0008))
relative to the rendered document's own directory. A consumer with documents
nested below the directory that owns their shared config — e.g.
`docs/design/<context>/design.md` under a `docs/design/.richmd/` a sibling
context also wants — has no way to point nested documents at the ancestor
directory. We considered an explicit `--config-dir=<path>` flag against an
upward filesystem walk from the document's directory that stops at the
nearest `.richmd/` found. We chose the walk: it needs no new CLI surface (the
existing `render`/`validate` calls already take a file path, and both must
resolve config identically — a flag only one subcommand accepted would be
inconsistent), and it matches the discovery convention tooling in this space
already establishes (git, eslint, prettier). We considered merging every
`.richmd/` found from the document up to the root against using only the
nearest one; we chose nearest-wins, no merge — merging introduces conflict
and ordering rules the single-registry model (design.md §04) has no
precedent for, and a document that wants its own directory's config
untouched by an ancestor's would otherwise have no way to opt out. The walk
stops at the first ancestor containing a `.git` directory (or the
[document](../design/CONTEXT.md#term-document)'s own directory if no
`.richmd/` is found by then) — bounding at the repository root avoids
silently picking up an unrelated `.richmd/` from outside the project, the
same reasoning a `.gitignore` or `.eslintrc` walk applies. A repository with
no `.git` directory anywhere above the document falls back to today's
behavior unchanged: config resolves from the document's own directory only.

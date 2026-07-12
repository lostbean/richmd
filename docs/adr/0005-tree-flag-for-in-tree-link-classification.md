# `--tree` narrows the single-document no-goal to add in-tree link classification

<a id="adr-0005"></a>

A consumer needing a distinct visual marker on links to sibling pages within
its own tree (vs. links leaving the tree entirely) has no equivalent in
richmd today: [cross-document link](../design/CONTEXT.md#term-cross-document-link)
rewriting is uniform by design, and the "not a static site generator" no-goal
(§00) reads "one document in, one page out." We considered rejecting the
need outright and pushing it to a consumer-side wrapper (render each file
independently, post-process the outputs against a manifest of in-tree
paths) — this keeps richmd's surface untouched but duplicates the AST link
walk richmd already performs, in a second, external pass. We considered a
JSON manifest file the render call reads — rejected as an extra artifact to
author and keep in sync when richmd already receives argv directly. We chose
a repeatable `--tree=<path>` CLI flag (literal paths, no glob-expansion code
in richmd — the shell or caller expands globs before richmd sees argv): the
[render phase](../design/CONTEXT.md#term-render-phase)'s existing link-rewrite
pass checks each resolved `.md` target against the flag's path set and adds
a CSS class (`richmd-intree-link`) with zero default styling, per the
existing style-is-swappable principle (P3). This narrows, not supersedes,
the "one document in, one page out" no-goal: rendering remains a single
document producing a single page; `--tree` only changes how links already
being rewritten in that one pass are classified — no multi-page
orchestration, navigation, or site scaffolding is added.

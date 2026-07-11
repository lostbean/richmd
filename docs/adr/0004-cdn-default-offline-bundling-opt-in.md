# Diagram runtimes default to CDN references; `--offline` bundles them

<a id="adr-0004"></a>

Mermaid and vega-lite diagrams render client-side in the reader's browser
(richmd's [grammar validators](../design/CONTEXT.md#term-grammar-validator)
only check syntax at build time; nothing pre-renders a picture, avoiding a
Puppeteer/headless-browser dependency entirely). That still leaves a choice:
how does the runtime JavaScript reach the page? We considered vendoring the
pinned library files alongside every rendered output by default, keeping the
HTML fully offline-viewable at the cost of an asset-copying step on every
render. We chose CDN `<script>` references as the default — the rendered
page stays small and simple to commit, matching how most rich web documents
already work — with a `--offline` flag that downloads and embeds the pinned
runtimes directly into the page when a consumer genuinely needs offline
viewing. This is a real trade-off surfaced deliberately: the default
[rendered page](../design/CONTEXT.md#term-rendered-page) requires network
access to display diagrams, and that limitation is named, not silent.

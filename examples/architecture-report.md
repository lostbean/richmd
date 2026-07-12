# Ingest Pipeline Architecture

How events move from client SDKs to queryable storage, and where each stage
can degrade gracefully under load.

::: {.toc max-depth="2"}
:::

## Overview

Four stages: an edge collector absorbs bursts, a durable queue decouples
producers from consumers, a stream processor validates and enriches, and a
columnar store serves reads. Each stage can be scaled and deployed
independently.

::: {.stat-grid cols="4"}
:::: {.stat-tile value="4" label="Ingest stages"}
::::

:::: {.stat-tile value="38ms" label="p99 edge latency"}
::::

:::: {.stat-tile value="72h" label="Queue retention"}
::::

:::: {.stat-tile value="4/4" label="Independent deploys"}
::::
:::

## Request flow

```{.mermaid title="Mermaid — flowchart"}
flowchart LR
  A[Client SDKs] --> B[Edge collector]
  B --> C[(Durable queue)]
  C --> D[Stream processor]
  D --> E[(Columnar store)]
  D -.enrich.-> F[Schema registry]
  E --> G[Query API]
```

## Components

::: {.cards cols="2"}

### Edge collector

Stateless, horizontally scaled. Validates payload signatures and shape
before anything is durable.

### Durable queue

Retains 72 hours of events, giving downstream stages room to recover from
an outage without data loss.

### Stream processor

Enriches events against the schema registry and de-duplicates by
idempotency key.

### Columnar store

Partitioned by day and tenant; serves the query API that dashboards and
this report's own charts read from.
:::

<details class="richmd-details">
<summary>Scaling knobs per stage</summary>

| Stage            | Scales by                   | Backpressure signal          |
| ---------------- | --------------------------- | ---------------------------- |
| Edge collector   | Request rate (HPA on CPU)   | 5xx rate to producers        |
| Durable queue    | Partition count             | Retention headroom < 20%     |
| Stream processor | Consumer group size         | Consumer lag (events behind) |
| Columnar store   | Shard count per tenant tier | Write latency p99            |

</details>

## Write sequence

Progressive depth — the flowchart above is the map; this sequence is the
detail for a single write.

```{.mermaid title="Mermaid — sequence"}
sequenceDiagram
  participant SDK as Client SDK
  participant EC as Edge collector
  participant Q as Durable queue
  participant SP as Stream processor
  SDK->>EC: POST /events (signed)
  EC->>EC: validate schema
  EC->>Q: enqueue(event)
  Q-->>EC: ack
  EC-->>SDK: 202 Accepted
  SP->>Q: poll batch
  Q-->>SP: events[]
  SP->>SP: enrich + dedupe
  SP->>SP: write to store
```

## Trust boundary

A hand-authored figure (not a diagramming library) for the one drawing
worth pixel control — where untrusted client input crosses into the
validated zone.

::: {.embedded-svg file="trust-boundary.svg"}
:::

_Every request is re-validated against the schema at the edge, regardless
of which SDK signed it._

## Failure modes

::: {.callout tint="warning" title="Queue saturation"}
If the durable queue exceeds 80% retention, the edge collector begins
sampling low-priority event types before dropping any high-priority ones.
:::

::: {.callout tint="danger" title="Schema validator down"}
Writes are rejected, not silently passed through unvalidated — a validator
outage is visible to producers immediately rather than corrupting the
store.
:::

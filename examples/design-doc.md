---
richmd-layout: narrow
---

# Notebook Sync: Offline-First Editing

A design proposal for letting notebook edits made offline reconcile safely
once the client reconnects, without a central lock or a rewrite of the sync
protocol.

::: {.toc}
:::

## Goals

::: {.labeled-block type="goal"}
**Offline durability**

Edits made with no connection are never lost, and become visible to other
clients within one sync cycle of reconnecting.
:::

::: {.labeled-block type="goal"}
**No central lock**

No notebook is ever exclusively checked out to one client — two people
editing offline is a supported, non-error case.
:::

::: {.labeled-block type="goal"}
**Bounded merge cost**

Reconciling a week of offline edits costs roughly the same as reconciling
one hour of them.
:::

## Non-goals

::: {.labeled-block type="no-goal"}
**Live cursors**

Real-time presence and collaborative cursors are a separate effort layered
on top of sync, not part of this proposal.
:::

::: {.labeled-block type="no-goal"}
**Cross-notebook moves**

Moving a block between two notebooks while both are edited offline is out
of scope; it degrades to a manual re-paste today and will stay that way.
:::

::: {.callout tint="warning" title="Scope check"}
Real-time collaborative cursors are out of scope for this iteration — see
non-goals above. Revisit once offline sync has shipped and stabilized.
:::

## Invariants

::: {.labeled-block type="invariant"}
**No silent drops**

A committed edit is never discarded without leaving a recoverable history
entry — see conflict resolver.
:::

::: {.labeled-block type="invariant"}
**Monotonic clocks**

A client's Lamport clock only moves forward; any regression is treated as
corruption, not a valid state.
:::

::: {.labeled-block type="invariant"}
**Idempotent replay**

Re-applying the same op twice is a no-op — required for at-least-once
delivery over flaky connections.
:::

::: {.callout tint="danger" title="Hard constraint"}
Any resolver change that can silently drop a committed edit is a launch
blocker, full stop — see [Conflict resolver](#conflict-resolver-1).
:::

## Principles

::: {.labeled-block type="principle"}
**Boring resolution**

Prefer last-writer-wins with recoverable history over cleverness that's
hard to reason about in an incident.
:::

::: {.labeled-block type="principle"}
**Field, not document**

Resolve conflicts at the smallest unit that has independent meaning to a
user — a field, not the whole note.
:::

::: {.labeled-block type="principle"}
**Fail loud, recover soft**

Corruption is rejected outright; ordinary conflicts always resolve to
something, never an error state a user has to unblock.
:::

## Component breakdown

Three cooperating pieces, each independently testable:

::: {.cards cols="3"}

### Op-log writer

Batches local mutations, assigns Lamport clocks, and persists them durably
before attempting to send.

### Sync engine

Streams queued ops when connectivity returns and applies incoming ops from
other clients in causal order.

### Conflict resolver

Applies the per-field resolution table and writes a history entry for
every overwritten value.
:::

### Sync engine

The sync engine batches local mutations into an append-only op-log and
ships them as soon as connectivity returns. Each op carries a Lamport clock
and the id of the last op it was based on:

```json
{
  "op": "set",
  "field": "title",
  "value": "Q3 planning",
  "clock": [7, "client-9f2"],
  "basedOn": [6, "client-9f2"]
}
```

<details class="richmd-details">
<summary>Why an op-log instead of a CRDT document</summary>
<section class="richmd-details-body">

A full CRDT gives stronger automatic merging, but every field in the
schema would need a CRDT-compatible encoding, and the team has no
operational experience running one at this scale. An op-log with a narrow
conflict resolver ships sooner and is easier to reason about in an
incident.

</section>
</details>

### Conflict resolver

Conflicts are resolved per-field, not per-document — two edits to
different fields of the same note never contend. Same-field conflicts fall
back to last-writer-wins by Lamport clock, with the loser preserved in a
recoverable history entry.

> "Last-writer-wins is the boring choice, and boring is correct here — the
> alternative is a merge UI nobody asked for." — from the design review

<details class="richmd-details">
<summary>Field-level resolution table</summary>
<section class="richmd-details-body">

| Field                | Strategy             | Notes                                                        |
| -------------------- | -------------------- | ------------------------------------------------------------ |
| title, tags          | Last-writer-wins     | Loser kept in history, recoverable for 30 days               |
| body blocks          | Per-block LWW        | Block insertion order merges via position key, not timestamp |
| checklist item state | OR-Set union         | Checking and unchecking never lose the other client's toggle |
| sharing permissions  | Server-authoritative | Never resolved client-side; requires a live round-trip       |

</section>
</details>

## Open risks

::: {.callout tint="info" title="Clock drift"}
Lamport clocks assume monotonic local counters; a client with a corrupted
counter could reorder history. Mitigation: counter is persisted with a
checksum and rejected on mismatch.
:::

## Rollout plan

Staged behind a flag: internal dogfood → 5% of free-tier notebooks → full
rollout, with the op-log kept dual-written to the legacy sync path for two
weeks as a rollback path.

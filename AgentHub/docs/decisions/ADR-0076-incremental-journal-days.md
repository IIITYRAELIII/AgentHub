# ADR-0076 — Incremental journal day projection

## Decision

Keep the existing journal SQLite owner, usage worker, canonical renderer and
revision fence. Record dirty completion timestamps transactionally with source
mutations. Re-render complete affected local-calendar days so task/subagent
grouping and day totals retain their existing semantics; replace their lazy
fragments, virtual rows and summary buckets atomically. Preserve all other days.

A successful projection clears the dirty set inside the same revision-guarded
transaction. A conflict cannot acknowledge a newer turn or discard pending work.
Moving/deleting a record dirties its old day as well. Completion at midnight is
interpreted with the same local calendar as the renderer. Changes in the default
open day include the previous and new day.

The worker caches normalized accounting scalars by exact record identity and
changed revision. An indexed identity/revision scan observes updates and
deletions from every connection. Source content is read and normalized only on
cache miss, before content fields are omitted. The cache is disposable and never
written back as source; cold restart reconstructs it. Normalization-dependent
legacy compactions and image estimates remain covered by full-projection parity.

The account panel still runs the canonical rolling-window calculation over
scalar records and synchronized facts. There is no new pricing or attribution
owner. Scope/version changes and an existing Thread's workspace rebind trigger
one full rebuild; normal edits thereafter use dirty days.

## Evidence and limits

Focused tests compare every stored day, turn, summary and index against a fresh
canonical full projection after correction, date movement, deletion, restart,
revision conflict, scope change and workspace rebind. Body-only corrections
invalidate the index version even when visible headings remain unchanged.

A read-only production backup with 16,271 records and 43,897 facts produced exact
full/incremental parity. A changed day with four records took about 1.99 s; the
busiest retained day (535 records) took about 2.14 s. Each read one changed
accounting record. Full comparison runs took about 11.6 s; cold initialization is
still expensive. These are isolated-copy measurements, not live-client latency
or a bound for an arbitrarily large single day.

No canonical record/fact schema or identity is rewritten. Older runtimes ignore
the additive dirty table/triggers; a later compatible projection can rebuild.

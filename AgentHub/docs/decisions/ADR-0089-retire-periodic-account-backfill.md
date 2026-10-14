# ADR-0089 — Remove the periodic ambient account writer

## Decision

UsageSyncAutoService no longer accepts or invokes the legacy accountBackfill
callback. Production composition stops injecting it. The regular sync uses the
existing usage fact/auth-observation worker and journal transaction owners;
no full journal copy, historical attribution scan or backup prune precedes push.

The explicit legacy migration CLI and its recovery receipts are preserved.
They are not called automatically. Existing copies are cleaned only under a
separately reviewed explicit selection, with three usable newest copies and
all known recovery/pins preserved. This is not an automatic legacy-file prune.

## Evidence and cause

The installed owner scans all journal JSON and account timeline rows, then runs
DatabaseSync VACUUM INTO on the main thread when it changes any record. Across
two immutable pre-update snapshots, 29 existing records alternate inferred and
unknown account attribution; all involve context-compaction. The published
canonical projection deliberately clears service usage account identity while
the legacy nearest-timeline writer assigns one again. Fresh facts can also
cause updates; not every snapshot is attributed to this alternating behavior.

Removing the competing writer preserves canonical attribution rather than
moving an obsolete full-copy operation into another queue. Existing SQLite
transactions/WAL continue to own rollback/crash recovery. No new backup,
process, retry, queue, state store or attribution authority is introduced.

## Measurement and limits

Existing command trace spans measure auto-sync config/state/snapshot/push/pull,
durable cursor updates, import/projection and repair under one coalesced sync ID.
Started and terminal markers use the existing trace owner, with numeric counts
only. A dropped/failed trace never changes sync results.

Before/after comparisons use isolated SQLite/FS fixtures with a main-loop
heartbeat; production log counts and cumulative health counters are separate
evidence. Without installed per-operation spans, production stall durations
cannot be assigned to this owner. Source changes require canonical delivery;
one-off disk cleanup does not establish that production auto-sync is fixed.

Contracts: USG-001, PERF-001. Message/lifecycle identities remain unchanged.

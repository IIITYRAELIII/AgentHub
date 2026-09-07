# PERF-001 — Local command latency

## Trace contract

The root trace identity is the command ID. Required stages are client submit,
transport start, Hub HTTP callback or Desktop IPC accept, authenticated control
handler enter, receipt lock wait, durable intake enqueue/start/commit, response
send, client ACK, dispatch, admission, provider RPC/accept, first
event/content/visible, terminal commit and projection visibility.

Cross-process timestamps use UTC epoch; durations inside one process use a
monotonic clock. Every blocking span reports outcome, queue depth and relevant
lock or SQLite wait.

## Initial local SLO

- Durable ACK without attachments: p50 <= 75 ms, p95 <= 250 ms, p99 <= 1 s.
- Intake writer start to commit: p95 <= 100 ms, p99 <= 500 ms.
- Idle committed command to dispatch: p95 <= 250 ms, p99 <= 1 s.
- Durable ACK to local projection visibility: p95 <= 1 s, p99 <= 3 s.
- Correctness: no duplicate effect on same-ID retry and no lost ACKed command.

When a ready VS Code direct HTTP transport does not confirm `send-message`
within 250 ms, the WebView starts the authenticated IPC path with the same
`clientUserMessageId`. The first successful receipt wins; the durable message
ledger must collapse the other transport into the same command effect.

Background history hydration may use at most two concurrent HTTP requests per
client. User commands, snapshots and attachment reads do not enter that queue.
The VS Code WebView does not open a direct `/events` stream: journal changes are
already delivered by the extension subscription, so a retained panel cannot
consume a long-lived Chromium HTTP socket for duplicate notifications.

Provider transcript maintenance does not run on the command, snapshot or task
catalog critical path. Active append-only transcripts are never historically
rescanned. Historical full scans are bounded to 16 MiB; larger transcripts use
managed terminal accounting and an explicit skipped-audit warning instead of
unbounded worker memory and event-loop GC pressure.

Provider turn start and completion do not snapshot Git repositories. The only
release Git snapshot occurs when a Task explicitly moves to `Await`, outside
provider admission and terminal-delivery latency.

Codex rollout activity fallback runs outside the main Hub event loop. Concurrent
reads of the same rollout and read options share one in-flight operation. A cold
fallback physically reads/projects at most the latest 16 MiB plus two bounded
256 KiB provenance samples; it never streams the intervening prefix to EOF.
Provenance requires exactly one valid canonical session record in those samples;
otherwise unkeyed provider users fail closed. Append-only reads resume from the
cached raw-byte cursor.
Exact App Server state and managed run identity remain preferred over JSONL
fallback; reducing the projection window must not truncate the terminal answer
retained by TURN-001.

Codex `thread/read` coalescing is single-flight only: a completed read retains no
Thread payload in Hub memory. Rollout session discovery incrementally parses at
most 1 MiB, 4,096 lines, 256 KiB per line and one second per file; damaged,
newline-free and stalled inputs return no session instead of exhausting heap or
failing the process. Discovery retains at most 128 parsed sessions and 32 MiB,
prunes them when files disappear, retries incomplete files only through the same
strict bounds, and passes valid sessions to the existing durable historical
byte-offset/checkpoint queue.

Claude external-owner discovery enumerates Windows processes through one
runtime-scoped snapshot owner, not one helper per session. Concurrent occupancy
queries share a scan for five seconds. Launch-authority scans bypass a cached
negative and serialize after any earlier inventory so each admission receives a
scan requested at its own dequeue fence. Helper stdout plus stderr is capped at
64 KiB and the child is terminated on timeout or overflow.

Ordinary Codex terminal reconciliation is also resumable and bounded. One idle
pass scans at most 8 rollout files, 512 KiB and 20 terminal turns, with a 75 ms
event-loop time budget. It yields before further work whenever a managed run or
deferred input exists. A partial scan persists its exact file position and
terminal index before journal projection, so restart/retry continues the same
batch without replaying the completed prefix. Projection is flushed at most once
per recovered batch; disabling terminal audit is not an acceptable steady-state
mitigation.
When the Codex transport is offline or reconnecting, versioned historical
maintenance resolves subagent accounting roots only from retained rollout files.
It must not attempt provider RPC before falling back locally; an unavailable or
ambiguous local parent leaves the bounded durable checkpoint pending for retry.

Periodic usage synchronization must not rebuild the complete journal projection
on the Hub event loop. Import, merge and account-panel calculation execute in a
dedicated worker. A remote usage delta updates only the account-usage panel in
the existing lazy journal index through a revision-guarded index write; an
unchanged snapshot performs no projection. Persisted day and turn fragments
remain authoritative and are preserved intact.

The usage export cursor is the indexed durable per-row `changed_revision`
journal revision. Snapshot capture first fixes an upper journal revision, then
parses only rows in `(acknowledgedRevision, snapshotRevision]`; a later insert or
update remains visible even when its `observedAt` shares or predates the prior
millisecond watermark. Upgrades without a revision cursor perform one full
export before persisting the new cursor. The legacy timestamp fallback replays
the acknowledged millisecond and relies on exact event-id merge rather than
dropping equal-timestamp rows.
Exact-turn and bounded Thread reads use SQLite primary/index queries and do not
materialize the complete ledger after durable point-read readiness is known.
The first read imports and normalizes legacy JSON only when it is newly imported
or its persisted ledger version is old; migrated SQLite performs only bounded
status and point queries. Any compatibility normalization releases its in-memory
ledger before returning, so `retainedRecords` remains zero after the read.

Legacy terminal identity recovery lists persisted metadata for at most the
newest 200 terminal rows in deterministic newest-first order from the covering
`provider_turn_terminals_recovery_idx`, without selecting payload text,
computing JSON length or building a temporary sort. The terminal-store owner
persists exact UTF-8 `payload_bytes` on every new revision and migrates at most
the newest 200 legacy rows from a capped 2 MiB-plus-one-character sample before
publishing the index. Recovery fetches one exact row at a time, accepts only rows
whose persisted byte length is at most 2 MiB, reads at most 8 MiB of candidate
payloads, and admits at
most 4 MiB of valid JSON objects. Invalid JSON consumes the inspection budget
but not the admission budget, so a malformed newest row cannot by itself starve
a valid older candidate. Rows that do not fit either hard aggregate bound are
skipped fail-closed: they cannot rewrite message identities and remain available
to their owning terminal store. No SQL window, payload-length expression or
temporary result materializes/sorts the payloads for all 200 candidates.

Runtime durability saves coalesce pending requests before snapshot capture while
preserving each caller's persistence fence. After the durable command ledger has
projected a snapshot, exact ledger-owned pending inputs, queued inputs and
receipts are omitted from raw `runtime_state` JSON and overlaid from the ledger
on read; non-ledger records remain in the snapshot. A failed writer revision
rejects only its covered waiters and must not poison a later save.

Periodic Test Contour journal comparison and full Mini App journal publication
must not scan, materialize, stringify or compress the journal on the Hub event
loop. Test Contour comparison runs in an isolated worker. Production journal
publication reads one SQLite snapshot and performs JSON encoding plus gzip in an
isolated worker; compression favors bounded CPU over the smallest possible
artifact. Synchronous SQLite stores on the Hub loop reuse initialized handles,
batch hierarchy metadata reads and use immediate `SQLITE_BUSY` failure with
asynchronous retry rather than blocking busy waits. Mutation retries are
deadline-bounded, yield through timers between attempts and retain the original
idempotency identity. Exhaustion is a visible contention failure; it must not
freeze HTTP, SSE or runtime timers or allocate a replacement request identity.

Unchanged journal HTTP/WebView reads resolve their ETag from content-free SQLite
metadata and do not load the multi-megabyte index HTML. The initial Journal
payload contains only the account panel, day-total shells and a compact,
materialized resource summary; it contains no turn shells, prompts or answers.
Every grouping mode derives its collapsed totals from that summary and never
hydrates day fragments merely to regroup them. Expanding a scope reads at most
50 turn shells from the SQLite turn index by exact Workspace, Stream, provider
and completion-range fields; expanding one turn then reads only its exact durable
fragment. Summary and turn index replace atomically with the journal projection,
while an index-only account-panel update preserves both. The compatibility day
fragments perform one SQLite transaction covering schema DDL, column changes,
data/index projection and schema-version publication; any failure leaves the
reopened store wholly on the prior schema. A turn-page request validates its
expected source version and reads the bounded index page in one SQLite snapshot,
returning the version actually read rather than mixing revisions. The migration
changes the ETag. The compatibility day collection endpoint remains capped at 20
fragments per page. Journal DOM
insertion is excluded from body-wide themed-select and VS Code motion subtree
scans. Periodic external history refresh runs only while chat is visible, and
unchanged Dashboard collections retain their snapshot identity so they do not
incur stringify comparison or card rebuild.

Public Worker publication materializes an immutable versioned Journal layout
before atomically advancing its manifest. Compact index HTML, resource summary,
aggregate profile cohorts, exact per-Stream and per-Workspace aggregates, exact
fragments and Workspace/Stream/provider-scoped ordinal turn keys are stored
separately. Flat Workspace and nested Stream reads use the same bounded index
path. A lazy turn-page read resolves at most 50 scoped index keys and their exact
shells; profile reads add only the bounded peer cohort and the requested
Stream's or Workspace's exact aggregate, without hydrating peer turn details.
They never decompress the publication snapshot, list a complete generation or
filter all persisted turns. The immediately
previous generation remains readable across manifest cutover, while older
generation cleanup runs only on publication. A legacy snapshot without this
layout may serve compact index and exact-fragment compatibility reads, but lazy
turn paging fails closed until the next normal publication materializes it.


The “Local Hub” health RTT is not message ACK latency and must not be presented
as such. Provider latency and remote Worker latency are separate indicators.

## Navigation responsiveness

Switching between Chat, Dashboard and Journal exposes the target shell before
optional data hydration completes. On production-shaped data the input-to-first-
paint p95 is at most 200 ms and no navigation-owned main-thread task exceeds
50 ms. A hidden startup screen owns no animation frame; its canvas animation is
scheduled only while that screen is visible. The shared invariant applies to
the browser shell and the VS Code WebView, which execute the same client assets.

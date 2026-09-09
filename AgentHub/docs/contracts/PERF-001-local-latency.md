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

## Unified performance evidence

Client interactions, navigation, control ACKs, request and rendering durations,
long main-thread tasks, startup, terminal-outbox phases and existing runtime
health/SQLite counters use the same `command-traces.sqlite` worker owner.
Client measurements never become admission or lifecycle authority. New client
telemetry accepts bounded batches with allowlisted content-free fields through
the existing authenticated transport; it cannot persist message bodies, DOM
text, request URLs or arbitrary error text. Telemetry requests do not trace
themselves. Backpressure drops diagnostics, never application commands.

A blocking operation records a started marker before awaiting and a terminal
measurement with the same `operationSpanId`. Missing terminal measurements are
incomplete evidence, not proof of a running task: retention, process death or
telemetry loss may remove either end. Instance/release identity accompanies
server records. UTC timestamps correlate processes; only monotonic same-process
durations measure latency. Existing runtime-health event-loop percentiles remain
cumulative for that process and are labelled separately from request durations.

Retention is at most seven days and 250,000 spans. The existing worker prunes at
startup, on writes and at most once per minute while idle. Limit maintenance
does not walk 250,000 rows for every inserted span. Reports disclose actual
retained range and file sizes; the row limit may shorten the seven-day window.
The WAL journal-size setting applies after checkpoint and is not a hard disk cap.

Optional startup catalog/pricing enrichment starts after readiness and uses the
existing bounded provider/usage owners. It must not block control readiness or
change completed provider/admission states. Its progress and failure remain
visible separately from mandatory recovery. See ADR-0030.

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
An explicit operator repair of legacy subagent authors may locate the exact
completed-turn start outside this tail and read from there in a worker, with
64 KiB chunks and a 4 MiB record cap. It is not an activity fallback, automatic
refresh or startup scan. Only requested completed turns (at most 20, 1,000 source
occurrences) are eligible; no provider operation is issued. This temporary
migration exception is removed with the legacy author repair (UI-001).
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

Ordinary Codex terminal reconciliation is also resumable and bounded. One
pass considers at most 8 scanned rollout files and 20 terminal turns. Production
scans run in a worker, in 4 MiB chunks with an 8 MiB pass budget (a JSONL record
is completed before yielding). The 75 ms cooperative processing budget cannot
be consumed by discovery or worker scanning before reconciliation, or prevent
the first bounded unit from advancing. Live accounting remains scheduled during managed runs
and while deferred inputs exist; only historical backfill requires interactive
idle. A paused queue must not starve completed-turn accounting. A partial scan persists its exact file position and
terminal index before journal projection, so restart/retry continues the same
batch without replaying the completed prefix. Projection is flushed at most once
per recovered batch; disabling terminal audit is not an acceptable steady-state
mitigation.
Incomplete passes that make progress continue after one second; idle or failed
passes retain the 30-second interval. Durable fair continuation prevents a slow
thread or a long discovery prefix from permanently starving later threads.
Automatic terminal writes use point reads/upserts, not a reload of the complete
ledger. Production full journal projection reads, normalizes, renders and writes
the retained ledger in the existing usage worker. Only bounded workspace identity
batches cross back to the runtime; full journal bodies do not. Projection commits
are revision-fenced, and a failed or stale batch cannot clear pending audit work.
Terminal-outbox recovery likewise stages bounded batches before requesting a
shared journal projection. It must not rebuild the entire retained journal for
each recovered completion. Exact revisions are acknowledged only after the
shared projection succeeds; live completion adds no batching delay.
Unchanged canonical merged records do not request a new projection; an existing
pending projection still survives an unchanged replay. Provisional retraction
checks only the exact turn before mutation. Missing or non-provisional turns
must neither load the retained ledger nor project it. An actual retraction is
serialized and durable before its worker projection.
Task-title reconciliation performs metadata selection and exact changed-record
updates in the usage worker. A revision conflict cannot overwrite newer usage
or answers. The durable projection-source revision and project scope distinguish
an unchanged, already-visible title from an update whose projection must retry.
The runtime releases its repository lock before requesting full projection.
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

Runtime read markers, restart transitions, Telegram bindings, task history,
message pins, provider telemetry and durable command receipts use the same
asynchronous SQLite contention policy as runtime snapshots and usage/limit
writers. The retry boundary contains only synchronous database work; provider
calls, Telegram delivery, filesystem preparation and other queue owners stay
outside it. Each owning operation retains its ordering scope. No global Hub
business-operation FIFO or artificial pre-write delay is introduced.

History mutations return a persistence promise and capture their submitted
history before waiting. Their process-local committed revision invalidates
snapshot caches, including derived pin availability; it is not a durable command
or CAS identity. Initialized pin snapshots are read-only. Optional telemetry
indexing starts after durable history without delaying its successful result;
index failure is reported separately and telemetry remains in that history.

Queue diagnostics distinguish time before dequeue, execution including SQLite
retry, total duration, depth and oldest pending age using a monotonic clock.
The contention budget starts at dequeue. A drain fence is not a success receipt:
the caller must observe its individual write result. These queues live in memory;
accepted-message and terminal recovery continue to rely on their existing
durable ledgers/outboxes. A bounded SQL retry does not establish durability by
itself and cannot justify replaying an unknown external effect.

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

A lazy Journal version conflict supersedes that read. The client requests at
most one refresh per displayed version through the existing refresh owner,
restores open scopes, and restarts their paging from offset zero. Responses from
a superseded version or render generation cannot mutate the current DOM or
trigger another refresh. Expected version conflicts are not transport-error
notifications; actual read failures remain visible.

Public Worker publication materializes an immutable versioned Journal layout
before atomically advancing its manifest. Compact index HTML, resource summary,
aggregate profile cohorts, exact per-Stream and per-Workspace aggregates, exact
fragments and Workspace/Stream/provider-scoped ordinal turn keys are stored
separately. Flat Workspace and nested Stream reads use the same bounded index
path. Temporal Worker reads select exact canonical visible-date keys supplied by
the grouping projection; local UTC offsets never widen a request to adjacent
whole UTC-day buckets. Changes to persisted index-key semantics advance the
layout version: older layouts fail closed for lazy pages and are atomically
rematerialized even when the logical content sync id is unchanged. A lazy turn-page read resolves at most 50 scoped index
keys and their exact shells; profile reads add only the bounded peer cohort and the requested
Stream's or Workspace's exact aggregate, without hydrating peer turn details.
They never decompress the publication snapshot, list a complete generation or
filter all persisted turns. The immediately
previous generation remains readable across manifest cutover, while older
generation cleanup runs only on publication. A legacy snapshot without this
layout may serve compact index and exact-fragment compatibility reads, but lazy
turn paging fails closed until the next normal publication materializes it.


The “Local Hub” health RTT is not message ACK latency and must not be presented
as such. Provider latency and remote Worker latency are separate indicators.

Maintenance-operation point reads initialize their schema once per store;
subsequent reads are SELECT-only and remain available while another WAL writer
holds its transaction. Compaction persistence queues are scoped to their Thread,
so a busy transition does not serialize unrelated Thread processing.

## Navigation responsiveness

Message reconciliation identifies legacy turn-root candidates in one pass over
the retained history. It does not copy and rescan every earlier message for each
user item. The temporary identity fallback retains UI-001's exact provider,
Thread, turn, first-user and explicit-steer semantics; optimizing the traversal
must not broaden which outgoing command can own a historical occurrence.

Switching between Chat, Dashboard and Journal exposes the target shell before
optional data hydration completes. On production-shaped data the input-to-first-
paint p95 is at most 200 ms and no navigation-owned main-thread task exceeds
50 ms. A hidden startup screen owns no animation frame; its canvas animation is
scheduled only while that screen is visible. The shared invariant applies to
the browser shell and the VS Code WebView, which execute the same client assets.

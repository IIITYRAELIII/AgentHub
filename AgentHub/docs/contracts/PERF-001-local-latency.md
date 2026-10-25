# PERF-001 — Local command latency

## Isolated Windows test-root cleanup

ADR-HUB-314-owned-windows-cleanup permits the existing isolated test owner to
use Node's bounded recursive-removal retries (three, 100ms linear delay) on its
own minted Windows temporary root after command close. Execution and assertions
are never retried. Actual removal is required before successful checkpoint;
persistent cleanup failure still fails and retains both original errors.
This is not a claim that any historical BITS/Edge holder has been identified.

## Bounded background storage work

Policy v1 admits at most three artifact units per pass and checks a cooperative
20-second budget between units, with bounded metadata/head lists/file size and
persisted discovery progress. It does not abandon an in-flight destructive child
or claim that hashing a large admitted transport has a hard 20-second deadline.
Owner discovery reads a flat artifact directory; no per-turn recursive scan of
archives, history or user work is introduced. Runtime health exposes cached
status only. Filesystem free-space observations remain distinct from logical
byte counts and can include concurrent allocations. See ADR-0126.

Policy v2 runtime-body batches remove at most 64 files/256 MiB and check a
cooperative ten-second deletion budget after bounded metadata preflight. Asset
bytes are hashed only for the admitted batch, through retained deletion handles;
there is no repeated whole-body hash before every batch. The original partial
operation remains pending between batches, and shutdown drains its actual child.
The shared installation lease is scoped to the physical runtime root, outside
ordinary provider/message admission. Install no longer sweeps prepared bodies.

Repeated journal projection may reuse a verified rendering only within the
existing usage worker lifetime. Its bounded scalar receipt is not source
authority: the current SQLite journal revision/index, clean dirty set, exact
scope/version/device settings, freshly resolved Workspace bindings, freshly read
account catalog and generation-fenced facts revision must still match. Workspace
resolution and unknown-Thread assignment are never skipped. A single SQLite
read snapshot rechecks journal/facts/dirty and pricing/image markers after
asynchronous callbacks, both when consuming and establishing a reuse receipt.
Marker drift requires a canonical full rebuild with the original revision CAS;
pre-callback version observations never authorize reuse.
Rolling-window future-record/24h boundaries and local midnight expire reuse;
backward or invalid clocks fail closed. Restart, a failed/stale render and changed
inputs reconstruct through the canonical renderer and existing revision CAS.
The receipt retains hashes/scalars only, not another HTML or facts cache.
Matching facts are checked through their indexed revision/generation metadata;
no facts are hydrated on this path, including when the existing facts payload
cache declined retention at its byte limit. A miss still uses that bounded cache
and the canonical renderer. Content-free retained byte/count scalars are not
payloads and do not widen its retention limit.
Content-free reuse-check/window and render measurements distinguish eliminated
render work from preserved ledger reads, callbacks and queue waits. A no-dirty
result alone never establishes unchanged projection inputs.

## Bounded Codex trace and fact projections

Codex rollout preview retains at most 256 groups, 128 activities per group,
1,024 activities per turn and one million reasoning characters in aggregate;
an individual retained reasoning block is never cut. Earlier omitted groups or
activities are explicit projection metadata, not deletion from the transcript.
Append copies only the groups it mutates. Serialized rollout-cache budgets are
32 MiB ordinary and 16 MiB active; these are not total process-heap limits.
Desktop paged history clones only each selected cached turn.

Explicit “All stages” reads use the existing history owner and rollout worker,
without provider calls, history writes or automatic polling. They stream a fixed
source prefix in 64 KiB chunks, cap a record at 4 MiB and return at most 50 groups
and 512 KiB per page. An oversized block fails visibly, without truncation.
Canonical source generation, prefix byte length and SHA-256 bind subsequent
pages; append does not shift that snapshot, and changed prefixes fail closed.
The browser retains only the displayed page. This is an explicit detail-read
exception to the automatic 16 MiB tail policy: each page scans its fixed prefix,
so time is proportional to source size, not promised constant time (ADR-0077).

The usage worker's disposable fact cache holds at most 32 MiB of serialized
facts. SQLite insert/update/delete triggers on all three fact tables maintain
its revision. Revision and facts are read in one SQLite snapshot; external
writes invalidate the next read, rollbacks do not, and restart reconstructs it.
Oversized projections use uncached reads. Pricing, attribution, projection CAS,
terminal/outbox durability and full scalar aggregation retain their owners.

## Trace contract

Task-card Git previews run only on explicit request and retain at most 64 KiB of
diff text per response, with visible truncation. Board snapshots never run Git
for previews. Task journal projection joins exact bindings to indexed journal
identities and reads summary scalars, not full prompts, bodies or stored diffs.
The journal revision participates in Task-board cache invalidation (ADR-0051).

The shared UI requests a board-only response for Dashboard move/status mutations.
The owner still awaits durable mutation/lifecycle completion, then returns the
authoritative board tasks, workspaces and layout without waiting for conversation,
telemetry or server-health snapshots. Clients preserve unrelated chat/receipt
state and invalidate changed collection delta baselines. Clients without the
opt-in retain the full snapshot response during rolling deployment.
Pending feedback is not mutation success and cannot move a card authoritatively.
Local Task-reference drops and clipboard preparation do not await remote reads.
Native Task drag preparation and Task-reference drops into chat/composer record
content-free interaction spans; the drop also measures the next paint. The
composer accepts the same Task reference transfer as the chat history pane,
without initiating a send or changing the command identity.

The root trace identity is the command ID. Required stages are client submit,
transport start, Hub HTTP callback or Desktop IPC accept, authenticated control
handler enter, receipt lock wait, durable intake enqueue/start/commit, response
send, client ACK, dispatch, admission, provider RPC/accept, first
event/content/visible, terminal commit and projection visibility.

Cross-process timestamps use UTC epoch; durations inside one process use a
monotonic clock. Every blocking span reports outcome, queue depth and relevant
lock or SQLite wait.

Managed-run admission reports content-free child spans for provider preparation,
Task-diff persistence, detached task-sync enqueue and runtime-state persistence.
The task-sync span covers only its synchronous enqueue boundary; diagnostics do
not add an await or change launch ordering. An unchanged most-recent Task diff
shares the already scheduled durable write instead of serializing and fsyncing
the complete bounded cache again. A changed value or eviction-order change is
still persisted, and a failed write remains retryable with the same content.

Admission resets an absent or already-empty diff without promoting an empty
cache entry or evicting another Stream's diff. This reset still awaits the
existing write fence and persists any dirty remembered updates; a real stale
diff is cleared durably. Ordinary cache set/eviction ordering is unchanged.
The existing restart drain flushes remembered diffs. Persistence errors propagate
through admission instead of becoming successful diagnostics.
Content-free child spans retain the original command ID through diff encoding,
queue wait, open/write/fsync/rename, settlement and an unchanged persistence
fence; eligibility and the pre-dispatch durable save have separate spans.
These elapsed spans do not classify filesystem or callback wait as CPU work.

## Unified performance evidence

Explicitly traced snapshot GETs carry their existing client trace ID to the
HTTP owner; diagnostic health/static probes may supply the same bounded
`clientTraceId` query field. The response echoes only that identity. Existing
trace records separate route/read waiting, synchronous JSON encoding, response
finish and disconnect, with no URL or payload retention. Thread CPU and loop
active/idle deltas over an asynchronous span describe the shared window, not
exclusive CPU attribution to that request. Synchronous encode deltas cover that
specific operation. No pre-callback network queue duration is invented.

The existing runtime health sampling tick may take one internal CPU sample per
process when its measured event-loop p95 reaches two seconds. It opens no TCP
debugger endpoint and executes no debugger evaluation. Sampling targets fifteen
seconds at a ten-millisecond interval; a delayed stop callback is reported as
timer overrun rather than a hard deadline. Shutdown stops and drains that sample
before closing the existing trace worker. Only twenty bounded code-location
stacks and counters are retained through that worker; raw profiles, source text,
values, absolute paths and unknown external function names are discarded.
Failure is diagnostic-only and does not retry or change application outcomes.
This temporary owning-operator diagnostic is removable once the common runtime
stall is localized and its corrected production path has verified AFTER evidence;
it is not itself a latency fix or a new event-loop monitor.

Restart readiness checkpoints use the original restart operation ID and bounded
content-free blocker run IDs/counts, pending-admission state and request time.
Changed observations distinguish waiting from ready/cutover; unchanged repeated
checks do not flood traces. Existing command IDs retain durable intake, dispatch
and provider-acceptance timings. These observations neither close admission nor
attribute inclusive waiting time to CPU/network work. Sink failure cannot change
restart or message delivery, and source/fixture timings are not live latency proof.

Runtime snapshot projection and compaction resolve only their referenced command
IDs through the existing ledger. They do not hydrate unrelated active or hot
terminal records before filtering. Full startup/reconnect overlay remains a
canonical recovery read. This eliminates unnecessary enumeration, not mandatory
run persistence or its error/recovery fence. Original-command measurements must
still distinguish snapshot encoding, worker/queue waits and durable writes; a
file size or inclusive wall duration alone does not identify CPU or fsync cost.

Local submission, durable Hub acceptance, preparation/queueing and exact provider
acceptance are distinct visible boundaries. Rendering a durable ACK does not
wait for full snapshot/history synchronization. A preparing run may own admission
and cancellation without being labelled a running provider. First text and usage
enrichment are not prerequisites for displaying an accepted provider turn.

Client interactions, navigation, control ACKs, request and rendering durations,
long main-thread tasks, startup, terminal-outbox phases and existing runtime
health/SQLite counters use the same `command-traces.sqlite` worker owner.
Client measurements never become admission or lifecycle authority. New client
telemetry accepts bounded batches with allowlisted content-free fields through
the existing authenticated transport; it cannot persist message bodies, DOM
text, request URLs or arbitrary error text. Telemetry requests do not trace
themselves. Backpressure drops diagnostics, never application commands.
For the public Worker upload transport, the local SQLite worker is not in the
request path: attachment-only failure spans use a separate authenticated,
bounded Journal Durable Object trace owner. A 24-hour browser cache retries
those spans after endpoint loss without changing upload or command outcomes.
The Worker trace is queried by exact upload ID and is not merged into local
runtime health statistics. See MSG-002 and ADR-0083.

Selected-Stream visibility diagnostics retain the original snapshot request
identity across the server's bounded run-source/gate observation, the client's
accepted or rejected snapshot decision, and its later rendered viewport state.
The client records only document identity and predecessor, selected provider,
Thread, Stream, turn and command IDs, run/provider-start presence, exact final
revision, model-link state, and whether the live card is in view, offscreen or
absent. A code marker identifies a loaded client path only when release evidence
maps it to one reviewed immutable asset digest; a server release ID alone is
not evidence of client bytes. A missing trace can mean a page close, failed
transport or diagnostic backpressure, not an idle provider.

A blocking operation records a started marker before awaiting and a terminal
measurement with the same `operationSpanId`. Missing terminal measurements are
incomplete evidence, not proof of a running task: retention, process death or
telemetry loss may remove either end. Instance/release identity accompanies
server records. UTC timestamps correlate processes; only monotonic same-process
durations measure latency. Existing runtime-health event-loop percentiles remain
cumulative for that process and are labelled separately from request durations.
Client operation pairs retain that same identity through authenticated batch
ingestion. HTTP measurements end when response headers arrive and classify HTTP
errors without changing the response; complete action-handler spans include
the subsequent awaited processing. Aborted requests and paint measurements
cancelled by a hidden surface have explicit diagnostic outcomes. They never
claim that a Hub command was cancelled or that hidden content became visible.
For a materialized terminal history page carrying an exact root-user
`clientUserMessageId`, `history-retrieved` and `history-terminal-paint` join the
existing server `terminal-history` span under that original command identity.
Only bounded Stream/provider/Thread/turn identity and terminal revision pass the
client telemetry allowlist. Retrieval is not paint; paint is recorded only for
the selected visible chat after the exact terminal message has been rendered,
using the existing two-frame paint opportunity (not a compositor guarantee).
At completion it revalidates the existing navigation generation, selected chat,
route, materialized page and exact connected visible terminal/revision. Stream,
view, historical navigation or revision supersession cancels the paired
diagnostic with `failureKind=superseded`, never claiming an old successful paint.
Unknown original identity emits no invented command correlation. UTC endpoints
permit cross-process correlation with clock-skew limitations; the client render
duration remains monotonic. No history polling or delivery authority is added.
Configuration and infrastructure construction precede the trace worker. Their
monotonic durations and original UTC endpoints are captured before the work and
submitted to that same worker once it exists, marked `bufferedUntilTraceReady`.
A process failure before trace initialization cannot leave these records; the
startup error log remains the evidence for that boundary.

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

Large Mini App JSON responses use asynchronous gzip so snapshot compression
cannot block local command admission on the Hub event loop. At most two
compressions run concurrently; excess responses use the valid uncompressed
representation rather than retaining a queue of complete snapshot bodies.
Aborted responses are not written after compression finishes, and compression
failure falls back to the unchanged JSON body without a false gzip header.

Provider transcript maintenance does not run on the command, snapshot or task
catalog critical path. Active append-only transcripts are never historically
rescanned. Historical full scans are bounded to 16 MiB; larger transcripts use
managed terminal accounting and an explicit skipped-audit warning instead of
unbounded worker memory and event-loop GC pressure.

Provider turn start and completion do not snapshot Git repositories. Test owns
the Task Git snapshot and `dev` integration outside provider admission and
terminal-delivery latency. Await prepares PreRelease before committing acceptance
under the existing Workspace Await and Task ownership boundaries. A failed
preparation leaves the Task in Test (ADR-0055). It does not run release tests,
builds or deployment. Active release generations never delay later Task work or
Await acceptance.

`hub_release_run` measures and persists only bounded admission before returning
its ACK. Candidate composition, validation, Git/network publication, deployment
and finalization run after the response under the durable operation owner. Short
SQLite and identity CAS sections do not enclose tests, child processes, network
requests or repository publication. Queue/lease time, stage duration, retries,
waiting reason and per-target effect are separate measurements; transport timeout
is not operation latency and cannot create a second operation.

Release validation admits independent files against a target of 40% of total
machine CPU capacity and 40% of physical RAM for the whole test process tree,
including Git, browsers and helpers. Other applications reduce available
headroom. Admission uses measured CPU and resident memory plus reservations for
new, not-yet-sampled work; there is no fixed file/worker ceiling. This is a
cooperative budget, not an OS throttle: indivisible running tests can overshoot
and are never killed, suspended or retried merely for doing so. Measurements
report overshoots. Accounting failure stops new admission and drains started
tests with their original outcomes/checkpoints.

Native-Git correctness scenarios do not assert a total wall-clock
latency SLO over fixture creation plus several independently bounded operations.
Their aggregate Node-case and nested whole-scenario stopwatches are removed;
actual command, lease, readiness and explicitly timed behavior bounds remain.
All original behavioral assertions still execute, and historical cancellations
remain failures. This policy applies to the whole native-Git correctness
family, including newly added cases; it is not a list of scenarios that
already timed out. Explicitly timed behavior keeps its actual polling,
protocol and operation assertions. See ADR-HUB-314-native-correctness-stopwatches.

Every file receives a separate process and disposable temp/home/state root.
The runner observes child `close` before removing that root. A cleanup failure
remains a failure and retains its OS code, phase and owned path; when execution
also failed, both original errors remain available without replaying the test.
The existing per-file timing event reports bounded failure codes, execution versus
cleanup phase, owned temporary paths and the original Node child spawn/exit/close
observations as soon as that file settles, before remaining files finish. It excludes
arguments, environment values, output and arbitrary error text; truncated paths
are explicitly marked and are not exact identities for holder queries.
Native process-guard fixtures revoke only after the real descendant is ready;
their controlled late mutation and child-close receipts replace elapsed sleeps
as fixture readiness and cleanup evidence. Guard, lease and recovery assertions
remain authoritative.
Local-control E2E failure diagnostics use the checkout's ignored WIP artifact
area outside that disposable root. Bounded redacted process output, generation
timestamps, control-attempt outcomes and existing startup trace scalars survive
outer cleanup; neither missing diagnostics nor a timeout proves a startup cause.
Database, Git, endpoint and browser fixtures own their temporary resources;
only actual shared mutable resources require matching serialization tags.
Parallel safety is independent from cache eligibility. A missing cache
declaration means uncached execution, not exclusive execution. The full runner
has one checkpoint owner across concurrent groups; syntax preflight and locked
dependency preparation remain prerequisites. Every selected file still runs
exactly once or reuses a content-proven success. Cache decisions report a
stable content-free reason (`absent`, `fingerprint changed`, or the exact
uncacheable policy reason); they never print environment values or fabricate
reusable evidence. See ADR-0346. Existing frozen/admitted generations retain
their original runner; this policy applies only to subsequent compositions.

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
For an already-owned exact Codex turn whose lifecycle event precedes the 16 MiB
tail, restart/observer recovery may make a worker-side cold terminal scan of
at most 256 MiB for that exact turn. Only matching lifecycle records contribute
terminal authority; positive or negative results are retained in the bounded
per-process source cache while its entry survives, and append-only reads resume
from the byte cursor rather than rescanning on every poll. The requested turn's
terminal status and final answer survive the ordinary recent-final eviction in
that cached observation; later turns cannot replace its exact final.
Larger sources remain unknown to this fallback and require existing exact
terminal/audit evidence; no age or App Server status substitutes for it. This
exception never expands ordinary activity projection or runs on an active
command path.

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
ledger. Ordinary journal projection renders and replaces only dirty local-calendar
days in the existing usage worker (ADR-0076). Durable SQLite triggers mark both
old and new completion timestamps for record insert/update/delete. The successful
revision-fenced projection transaction replaces those days, virtual rows, lazy
turn bodies and summary buckets, then clears the dirty set. Conflicts and failures
retain the dirty set. Deleted/moved records leave no stale body or totals.
Initial migration, semantic-scope changes and existing Thread rebindings retain
one canonical full rebuild. A worker's compact accounting cache reads indexed
identities/revisions, loads only changed source records and removes deleted
identities. It normalizes the full source before omitting content; legacy empty
compaction filtering and image estimates cannot be inferred from stripped input.
Restart reconstructs this disposable cache from authoritative records once.
Rolling account totals still use the canonical full scalar/fact calculation;
this change does not promise constant-time account aggregation.
Only bounded workspace identity
batches cross back to the runtime; full journal bodies do not. Projection commits
are revision-fenced, and a failed or stale batch cannot clear pending audit work.
Terminal-outbox recovery likewise stages bounded batches before requesting a
shared journal projection. It must not rebuild the entire retained journal for
each recovered completion. Exact revisions are acknowledged only after the
shared projection succeeds; live completion adds no batching delay.
Concurrent projection requests share work only forward and only within one
exact scope: the ordered project roots and Claude-usage inclusion. A projection
answers requests made before it started; every request arriving while it runs
joins a single trailing projection that starts after it settles. An in-flight
projection never acknowledges a later terminal revision, different scopes never
share a run, and a failed or conflicting trailing run leaves each of its exact
revisions pending.
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
Task-title metadata reads seek the existing provider/task-thread index; selecting
one task must not scan all retained rows of that provider. Their measurements
separate metadata selection, exact-record reads, normalization and commit.
Rate-limit panel updates do not load or normalize the retained ledger. Automatic
historical batches read only their exact turn identities, merge repeated
identities within the batch and commit changed records in one transaction before
requesting the existing worker projection. Unrelated retained answers and diffs
do not enter the Hub event loop for these operations.
Canonical terminal-outbox readback confirms the exact journal record, matching
immutable accounting fields in the deterministic usage fact and a current turn
index. Recovery drains at most 100 projection-pending revisions per listing and
projects batches of at most 16. Attempts use durable least-recently-attempted
order, so permanent failures cannot starve a later page and a full page never
creates a zero-delay loop. Transient contention uses one runtime-scoped
single-flight retry with capped exponential backoff; a bounded low-frequency
pass retains eventual recovery after that fast budget or an enumeration failure.
Usage-history aggregation and pricing/image-estimate metadata scans also execute
in that existing worker. After legacy-read readiness is established, statistics
reads do not wait on the runtime mutation FIFO or materialize its ledger. They
use the same canonical pricing, attribution and filtering functions and omit
only fields those functions do not consume. Metadata writes read exact records
under the existing mutation handshake and preserve revision guards and unrelated
payload fields. Replaying the same metadata after an interrupted projection
uses the durable row/projection revisions to repair visibility without another
metadata write.
After restart, even an empty rediscovery result checks the indexed durable
changed-record revisions in its project scope and finishes a pending projection.
An account-panel-only revision does not invalidate the record projection.
Journal HTML is assembled once from its day fragments, and lazy turn extraction
runs once per day for both the fragment store and virtual index. Worker request
measurements distinguish queue wait, execution and the read/normalize/render/
commit phases through the same trace service; diagnostics carry no journal text.
Runtime code must not enqueue another usage-worker request while holding its
journal repository mutation lane. The worker may already be waiting for that
lane through the exact metadata-mutation handshake. Export, import and account
projection perform worker I/O outside the lane; journal commits re-enter it
with the existing revision fence. The handshake acquires the lane only when
the worker reaches that mutation and releases it before any further request.
Automatic terminal provider-account resolution likewise runs before the journal
mutation lane. Concurrent records for one provider share only the in-flight
account read; each exact record still commits independently with that observed
account identity. A settled or failed read is not cached, so a later terminal
observes an account change and a failed read remains retryable. Replacing the
account resolver invalidates every in-flight sharing slot for subsequent reads.
Runtime journal repository writes follow the same contention protocol as worker
journal commits. Each leaf database write that meets a foreign SQLite write lock
waits within the existing mutation window and is repeated only when its
transaction never started or was rolled back, so no committed change or change
notification repeats. The window is not a delivery timeout: when it is exhausted
the terminal revision stays pending and neither the repository revision nor the
record fingerprint advances. Repository close waits for every accepted write.

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
dropping equal-timestamp rows. A cursor snapshot does not read stored sync
events, which only a full export merges; auth and limit observations are
exported by both.
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

Opening a history page reuses terminal-identity recovery for at most its 20
exact terminal identities, including those older than the startup window.
It retains the same per-payload and aggregate byte bounds. Primary-key terminal
lookups and indexed exact-turn read-model queries never hydrate the rest of a
Thread. Recovery commits only the addressed turn positions and their history
search documents through the existing asynchronous SQLite mutation owner.
Already repaired pages remain read-only; stale cached or delayed history cannot
replace the durable `terminal-ledger` authority.

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
The Desktop snapshot owner may reuse Dashboard workspaces, tasks and layout only
under the TaskBoard's exact authoritative snapshot revision, including mutations
committed by another supported SQLite owner or connection. Unrelated live-run
revisions must not rebuild or reserialize those collections. A changed or
unavailable TaskBoard revision invalidates that reuse atomically and preserves
the existing content-derived collection versions and delta recovery behavior.
The TaskBoard snapshot revision deliberately includes its own mutation counter,
the durable `journal_store_meta` revision and SQLite's external data version, so
a journal-only write invalidates a cached board even when no Task row changed.
Opening a Task carries the client's exact snapshot and collection versions into
the selection command. The ordered selection mutation and its exact local
history read run concurrently; the first response contains the history page and
explicitly defers the authoritative snapshot to the ordinary version-fenced
refresh. A missing or stale baseline still receives the existing authoritative
reset, and no provider hydration enters this critical path.

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

Leaving Chat for Dashboard must not expand the hidden conversation's DOM. A
zero-sized history viewport is not underfilled; automatic paging rechecks the
currently visible owner before each page and resumes when Chat becomes visible.

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

Exact squash absorption is an explicit release operation, not an interactive
read path. Its Git witness work is bounded by the changed paths in the source
result and survivor replacement delta. It performs one repository-lock phase,
one expected-old `dev` ref update and one two-Task SQLite commit; it does not scan
arbitrary Workspace history or add background work to ordinary Task reads.

Published-duplicate absorption is likewise explicit and outside snapshot,
message and provider critical paths. It inspects only the source Task's bounded
managed repository set and the survivor's exact stored result references while
holding existing Await, Task and repository leases. It introduces no startup
scan, background reconciliation, provider request or second lifecycle owner.

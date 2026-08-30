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
reads of the same rollout and read options share one in-flight operation, and a
cold fallback reads at most the latest 16 MiB. Exact App Server state and managed
run identity remain preferred over JSONL fallback; reducing the scan window must
not truncate the terminal answer retained by TURN-001.

Periodic usage synchronization must not rebuild the complete journal projection
on the Hub event loop. Import, merge and account-panel calculation execute in a
dedicated worker. A remote usage delta updates only the account-usage panel in
the existing lazy journal index through a revision-guarded index write; an
unchanged snapshot performs no projection. Persisted day and turn fragments
remain authoritative and are preserved intact.

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
asynchronous retry rather than blocking busy waits.


The “Local Hub” health RTT is not message ACK latency and must not be presented
as such. Provider latency and remote Worker latency are separate indicators.

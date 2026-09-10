# RST-001 — Restart and maintenance recovery

## Identity and owner

Restart and compaction are persisted operations with `operationId`, kind, exact
Stream and Thread, optional provider turn identity, status and revision. They are
not user turns.

The client may show an explicit compaction boundary with its before/after context
measurement as a system maintenance marker. The internal probe command and
answer used to obtain that measurement are not user history and are never shown
as user or agent conversation cards.

Test Contour refresh is a separate persisted infrastructure operation governed
by REL-001 and ADR-0015. It binds contour root/marker/port and source/release
identity instead of Stream, Thread or provider turn identity. It is likewise not
a user turn and does not alter the restart/compaction operation schema.

## Invariants

- Timeout is ambiguous until reconciliation; it does not authorize duplicate
  non-idempotent starts.
- Publication readiness binds the expected current release to both the ready
  instance lock and the responding control snapshot's release and PID. A new
  endpoint serving an old release is not successful cutover. A publication may
  cold-start the verified installed launcher only after process absence is
  confirmed; a failed or timed-out restart RPC never authorizes that fallback.
- Compaction lifecycle writes use a Thread-scoped asynchronous mutation queue.
  SQLite contention retries only persistence under the same operation identity,
  never the provider RPC. Completion/failure cancels its watchdog only after the
  durable transition succeeds. A successful enclosing user turn cannot become
  evidence of compaction failure: its exact compaction item confirms success,
  while absent evidence remains unknown and accepts a later exact completion.
- Hub-requested dedicated compaction turns retain an explicit persisted marker.
  Terminal reconciliation accounts their usage without emitting a user response
  or changing the last message. Inline compaction inside an ordinary turn and
  legacy operations lacking that marker do not authorize suppressing its final.
- Admission is blocked only by an exact active maintenance operation.
- Restart is a barrier over durable finals, command receipts, delivery outbox and
  maintenance reconciliation.
- Once a restart operation is persisted, new durable commands remain queued in
  their exact lanes. The old runtime cannot admit them after the run that the
  restart is draining reaches terminal state.
- A replacement runtime finalizes the persisted restart and marks its instance
  ready before it starts deferred-input timers. Queued commands are then
  admitted once under their original `clientUserMessageId`.
- When replacement fails and the previous runtime restores ownership and its
  services, recovery settles that exact persisted restart as failed before
  clearing its request and publishing readiness. The restored runtime marks
  itself ready before resuming timers. Deferred cutover uses the same settlement
  even when it did not run through the initial request scheduler.
- Runtime startup wakes the queue owner, which reconciles recoverable persisted
  `task-running` and `activity-unknown` lane heads against current occupancy
  before FIFO dispatch. A stale external-observation reservation therefore
  cannot survive startup as authority after exact external-process absence is
  confirmed; unavailable process evidence remains unknown and blocks safely.
  Concurrent Thread checks share one bounded process snapshot per runtime
  cadence. Queue retries use capped exponential backoff with jitter; an exact
  completion or wake cancels that delay and rechecks the lane head immediately.
- Process death does not preserve local `running` as fact. Recovery reconciles
  provider state or records an honest terminal timeout/unknown result.
- Before provider discovery finishes, the initial catalog resolves retained
  Threads against existing visible Workspace/Stream bindings read-only. It does
  not expose an unbound historical Thread as a synthetic Stream. Discovery
  failure preserves unknown activity without promoting it to running; exact
  managed runs remain independently authoritative for activity and admission.
- Startup performs one bounded read-model reprojection for recent terminal
  turns whose retained payload identities are all confirmed by exact terminal
  command-ledger bindings. The reprojection is idempotent, preserves terminal
  state and never dispatches a provider effect; ambiguous evidence is skipped.
  Candidate discovery uses terminal-store-owned persisted payload-byte metadata
  and deterministic covering-index order; the read-model owner never scans or
  sorts terminal JSON to discover candidates.
- Restart UI appears only for a real persisted restart phase and cannot hide a
  final response.
  A disconnected health request alone never asserts a restart. While waiting
  for connection or replacement, the screen shows no stage progress inherited
  from the previous health sample and does not claim readiness. Known failed
  startup details remain available during ordinary connection loss. Fresh
  health and the canonical connection state remain the reconnect authority.
- The startup screen retains failed-stage details and exposes authenticated
  retry and restart actions. Retry is fenced by the exact runtime startup
  generation, coalesces concurrent requests, and runs only failed recoverable
  stages plus their skipped dependencies after initial startup settles.
  Completed stages and command dispatch are never replayed by a retry.
  An unavailable control plane requires the installed local launcher; a browser
  cannot start a process on an offline host.

## Optional startup enrichment

Full provider catalog/pricing enrichment is background work after the mandatory
startup and readiness barrier. It is measured and retryable, but does not reopen
the startup barrier or hide the ready interface. Recovery of active ownership,
durable terminals and the persisted restart remains mandatory before dispatch.
Background enrichment reuses one existing owner, yields between bounded units,
and stops admitting more units during shutdown. See ADR-0030.

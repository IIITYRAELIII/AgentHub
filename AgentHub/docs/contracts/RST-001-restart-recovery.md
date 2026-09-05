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
- Admission is blocked only by an exact active maintenance operation.
- Restart is a barrier over durable finals, command receipts, delivery outbox and
  maintenance reconciliation.
- Once a restart operation is persisted, new durable commands remain queued in
  their exact lanes. The old runtime cannot admit them after the run that the
  restart is draining reaches terminal state.
- A replacement runtime finalizes the persisted restart and marks its instance
  ready before it starts deferred-input timers. Queued commands are then
  admitted once under their original `clientUserMessageId`.
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
- Restart UI appears only for a real persisted restart phase and cannot hide a
  final response.

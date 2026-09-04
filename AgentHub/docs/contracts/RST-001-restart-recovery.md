# RST-001 — Restart and maintenance recovery

## Identity and owner

Restart and compaction are persisted operations with `operationId`, kind, exact
Stream and Thread, optional provider turn identity, status and revision. They are
not user turns.

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
- Process death does not preserve local `running` as fact. Recovery reconciles
  provider state or records an honest terminal timeout/unknown result.
- Startup performs one bounded read-model reprojection for recent terminal
  turns whose retained payload identities are all confirmed by exact terminal
  command-ledger bindings. The reprojection is idempotent, preserves terminal
  state and never dispatches a provider effect; ambiguous evidence is skipped.
  Candidate discovery uses terminal-store-owned persisted payload-byte metadata
  and deterministic covering-index order; the read-model owner never scans or
  sorts terminal JSON to discover candidates.
- Restart UI appears only for a real persisted restart phase and cannot hide a
  final response.

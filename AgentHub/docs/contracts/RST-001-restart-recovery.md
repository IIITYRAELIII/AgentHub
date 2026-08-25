# RST-001 — Restart and maintenance recovery

## Identity and owner

Restart and compaction are persisted operations with `operationId`, kind, exact
Stream and Thread, optional provider turn identity, status and revision. They are
not user turns.

## Invariants

- Timeout is ambiguous until reconciliation; it does not authorize duplicate
  non-idempotent starts.
- Admission is blocked only by an exact active maintenance operation.
- Restart is a barrier over durable finals, command receipts, delivery outbox and
  maintenance reconciliation.
- Process death does not preserve local `running` as fact. Recovery reconciles
  provider state or records an honest terminal timeout/unknown result.
- Restart UI appears only for a real persisted restart phase and cannot hide a
  final response.

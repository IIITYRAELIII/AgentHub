# ADR-0002 — Durable command ledger

## Status

Accepted target architecture; migration pending.

## Decision

Replace split file receipt, deferred intake and runtime-snapshot command
ownership with one appendable durable command ledger keyed by
`clientUserMessageId`. Keep full runtime snapshots and cleanup outside the local
ACK path. Terminal delivery uses a separate durable outbox.

## Consequences

Retries become exactly-once at the Hub effect boundary, ACK latency no longer
inherits full-state persistence, and restart recovery reads one monotonic command
state. Migration must dual-read existing receipts and deferred rows until no
legacy active command remains.

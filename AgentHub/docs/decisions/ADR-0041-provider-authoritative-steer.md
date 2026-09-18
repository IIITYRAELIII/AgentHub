# ADR-0041 — Provider-authoritative steer eligibility

## Status

Accepted for HUB-216 implementation.

## Context

Agent Hub treated a locally observed Codex `final_answer` item as a terminal
steer fence both during admission and immediately before dispatch. The provider
could still accept `turn/steer` for that same exact turn, so local projection
suppressed valid user input for minutes and contradicted provider state.

## Decision

The exact managed run and turn remain the local identity fence, but the provider
RPC is authoritative for steer eligibility. A requested steer is durably stored
once before dispatch even when local response projection already contains a
`final_answer` item. Dispatch calls `turn/steer` once. A definite provider
stale/not-steerable rejection converts the same durable command to ordinary
queued intake without changing its client identity or FIFO position. Timeout or
unknown outcome remains in bounded reconciliation and is not replayed blindly.

## Consequences

Local phase timing can no longer suppress a steer the provider would accept.
Exact stale run/turn protection, durable intake, idempotency, provider rejection
fallback and unknown-outcome reconciliation remain unchanged.

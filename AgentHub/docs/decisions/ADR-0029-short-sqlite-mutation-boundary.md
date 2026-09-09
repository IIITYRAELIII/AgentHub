# ADR-0029 — Short SQLite mutation boundaries

Status: accepted
Date: 2026-09-10
Contracts: PERF-001, MCP-001, MSG-001, TURN-001

## Context

SQLite writes used inconsistent contention handling and some bypassed it.
Synchronous busy waits blocked the runtime event loop. The Task mutation owner
also wrapped the entire asynchronous checklist outbox drain: a callback could
await another mutation or be repeated after its acknowledgment hit SQLITE_BUSY.

## Decision

Use the shared asynchronous contention queue for short database operations,
retaining each existing owner and its ordering scope. Keep external effects and
file preparation outside retry. Explicitly classify internally managed effects
alongside reads and short mutations; their own persistence boundary must queue
each acknowledgment/quarantine with the original durable identity.

Preserve existing runtime/usage retry budgets when replacing duplicate policy
implementations. Add monotonic queue-wait, execution, total-duration and depth
diagnostics. No normal-write batching delay or Hub-wide business queue is added.

## Consequences

Memory queues coordinate local attempts; they do not replace command receipts,
terminal ledgers or durable outboxes. Exhaustion remains a visible error/unknown
outcome at the owning contract. Crash recovery reuses existing event identities.
Optional telemetry indexing cannot delay already committed terminal history.

A single physical writer worker per database is not introduced here. That change
requires workload evidence and separating every asynchronous effect first;
otherwise a shared FIFO can deadlock or cause unrelated operations to wait.

## Evidence

Real SQLITE_BUSY tests cover timers, same-ID replay, receipt admission/settlement,
history ordering and immutable input, pin undo, restart recovery, usage/limits,
checklist acknowledgment without repeated callback, and nested Task mutations.

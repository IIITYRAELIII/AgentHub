# ADR-0030 — Unified performance evidence and optional enrichment

Status: accepted (explicit operator request, 2026-09-10).

## Context

Existing command timing, runtime health counters and client ACKs lacked detailed
started/finished evidence at terminal projection waits and rendered UI actions.
A completed Vega turn remained visible as active after projection stalled; the
available traces could not identify the awaited dependency. Startup also awaited
optional full catalog/pricing enrichment before declaring readiness.

## Decision

Extend the existing command trace service and its bounded SQLite worker. Reuse
client timing/ACK transport and runtime-health counters. No second logging or
reconciliation owner is introduced. Report p50/p95/p99, slow spans, incomplete
operations, data range and file sizes through a read-only CLI. Keep seven-day
expiry with the existing row cap; idle cleanup and efficient cap enforcement
prevent diagnostics from becoming unbounded background work.

Move optional catalog/pricing enrichment after readiness. Keep authoritative
active-turn/restart recovery before readiness and deferred dispatch. Background
work uses existing bounded units and owner cancellation, with separate health
progress; instrumentation does not reorder terminal persistence or ACKs.

## Consequences

Clients remain usable while enrichment runs. Metadata may initially be older.
Telemetry is best effort and incomplete traces never establish lifecycle state.
Long tasks are observed where supported, and diagnostics themselves are bounded.
This does not promise that every existing synchronous application operation has
become fast; it creates attributable evidence for subsequent fixes.

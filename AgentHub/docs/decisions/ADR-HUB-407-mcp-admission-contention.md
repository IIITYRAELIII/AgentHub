# ADR-HUB-407: distinguish pre-receipt SQLite contention

## Context

Two retained real Task submissions failed with database-is-locked about2009ms
after tool receipt. Existing bounded catalog mutation retries cover2000ms after
dequeue. The existing Task submission owner propagates missing-receipt failure,
and readback previously conflated absent receipt with foreign authority. This
forces an operator to inspect multiple owners before deciding what was admitted.
Historical logs do not identify the competing holder or individual failed SQL
statement; no such attribution is invented.

## Decision

Keep the existing mutation queue, bound and receipt transaction. Classify only
actual contention raised by the initial BEGIN before that invocation starts its
transaction. A typed error retains exact caller/tool/request/hash through the
same bounded queue. The authenticated Task submission owner prefers an existing
canonical receipt, otherwise returns an explicit invocation-scoped not-admitted
response. It does not persist another receipt or schedule a later automatic
effect. Missing receipt lookup is a fresh not-found observation, never a
historical failure/no-effect certificate. Other SQL/commit/business failures and
UNKNOWN remain under their existing owners.

The Task's current CAS remains enforced after admission wait. Declared-successor
namespace and interruption checks remain inside the original transaction before
INSERT. The original idempotency ID is retained for a lawful explicit later
submission. No new ledger, writer, authority token, timeout, scanner or global
busy gate is introduced. Frontend and Desktop result consumers do not turn the
new response into Task success or resubmit a missing original.

One content-free per-invocation queue/persistence summary uses the existing
command trace. It localizes future queue/attempt/contention intervals without
claiming a competing holder, CPU cost or historical measurements that do not
exist. Timing failures are advisory only.

## Validation and limits

Real isolated SQLite contention through actual HTTP MCP/Task owners reproduces
the prior generic failure and missing-row authority error. Addressed tests retain
same-ID one-effect behavior after actual lock release, current CAS, foreign
actor/hash/Task refusal, UNKNOWN and non-contention errors. Desktop and shipped
client controls cover classification and no automatic mutation replay. Existing
workflow refusal and successor authority remain independent. No production lock
stimulus, original settlement, runtime adoption, full suite or Contour is implied.

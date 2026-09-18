# ADR-0071 — Bounded durable message command lifetime

## Status

Accepted by explicit user request: expire stale commands after three days.

## Context

The 500-command admission limit included old `started` and `dispatching` records
with no remaining managed run. The previous seven-day deferred-input cleanup
removed only queue projections and did not release durable ledger capacity.

## Decision

The existing message ledger owns a 72-hour lifetime from immutable acceptance
time. The existing deferred-input controller supplies live ownership guards,
startup and minute cadence. Intake and dispatch use the same expiry owner.
Exact active runs, their aliases and claimed dispatches are protected. Expiry
persists before removing projections, retains history/idempotency and does not
delete attachments. Legacy records use their already-migrated acceptance time.

An expired command is administratively cancelled, with an explicit expiry marker
and unknown provider-effect outcome. This changes command retention, not provider
lifecycle truth. Expiry never interrupts, completes or replays an uncertain
provider operation. Authoritative later terminals use normal reconciliation.

## Consequences

Inactive old commands no longer reserve capacity forever. A genuinely active
managed run can outlive three days. Same-ID retries never revive expired work;
the user must explicitly submit a new command to request a new effect. The older
deferred-input configuration still governs non-command legacy entries and forward
bundles; it cannot override this ledger-backed command lifetime.

# ADR-0034 — One resumable publication executor

## Status

Accepted for HUB-182.

## Context

The September 8 release took 4h41m in its principal turn. Evidence includes
42 unconditional retries of 14 failing files, four 15-minute suite timeouts,
discarded successful file checkpoints, late candidate smoke, and manual
coordination between Git publication, deployment, restart and Task closure.
Integration defects and incorrect ownership diagnoses also consumed time;
this decision does not claim every historical timeout has the same cause.

## Decision

Keep Task/Git ownership, frozen candidate construction, publication checkpoint,
run journal and canonical release finalization as their existing authorities.
Connect them with one executor rather than introduce another release planner.
Persist validation mode and exact candidate identity. Run smoke before the full
suite; remove unconditional file retries and preserve only proven successful
input fingerprints with bounded retention. Move the two cosmetic browser
matrices to the visual suite, retaining them in affected UI and full validation.

Publish Git under an exact lease before deployment and recheck it on every
pre-deployment continuation. Persist a completion draft before readiness and
retain the same command identity across ambiguous results. Deferred restart
remains pending. After readiness, the runtime may finish only the saved
publication and canonical finalization under the same lock.

Task closure and the finalization marker commit atomically. Primary sync, dev
sync and remaining-Await rebuild persist individual receipts. Retain bounded
completed outcomes for lost-response replay and reconcile interrupted completion
against those outcomes or the exact pending marker. Generic mutation recovery
does not gain permission to replay unknown effects.

## Consequences and migration

Quick mode is explicit, not a silently weakened full gate. Expensive tests with
unknown external inputs remain uncached until their inputs can be proved.
Old cache entries are ignored; old completion journals without identity/draft
cannot auto-complete. Legacy Await-only markers retain their narrower scope and
report missing synchronization evidence. These guards can be removed when the
corresponding old persisted formats are no longer supported.

The first Git adapter supports a single frozen repository. Multi-repository
publication requires coordinated evidence before this restriction can be lifted.
No broad dev merge, Task selection, or user approval is synthesized by retry.
Source fixes still require a new immutable candidate; deployment failure is not
permission to repair production from a dirty checkout.

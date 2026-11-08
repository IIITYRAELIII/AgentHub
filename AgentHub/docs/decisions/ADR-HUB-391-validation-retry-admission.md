# ADR-HUB-391 — Preserve failed validation for explicit retry scope

Status: accepted with this implementation, 2026-11-01.

## Observed boundary

After the public release's selected validation failed, a later unrelated Task
acceptance called the existing `wakeForTask` → ordinary `continue`. The saved
`publishStarted` prevented acceptance preparation from fencing that generation,
but wake still resumed it. Another generation retained the old sixteen-file
selection and repeated already green work before the RM could amend its scope.
The same defect exists before publication reservation: acceptance preparation
itself moves a failed validation back to compose.

Acceptance, changed membership, a changed result or descriptive metadata cannot
prove which failed test was fixed or which saved input fingerprints remain valid.
Inferring coverage at this boundary would introduce unsafe test-selection policy.

## Decision

Keep `waiting(validation_failed)` in its existing idle state. Pre-acceptance
preparation and post-acceptance wake do not mutate/schedule it, and ordinary
unamended continue returns `accepted:false, reason:test-selection-required`.
The existing observation callback can still read the original without resuming it.

Use the existing RM request-addressed test-selection/membership/release-metadata
amendment for the failed and affected checks and whole current notes. Its exact
revision/generation CAS, original not-applied readbacks, source/selection checks
and idle owner boundary remain unchanged. This is an execution-scope decision
under standing release authorization, not another user GO, API, ledger, poller
or Task freeze. A genuine corrected result may be accepted normally and join
the next explicitly amended generation. Old generations, errors, green file
checkpoints and uncertain effects remain original evidence.

This narrowly supersedes ADR-0073's implication that accepting a correction
alone restarts a failed validation. Initial release progression, active
pre-publication selection fencing, lineage `correction_required` recovery and
already-running publication remain supported. No running or historical release
is rewritten, stopped or rescaled by applying source.

## Pre-effect changes after an explicit amendment

A second observed path is independent of `validation_failed`: after an RM
amended a failed original with exact five-Task notes and two selected tests,
acceptance of a sixth Task fenced the active generation back to compose. The
all-Await adapter selected six Tasks but inherited the old amendment's notes and
test scope. Duplicate pre/post acceptance callbacks could both request this
recomposition before the first publication reservation.

After an explicit amendment, pre-effect acceptance or the existing publication
selection readback now moves the same original to
`waiting(release_inputs_changed)`, without composing another generation. The
selection-change CAS fences progression. The same live owner retains its lease
while it settles an already-started compose/validation receipt and releases
normally. A completed in-flight compose joins its original immutable generation
without leaving the wait; late validation cannot advance it. An unresolved future
compose receipt or generation refuses amendment rather than being overwritten.
No replacement lease or cleanup owner is created. The publication boundary
returns immediately on this waiting result,
before any target intent or effect. Repeated pre/post callbacks leave this wait
unchanged; ordinary continue only observes it.

The existing idle amendment owner requires explicit whole `taskIds` and
`testSelection`, plus fresh `releaseMetadata` when effective notes already exist.
Otherwise a selection-only amendment could silently inherit old notes through
the existing effective-metadata lookup. Existing selection capture/recheck,
not-applied readbacks, source and revision/generation CAS remain mandatory.
An exact saved amendment replay still returns its original receipt first, without
clearing the new wait or scheduling work. No freshness or coverage is inferred
from the request ID or acceptance event.

This correction concerns inputs already bound by an explicit amendment. Initial
release progression, ordinary unamended result/lineage correction, existing
failure/UNKNOWN recovery and already-reserved publication keep their current
owners. Task acceptance remains available; only reuse of stale amended release
inputs is held for the already authorized RM's existing amendment.

## Evidence

Existing service tests use actual SQLite operation/step receipts and a controlled
publisher/readback. They cover failure in both validation and the reserved
publisher, unchanged/unrelated/new/corrected acceptance without G2, ordinary
continue refusal, preserved fifteen green checkpoints and the original failure.
An explicit amendment then binds exactly failed plus affected IDs/current notes,
publishes the corrected result once and retains all G1 bytes/receipts. Existing
initial progression, active fencing, started publication, lineage correction,
amendment replay/CAS and unknown-effect checks remain affected controls.

This does not establish a TLS or native-case timeout cause, production timing
improvement, successful real publication or adoption into the running owner.

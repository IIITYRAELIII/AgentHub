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

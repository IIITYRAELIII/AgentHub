# ADR-0118: Full-test execution follows progress, not a total deadline

Date: 2026-10-19
Status: accepted for HUB-324 correction
Contract: REL-001

## Context

The prescribed full publication pipeline reached its two-hour aggregate timer
while the selected suite was still reporting test results. The existing owner
stopped its child tree and retained a failed validation receipt, before artifact
preparation, Git publication, installation or deployment. That historical receipt
and generation remain unchanged. The instructed full pipeline must finish its
selected checks without an aggregate execution timeout.

## Decision

The existing full-test step passes an explicit null execution deadline to the
existing runStep owner. This suppresses only its aggregate wall-clock timer.
Its ten-minute output-idle watchdog still stops the exact owned process tree;
the stop-versus-exit race cannot report success after watchdog failure.
Ordinary publication steps retain the existing finite default or explicit bound.
Test-local, network, build, restart and readiness limits remain unchanged.

No alternate runner, publication operation, retry loop or validation waiver is
introduced. Corrected selected results proceed through the ordinary lifecycle
and an immutable successor generation of the same authorized operation. Prior
failures and unconfirmed external effects are never rewritten or replayed.

## Evidence and limits

The owner regression advances a deterministic clock beyond three hours while
reporting progress, then observes normal child completion. Existing idle-tree
termination and bounded ordinary-step tests remain. This focused proof does not
claim a completed real full suite, publication, installation or production QA.

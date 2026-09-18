# ADR-0064 — Manual Test Contour session lock

Date: 2026-09-16
Status: Accepted
Contracts: REL-001, RST-001, SYS-001

## Decision

Agent HUB provides `contour:lock`, `contour:lock-status` and `contour:unlock`
for multi-step manual testing of one prepared Test Contour version. The lock
command stays in the foreground and owns the existing per-root interprocess
operation lease. Refresh, stop, verify, clone, recording adoption and uninstall
already use that lease, so there is no second blocking flag or bypass path.

Acquisition requires an explicit display owner, the exact active Agent Hub
provider/thread/turn identity, an idempotent request ID, and the exact ready
operation ID, source head and release ID read before testing. The active turn
and all three contour values are rechecked after the canonical lease is acquired.
A concurrent refresh therefore
either wins first and makes acquisition reject the stale expected identity, or
waits behind a successful manual hold. Different contour roots use different
leases.

The durable request receipt contains a random acquisition ID and release token.
Retry of the same request reports the same live acquisition or its terminal
release; it never creates a second owner. Unlock must match request,
acquisition and token, and merely asks the foreground owner to leave its
canonical lease. A stale or foreign unlock cannot release a later acquisition.

## Lifecycle and recovery

The foreground process owns the canonical lease, but it is not by itself the
testing-agent lifecycle. It watches the production runtime store for the exact
provider/thread/turn supplied from the current Agent Hub context and claim.
Explicit unlock is the normal end. The owning managed-run completion boundary
writes an immutable provider-neutral `completed`, `failed` or `aborted` record
for Codex and Claude; that exact record, or Codex's existing delivery terminal,
also ends the hold while the helper process survives. This small lifecycle
ledger has no delivery outbox and does not duplicate provider final-answer
projection. Absence from `activeRuns` without exact terminal evidence is unknown
and does not release the lock. A provider recovery read/reattach exception and
the local classification that a run could not be recovered are also unknown;
neither may be promoted to an immutable terminal record. The managed run stays
available for retry after a generic recovery error, while a locally dismissed
run without provider proof still cannot release a surviving holder. Handled
helper error or cancellation exits through the lease `finally` path. Abrupt helper-process death leaves the canonical
token-owned record; the existing
interprocess-lock recovery retires it only after PID/process identity proves the
owner dead or replaced. A live or identity-unknown owner is never stolen because
of elapsed time or a missed heartbeat. Manual receipt files are readback and
idempotency evidence, not a second authority; stale evidence cannot keep the
contour locked after canonical recovery.

## Scope

The hold protects only one shared contour root while the agent is actively
testing it. It must not cover development, fixes, local tests, review or waiting
for a person. General generated Workspace rules mention this only conditionally
when a project supplies both a shared environment and a lock. Hub-specific CLI
commands remain in Hub documentation and do not modify live custom
Workspace/Stream fields. Release preflight and the full publication pipeline are
unchanged.

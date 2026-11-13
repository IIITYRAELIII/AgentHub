# Archive an abandoned release service without publication

Status: accepted for the explicit abandoned-service correction.

## Context

A release-service card can remain open after its release has definitively FAILED
and the user has abandoned that attempt. The published-service route correctly
requires publication and completed members. Operational cleanup correctly needs
an exact managed source. Neither proves the distinct metadata archive intent for
a failed service with no implementation result. Retrying a failed operational
preview cannot provide that missing authority.

## Decision

Extend the existing Complete owner with explicit `abandoned_release_service` and
an exact canonical original operation/revision/generation input. Use existing RM
authorization, Workspace Await lease, Task lease, confirmation token, lifecycle
intent/finalization and original reconciliation. Read only the addressed release
and generation from the canonical store; verify authorization/generation identity,
idle terminal FAILED state and complete historical service result references.
Recheck immediately before archive. Require no active local release worker.

Archive only the service card, preserving its workflow status. Keep FAILED,
unknown effects, selected Task cards/results, frozen bytes and release history.
A present managed source must be clean and exactly its immutable base; preserve
it. For a metadata-only card prove absence of unregistered source directories and
Task refs. No result, publication, deletion, release continuation or new receipt
writer is introduced. The external release tool API and recipe remain unchanged.

An interrupted confirmed archive uses only its durable original intent/outcome.
The existing reconcile owner validates the complete original arguments before
resuming or reading that outcome. Historical unsealed UNKNOWN remains UNKNOWN.

## Evidence and limits

Maintained public MCP tests use real Task/catalog/release SQLite stores, native
tiny Git and existing leases. They cover metadata-only and base-only preserved
custody, unfinished members, stale/foreign bindings, active workers, changed
selection/source, stale confirmation, interrupted archive, lost reply and refusal
to adopt an old operational UNKNOWN. Existing published/operational guards remain.

The mode does not settle whether any failed release external step had effects.
It does not repair or resume the abandoned release. Legacy originals without
positive canonical generation/checklist bindings remain refused rather than
being reconstructed from notes or error text.

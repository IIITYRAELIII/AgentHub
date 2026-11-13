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

## Null-Stream service and retained preview correction

The first operational preview exposed a genuine Workspace card whose Stream was
null. The initial fixture had assigned that field and missed this input. Release
Stream authority belongs to the authenticated current RM caller, not a missing
card assignment. The original must match that actor's Workspace and Stream, and
an assigned card must match as well. Preserve null rather than assigning the card.

The first preview's exact request remains UNKNOWN until the existing public
reconciliation owner validates its retained original execution arguments/hash,
same actor, readonly argument family and absence of lifecycle intent/outcome.
That owner can read a fresh preserve-only preview, retain the prior diagnostic
in reconciliation evidence and complete the same original receipt. It grants no
archive effect: the fresh token still requires a separate confirmed request.
Changed, foreign, cancelled, confirmed or operational originals do not enter
this route. A lost reply uses the original preview readback, without resubmission.

Maintained fixtures now distinguish journal and release databases, use real
persistence capabilities, and exercise the existing openReleaseRuntime with its
default canonical release services and real preflight/leases for the null-card
and same-preview recovery cases. These checks perform no production effects.

## Repeated normal Test dependency

The corrected result's ordinary Test exposed a separate content-proof defect.
Its unique common parent with dev was this Task's previous integrated result,
which descends from the sealed publication. The existing publication reader
credited only an exact publication/common-parent match and fell back to the old
pre-publication Task base. Seven unchanged inherited publication files, already
retired by independent dev work, were then mistaken for new own Task changes.
The issued candidate was exactly the unforced native merge; the original UNKNOWN
and capture remain intact.

The same selected-content owner consumes its already sealed publication when
that publication is an ancestor of the single exact common parent. It still
replays the complete own delta from publication, not from the previous own
result. A removed earlier own addition therefore still refuses. Existing
publication identity, agreed-base ancestry, history/CAS/effect guards remain;
multiple or foreign common bases gain no credit. No original, Task base, shared
branch or journal is rewritten. New tests preserve independent dev context and
reject both lost own work and absent publication authority. ADR-HUB-400's other
selection-policy boundaries remain in force.

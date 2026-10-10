# ADR-0086 — Full OWN from a newer registered Task base

## Context

Task base migration can put a registered base after the currently published
revision while preserving the Task's complete result and owned integration.
The rolling dev tree can already include those bytes through a different
integration. A later ordinary integration can therefore have an empty effective
delta; a review correction can have only the final correction delta.

The incremental candidate owner already rejects reuse when the selected
candidate does not represent the entire Task-owned parent snapshot. However,
the ordinary net proof previously required Task base to be an ancestor of the
published composition base. A migrated base failed that condition and silently
fell back to effective dev replay, losing both the added result and previously
selected results when rebuilding from publication.

## Decision

Extend the existing Task net projector at its registered-base ownership boundary.
When publication is an ancestor of a newer registered Task base, effective dev
replay cannot be used as a substitute for an unproved full result.

The supported proof is deliberately bounded: result reaches the exact registered
base through at most 512 single-parent commits; its declared dev integrations are
automatic two-parent merges, unique to this selected Task, with task-side parents
on that owned lineage and the latest integration carrying the exact current
result. Integration identities and order must be unambiguous. Collapsing multiple
integrations cannot reorder an overlapping intervening selected delta.

The projector emits the existing net-projection shape using registered Task base
as parent and current result as commit. Existing selected composition applies
that full OWN in durable order with its normal merge/conflict handling. Inherited
base context does not enter the candidate. A missing proof raises
`TASK_RELEASE_OWN_PROJECTION_REQUIRED` before ref/checkpoint promotion; existing
candidate rollback and UNKNOWN handling remain authoritative.

This is not a second selector, journal, reconciliation route, adoption receipt or
published-main approval. A generic merged result requires its existing supported
proof rather than this linear ownership rule. Old approved-base net projection,
squash/selected proofs and valid incremental reuse retain their current rules.
The newer-base branch is inapplicable once the registered base is contained in
publication; the normal approved-base proof then applies.

## Verification and delivery limits

Focused synthetic Git regressions exercise zero dev delta with an initial result
and correction, preserved selected neighbor, excluded unpublished base context,
and refusal for manual integration, foreign result merge, wrong task-side parent
and non-unique ownership. The migrated selected consumer packet is checked through
the actual candidate owner, including overlapping selected composition and
outside-path equality. Valid incremental reuse remains separately checked.

Source capability does not establish installed delivery or public recovery API
availability. A successful original Await remains immutable; rebuilding its
incomplete candidate requires a supported canonical recovery operation with its
own exact admission, receipt, CAS and terminal readback.

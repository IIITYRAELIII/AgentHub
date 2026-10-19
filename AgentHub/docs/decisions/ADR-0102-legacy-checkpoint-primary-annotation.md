# ADR-0102 — Preserve an imported orphan after primary synchronization

## Status

Proposed, 2026-10-08. Affected independent review required before Task integration.

## Context

The release operation store imports an unmatched legacy checkpoint once as
immutable evidence. Primary synchronization can later add
`primarySynchronizationProof` to that checkpoint. Hashing the annotated snapshot
as new evidence rejects a subsequent startup even though the original orphan
and its publication authority have not changed.

## Decision

The existing `ReleaseOperationStore.importLegacy` owns this compatibility rule.
For a previously imported `release-checkpoint-v2` with the same source identity,
both calls must be evidence-only. The operation must still be unowned `waiting`
with `legacy_snapshot_evidence`, no resume state and no retry timestamp.
Only removing the newly supplied `primarySynchronizationProof` field may
reproduce the exact original evidence SHA-256. If it does, the import reuses
the original operation, generation, evidence and events without any SQL write.
It does not rewrite the checkpoint or activate recovery.

Any other evidence change still refuses. A proof present at first import stays
part of immutable evidence; this rule cannot alter it on replay. Matching
publication-status imports retain their exact evidence guard. It introduces
no receipt settlement, publication permission, retry or second state owner.

## Consequences and removal

Repeated startup tolerates this annotation while retaining the first imported
snapshot byte-for-byte. Focused real SQLite fixtures cover the orphan replay,
other-field drift, first-import proof and authoritative publication controls.
Remove this exception together with the legacy checkpoint importer after that
migration boundary is retired. REL-001 remains the governing contract.

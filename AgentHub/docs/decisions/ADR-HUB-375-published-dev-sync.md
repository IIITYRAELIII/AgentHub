# ADR-HUB-375 — Reviewed recovery of published main into dev

Status: accepted for implementation; source acceptance and live application are
separate evidence.

## Problem and owner

Publication can succeed and canonical Task delivery can commit while the existing
main-to-dev owner rolls back a conflict. Repeating an unchanged Task Test reuses
its local-main integration; it does not authorize arbitrary published ancestry.
The accepted-main bootstrap has a different authority and CHANGELOG-only boundary.

Extend the existing published sync owner and native sequencer. Keep original
release/generation/publication authority and preserve all later dev work. Use the
existing native merge journal, repository lease, process guards, authenticated
independent review and Git delivery checkpoints. Do not introduce another ledger,
publisher or Task result.

## Existing public continuation

Use the normal source/default `release.mjs continue` with genuine RM identity and
a business JSON request:

```json
{
  "operation_id": "original-release-operation-id",
  "request_id": "addressed-native-sync-request-id",
  "expected_revision": 1,
  "expected_generation": 1,
  "published_dev_sync": {
    "projectRoot": "canonical-repository-root",
    "expectedDevCommit": "0000000000000000000000000000000000000000"
  }
}
```

The example numbers and OID are placeholders; read current original CAS and dev
before invocation. It requires applied publication and waiting/finalize with no
owner. The release's existing lease fences concurrent continuation; no pipeline
wake or drain occurs. The original candidate digest and publication effects are
reread at every owning effect boundary.

A conflict returns `devSynchronization.nativeConflictRoot`. Resolve there using
ordinary native Git add/commit, preserving the ordered parents. A subsequent
addressed call returns canonical `binding`/diff for independent review. Supply the
existing genuine RM-recipient native review as `nativeResolutionReview` in a new
addressed call with fresh operation CAS. No synthetic review or old Task verdict
can authorize it. The digest-bound native bundle input is also supported by the
existing sequencer. Marker-only conflicts require review in this owner.

Before delivery, the same journal seals target commit/tree. Existing Git checkout
collision protection and expected-old dev CAS deliver it. An integration block
preserves unfinished owned work from other dev writers. A lost local response
does not reset or repeat a CAS: original head/ref/index/branch checkpoints are
read back. Dirty or partial foreign state refuses. After successful synchronization,
ordinary same-original continuation finishes only finalize; Task delivery is
idempotent and publication remains applied.

## Migration and limits

There is no conversion or retargeting of old finalization receipts, Task results
or native reviews. Existing automatic clean synchronization remains unchanged.
The new source must actually execute through the existing composition; placing
it in a future product candidate cannot change an old installed owner. A compatible
reviewed source context is needed for a source-owned historical operation. Live
application is performed only by its Release Manager after source/context review.

This mechanism preserves runtime installation/restart authority as a separate
owner. It makes no latency or all-platform incident-resolution claim. Addressed
checks exercise real Git/SQLite, authenticated review, later-Test preservation,
wrong authority/drift, lost delivery replies, one CAS and original finalization.

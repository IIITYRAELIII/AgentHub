# ADR-HUB-466 — Task completion after manual delivery

## Context

The retained Task cleanup reader uses historical publication state. A later
manual installation may be Ready and present in main/origin while Complete
reports an old revision. Ignoring that refusal or manufacturing a publication
generation would replace the original evidence. Ignored WIP and dependency
receipts also outlive Git clean status and must not be discarded to close a card.

## Decision

The existing RM-only Task Complete surface has explicit `manual_delivery` mode.
Revision, release ID and raw manifest hash are pinned; the runtime root comes
from the configured installation owner. The reader uses the existing installed
verifier and Ready/process observation, reads exact main/origin, proves every
Task result and current managed head is included, and compares runtime source
to Git using the existing source line-ending/LFS policy and compiled Host hash.
Pointer, manifest and process identity are rechecked. Evidence belongs only to
the Task outcome; publication state and original outcomes are unchanged.

Workflow Done precedes closing. Preview and confirmation bind the Task revision
and delivery/retained-artifact description. Existing SQLite lifecycle closes the
card while preserving all branches, worktrees, ignored files and receipts.
Dirty or unrepresented later work refuses. Cleanup remains a separate operation.

The retained `synchronizeMainIntoDev` service accepts explicit `manualSync` with
that verified installation, original operation ID, Workspace and expected dev.
It reuses the existing isolated native synchronization journal, directory/lease
fences and dev CAS. Conflicts leave dev unchanged and expose the isolated
checkout; a normal reviewed resolution is consumed under the unchanged binding
and fresh delivery checks. Partial delivery stays with its original journal.
No generation, publication receipt, orchestrator or implicit adoption is added.

## Validation

`node --test tests/infrastructure/filesystem/manual-task-delivery.test.mjs`
covers Git containment, mismatched installation inputs, SQLite close/reopen and
idempotence, preserved ignored evidence, and isolated conflict/resolution with
later dev work and origin drift. The affected MCP case checks RM authority and
manual completion argument forwarding. A real dev CAS with a lost reply is
recovered through the same original journal. The public Complete test loses
the terminal MCP write after the SQLite outcome and reconciles that original
without replaying proof, closure or Git cleanup.

## Existing owner inputs

The authenticated RM calls `hub_task_complete` with `completion_mode:
"manual_delivery"` and `manual_delivery: { revision, releaseId,
manifestSha256 }`. It reads the preview, then confirms a fresh original with
`confirm_cleanup: true` and the exact `expected_cleanup_token`. Workflow Done
is still an independent preceding operation. A lost reply is addressed by
`hub_task_operation_reconcile` on that original, never by a replacement Complete.

The existing configured Task Git service accepts:

```js
await taskGitWorkspaces.synchronizeMainIntoDev({
  projectRoot,
  publishedRevision: revision,
  manualSync: {
    operationId, workspaceId, expectedDevCommit,
    delivery: { revision, releaseId, manifestSha256 },
  },
});
```

On `review_required`, only the returned isolated `nativeConflictRoot` is
resolved and reviewed. Dev remains unchanged. After review, the owner repeats
the exact same inputs; changed main/origin/runtime, expected dev or directory
identity refuses. UNKNOWN uses the same journal and effect readback. This
service input does not create a release tool or a public synchronization API.

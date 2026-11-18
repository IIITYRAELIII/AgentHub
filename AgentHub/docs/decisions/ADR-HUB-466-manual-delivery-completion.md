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
verifier and authenticated desktop-control `runtime-health`: live/ready and
exact PID/release must match the process observation. The endpoint descriptor
is stable around each probe and across verification; retained Ready lock/PID
alone cannot certify delivery. The reader reads exact main/origin, proves every
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

## Explicit reviewed manual-native compatibility

The removed generic native-review gate left a recovery-only argument reader;
it supplied no review input to manual-main-dev-sync-v1. Step-level owned
resolution can preserve legitimate compatibility while the full selected
consumer correctly refuses unaccounted automatic-path deltas. A step PASS is
not full-content acceptance.

Reuse the original native-merge-review-v1 inter-Stream message format for this
explicit manual compatibility case only. Task Git reads the existing catalog
and Task stores read-only: the original MCP receipt must be successful, have
accepted the message, bind its exact content hash and independent non-Astra
same-provider sender to the current RM receiver and owning Task. No caller
approval callback, scalar flag, new registry or new signature scheme is used.
Provider equality is read from the owning Task's current executor Stream and
active Thread, not inferred only from the reviewer and RM or a historical claim.
This current executor binding is rechecked when a stored proof is reopened.

The evidence binds the original manual identity/delivery, native namespace,
raw original journal hash, issued index/stages, all best bases and parents,
canonical automatic tree/inventory, candidate commit/tree, binary diff hash
and every full before/after entry. The service accepts that separate evidence
without changing manualSync business arguments or identity. The existing native
journal stores the original review pair/binding before continuation and carries
it through the full selected-content consumer and reopen. The consumer recomputes
the same binding and reauthenticates its genuine receipt; omission cannot erase
stored authority, and changing the candidate, context, entry or review refuses.
Delivery fences recheck current authority before normal dev CAS/readback.

Ordinary conflict-only sync/Test/Await keeps its existing behavior without a
review requirement. The full proof still rejects arbitrary extra code, missing
selected content, stale/foreign inputs and unaccepted additional changes.
Compatibility acceptance does not publish the source or change an UNKNOWN
effect disposition. The Root/application owner alone consumes the same original.

The actual manual main/dev history has multiple best merge bases. The retained
native virtual-base check accepts the manual policy as well as the historical
publication policy, preserving the complete sorted base set and all original
dev/result/operation bindings. No old identity is rewritten.

Two actual completion forms also require explicit support. A canonical Task
result may supersede a historical repository which must remain intact. The RM
can supply exact `retained_repositories` managed-path/head pins for only those
unrepresented repositories; they are recorded as retained, never published.
Canonical results/current source heads cannot be excluded through this input.
A manually delivered Task without a Test ref instead proves all owned managed
heads against the actual installation. RM `hub_task_status_update` Done with
`manual_delivery` and exact Task/status CAS uses the existing workflow journal,
preserving empty Test refs. Complete still requires Done and its own preview.

An old failed read-only manual Complete preview can have an UNKNOWN MCP receipt.
Reconciliation may classify only its exact hash-bound original business form,
with no confirm flag/token or other effect inputs. The read-only contract is
positive evidence of no business mutation; missing lifecycle rows alone are
not proof. Confirmed Complete originals continue to require their admitted
lifecycle/outcome evidence and cannot use this classification.

## Validation

`node --test tests/infrastructure/filesystem/manual-task-delivery.test.mjs`
covers Git containment, mismatched installation inputs, SQLite close/reopen and
idempotence, preserved ignored evidence, and isolated conflict/resolution with
later dev work and origin drift. The affected MCP case checks RM authority and
manual completion argument forwarding. A real dev CAS with a lost reply is
recovered through the same original journal. The public Complete test loses
the terminal MCP write after the SQLite outcome and reconciles that original
without replaying proof, closure or Git cleanup.
The affected readiness test uses the real authenticated local control transport
and covers absent/foreign control, PID/release mismatch, not-live/not-ready and
endpoint/instance drift. The unrelated-live-PID counterexample refuses with the
default installed verifier and status reader.

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

## Published standalone authority after a later manual installation

The actual 2.1.9-r2 installation and owned release clone use commit 43d272db,
while the protected registered primary remains at 1038b7d9 and lacks the new
commit object. Its old origin tracking is not current remote publication proof.
The existing primary-bound reader therefore refuses before completion, and
the old sync cannot compute both input histories in either repository alone.

The Task owner discovers the existing release-repositories layout/clone marker
from configured dataDir and the registered repository key. It holds the existing
release-git lease (before dev lease for sync), checks physical directory/marker
bindings, matching primary/release origins, clean main checkout and exact
main/origin plus fresh ls-remote origin main. It repeats this binding around
the existing full installed source/Host/authenticated Ready verifier. No path
is added to user inputs and no checkpoint/publication history is manufactured.
An existing invalid/stale/foreign clone refuses rather than falling back to the
old primary. The historical primary-only form remains for repositories with no
managed clone. Git children requested concurrently by the reader are serialized
only within its process-tree guard and joined before a refusal returns.

For sync, the existing owned immutable-object store imports the exact dev closure
from registered primary and exact published closure from the verified clone.
Its existing lease-held invocation math view combines those objects. All native
merge/base-set checks run there; the resulting isolated capture is self-contained.
The normal sync journal and original operation identity, expected dev CAS,
primary main/directory pin and repeated installation/origin proof remain.
Only the existing dev delivery owner writes dev after resolution. Primary and
published clone HEAD/index/tree/refs are retained. No raw primary repair, fake
Test or new release pipeline is involved.

The actual standalone checkout has CRLF-only Host C# source, while its Git blob
uses LF. The old raw-Git-only Host build hash refused this legitimate installed
package. The discovered clean clone supplies the compiled Host inputs: every
physical input must first match its exact published Git blob through the existing
sourceMatches line-ending/binary policy; their exact build hash must then equal
the installed manifest-bound Host source hash. No hash/Host verification is
skipped and no Git source code is executed as a verifier.

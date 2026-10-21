# ADR-0126: Versioned cleanup through artifact owners

Status: proposed; source review and normal delivery remain required.

## Context

The user requires old Hub copies to be removed and their accumulation prevented
for every updated installation. Task text is not the dominant payload: native
Git transports/clones, dependency trees, unfinished work and migration artifacts
have distinct owners. Age, a directory name, and clean Git status do not prove
that a directory is disposable. In particular native worktree removal can erase
ignored WIP without requiring force.

## Decision

Schedule versioned storage maintenance from normal installed runtime timers after
readiness, on every start (including the first explicit start after an update),
then every six hours. Installation itself does not start/restart the Hub. Dev,
Test Contour, recording and acceptance-isolation runtimes construct no production
cleanup owner. Active user work defers background admission.

Reuse maintenance_operations for bounded cursors and original artifact intents;
do not introduce a daemon, an external automation, a second cleanup ledger or a
user turn. The runtime-scoped storage operation is not a dispatch reservation or
a restart marker. Each owner supplies discovery, preview, guarded effect and
reconciliation. Persist the discoverable child intent before admitting an effect.
An ambiguous outcome remains attached to that SAME child; one such resource does
not starve every other owner. Stop new admission on shutdown and drain the actual
in-flight owner before closing stores/releasing the instance lock. A failed drain
does not grant replacement admission.

Policy v1 retires only redundant task-native-merge source.bundle transports from
completed, durably published Tasks. The Task Git owner supplies its existing
lease/process guard and fresh publication preview. Preserve the independent full
repository, its refs/objects, merge.json, resolution evidence, Task history and
all worktrees. Save advertised bundle heads in the existing maintenance intent.
Verify all advertised object roots are connected in the independent repository;
reject alternates, shallow captures, dirty work, incomplete merges and drift.

Delete the exact single-link transport using a retained Windows handle, with
physical ancestors held without delete sharing, no reparse traversal, no named
streams, exact volume/index/size and SHA-256. Resolve configured compatibility
aliases before that boundary. Unsupported platforms defer; there is no pathname
unlink fallback. Recheck link count after hashing; this remains last-observed
admission, not an atomic link-count/delete CAS.

New native merges stream only selected base/result ancestry from Git into an
already-owned output descriptor, with private advertised bundle tips. The
documented bundle header supports SHA-1/v2 and SHA-256/v3. They no longer include
all unrelated source refs. No bare pool, alternates or recursive scratch cleanup
exists: a plain directory substitution cannot acquire deletion authority. A
failed/partial output is preserved. The resulting bundle and consuming clone are
full and independent; source refs/configuration are not copied or modified.

New permanent release generations use the same descriptor-owned pack stream for
exact main/base/selected-result ancestry. An optional main alias must name an
included exact input; default native-merge headers remain unchanged. Ordinary
release clones and refresh fetch main only and retain the original exact-object
fetch for missing selected results. Prepared candidate promotion/freeze, source
provenance and composition guards remain authoritative. Existing bundles are
reused unchanged; an interrupted or unknown body is not overwritten on retry.
This prevents new permanent copies of unrelated branch payloads without adopting
or pruning old clone refs. Disposable composition validation uses the same
selected main/base/result capture and existing invocation-local cleanup; it
cannot accept a Task or replace a prepared/frozen holder. Historical leftover
adoption and changes to that cleanup boundary remain outside this decision.

## Policy v2: explicitly retired runtime bodies

The previous eager install cleanup deleted every body except current/previous;
an actual isolated install/prepare/install sequence demonstrated loss of an
unrelated prepared version. Installation now records exact verified runtime
custody in the existing current.json pointer and never performs that sweep.
Known previous custody becomes retired only when it leaves current/rollback.
Legacy/unfamiliar IDs are not adopted by age or absence from two pointer fields.
Current, rollback, running, unselected prepared bodies and their referenced
source roots stay pinned. Same-current repair preserves rollback; rollback swaps
known bindings. Unknown metadata and a full bounded retirement queue preserve
payload and explicitly defer reclamation. An admitted partially retired ID
cannot be prepared or selected again.

Prepare, installation, rollback and retirement share a physical-root scoped
installation lease, including compatibility aliases. The existing pointer owns
retirement identity; the existing maintenance child owns the original operation.
Before native work the pointer binds that same child and pruning phase. Native
custody holds the exact root/creation, physical ancestors and manifest; complete
membership preflight refuses unknown names, streams, links and reparse entries.
Each removed asset is size/hash/link checked through its own retained deletion
handle. At most 64 files/256 MiB are removed per cooperative ten-second batch
after bounded metadata preflight; there is no abandoned destructive timeout or
recursive fallback. Changed later assets remain with the original partial
operation even if earlier exact reproducible assets were already removed.
The manifest is last, and directories/root must be empty with no named data.

Known partial progress is not completion or a new operation. Subsequent batches
reconcile the SAME admitted child/root/manifest under fresh pins; unknown results
stay pending. The scheduler appends this one reviewed owner to its known v1
registry while retaining all original pending children, bindings and observations.
An older policy or an unknown registry/version defers without clearing custody.

## Policy v3: completed release-generation transports

The release operation owner exposes read-only eligibility only for its exact
completed current generation. The immutable generation identity, applied
validation/finalization inputs and every approved target's published outcome
must agree. A failed, waiting, superseded or unknown generation is not retired
by age. The release filesystem owner holds the existing per-generation lease,
also shared by preparation and canonical discard. It verifies the generation's
identity and marked independent clone against that proof and the frozen
checkpoint/manifest. Its full local object graph must contain all advertised
bundle roots. Original commit objects must remain reachable from retained Git
refs/HEAD. Original annotated tag objects (including tags pointing to tags)
require the exact advertised retained ref to resolve to the same unpeeled OID;
reachability of the peeled commit does not preserve a tag's metadata. Missing or
renamed tag refs and unsupported tree/blob roots conservatively retain the bundle.
The same original-root check runs before the effect. Unanchored objects are not
sufficient because later Git GC may prune them; no new keeper refs or automatic
Git mutations are created. Alternates, shallow/partial clones, changed work or mismatched
capture metadata refuse.

This policy removes only the exact redundant source.bundle through the existing
native single-file transport custodian. The generation root, repository, refs,
checkpoints, manifests, receipts, dependency trees and ignored/untracked useful
work are never swept. A missing bundle under the same original binding is
reconciled as already removed; an unknown present bundle remains with its
original maintenance child. No new release/publication operation is created.
Known v1/v2 registries may append this owner while preserving pending identities;
unknown registries/versions and rollback to an older registry defer unchanged.

## Boundaries and remaining work

Each pass admits at most three units and checks a 20-second cooperative budget
between units. It does not abandon an active filesystem effect at a timeout or
claim the whole pass has a hard 20-second deadline. Metadata, head lists and file
size have separate bounds. Logical bytes are separate from observed filesystem
free-space deltas; concurrent writers make the latter observations, not exact
per-operation allocation attribution.

These policies do not automatically delete legacy migration archives,
unpublished/unknown integration captures, release repository/generation bodies,
current/running/rollback/prepared runtime versions, attachments, receipts, audit
evidence or dependency/WIP directories. They retain their existing owners and
must receive separate eligibility/effect adapters before the policy expands.
The v3 transport exception does not retire those bodies. Task cleanup explicitly refuses ignored local data, including reproducible
dependencies until their own owner proves retirement; --force is not that proof.

Unknown admitted transports that remain present are retained for authoritative
owner reconciliation. An absence observed with the same capture/publication
binding reconciles the original intent; no second delete is submitted. This is
safe crash handling, not a claim that every retained legacy artifact is already
reclaimable. Physical relocation/C-original pruning is a separate accepted
operation and cannot be credited to this source-only policy.

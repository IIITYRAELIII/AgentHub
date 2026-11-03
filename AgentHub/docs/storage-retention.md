# Native storage retention

An explicitly authorized operational consumer can call the SAME service's
`runApproved` with at most three exact previously reviewed owner previews. Each
binding is checked again by its artifact owner before admission. This path uses
the existing storage lease, maintenance parent/pending children and owner prune/
reconcile; it performs no discovery and does not advance the automatic cursor or
reconcile unrelated pending artifacts. Readiness, busy, isolation, stopping and
admission budgets remain effective. A changed binding for an admitted UNKNOWN
cannot replace its original authority or start another effect. No public tool,
alternate cleanup database or generic pathname-delete API is added.

Normal installed Hub startup schedules policy v3 after readiness and periodically
every six hours. The installer does not start the application to run cleanup.
No per-user external scheduled task or Codex automation is required. Test Contour,
recording, release acceptance and development runtimes do not run production
cleanup. Active user turns defer admission.

The production composition passes the existing Task board, Task/Release Git
services and release-operation proof owner into the provider application, then
passes the SAME retention service into execution bootstrap. That instance owns
the deferred timer, cached health and shutdown drain. Startup coverage runs the
actual installed-mode factories with private data and a fake provider; it does
not replace the Git services with test-only retention adapters.

Focused startup/lifecycle regression:
`node --no-warnings --test tests/composition/storage-retention-startup.test.mjs`.

The health diagnostic `storageRetention` reads cached bounded status only. It
reports policy version, discovery completion, pending original intents, removed
artifact count, known partial batches, observed prior removals and retention reasons. Status/Task/board
reads do not open the cleanup store or enumerate files. Durable child outcomes
retain the preview, original identity, logical bytes and free-before/free-after
observations. A free-space delta can include concurrent allocations and is not
a physical allocation estimate based on summed logical file sizes.

The first owner handles redundant `task-native-merges/*/source.bundle` only when
the Task is completed and its existing publication owner proves the exact
result/current work published. Its independent repository must be full, clean,
connected and free of borrowed objects. The bundle's advertised heads are retained
in the original maintenance intent. Repositories, refs, merge journals, WIP,
attachments and historical results are preserved. An open, dirty, unpublished,
unknown, changed, oversized or unsupported artifact is retained with a reason.

The publication preview resolves the exact repository entry in a multi-repository
publication. If origin/main later advances, the recorded publication must remain
its ancestor. The later tip does not grant cleanup authority to later Task work:
the result, branch and worktree are checked against the durable published commit.
An unmatched repository cannot borrow the record's top-level revision. This
corrects false retention after repository separation without expanding which
artifact kinds the owners may delete (ADR-HUB-385).

Each pass has at most three units and a cooperative 20-second admission budget.
Hashing/deleting one admitted transport may finish later; shutdown drains the
actual owner and does not pretend a timed-out child stopped. Discovery is a flat
owner-directory read, not a recursive archive/history scan. A lost reply is
reconciled through the same operation. Unknown present files are preserved;
there is no retry that invents a fresh deletion identity.

New native merge transport excludes unrelated source refs. Existing large broad
transports become eligible only under the same completed/published owner checks.
New permanent release-generation transports also capture only exact main/base/
selected result ancestry, and ordinary release clones/refresh fetch main only.
The existing exact-object fetch supplies missing selected results. An advertised
main alias preserves the normal clone entry point without mutating source refs.
Existing generation bundles are reused byte-for-byte, never rebuilt to shrink
them. Disposable composition validation uses the same selected main/base/result
capture while retaining its existing invocation-local temporary cleanup. This
does not authorize deleting unknown historical failed leftovers or any legacy
clone's refs/objects. No new periodic Git GC is introduced.
Git's complete pack is streamed into an already-owned bundle descriptor; no
temporary bare pool is recursively deleted. The supported [bundle format](https://git-scm.com/docs/gitformat-bundle)
uses private advertised tips, including dangling results. Failed/partial output
and substituted directories are preserved instead of being recursively removed.
Other legacy archives, fixture directories, runtime versions and dependency trees
are not newly authorized by policy v1. The implementation must add their existing
owners' previews and retirement proofs before expanding automatic deletion.
See [ADR-0126](decisions/ADR-0126-owned-background-storage-retention.md).

Policy v2 also retires runtime bodies explicitly recorded by the installation
owner after they leave current/rollback. Installation preserves unrelated prepared
versions and does no eager directory sweep. Legacy versions are not adopted by
age. Current/rollback/running bodies and prepared manifests' source dependencies
remain pinned. Prepare/install/rollback/retirement share the same physical-root
lease, including a logical compatibility alias. Unknown custody is preserved.

Retirement is recorded against the SAME maintenance child before native work.
Each batch removes at most 64 known files/256 MiB, with a cooperative ten-second
budget after bounded metadata preflight. Each asset is hashed through its held
deletion handle; unknown names/streams/links/reparse entries refuse. A partial
batch keeps its root identity and immutable manifest for original-operation
continuation. A lost reply does not launch another deletion identity. Changed
later bytes stay preserved even if earlier exact assets were already removed.
The manifest and empty directories/root are last; no recursive fallback exists.
Policy migration preserves all v1 pending transports, and older code defers upon
the unfamiliar owner registry rather than clearing those operations.

Policy v3 appends release-generation transport retirement. The original release
owner must report its exact current generation done, every approved publication
target applied/already-applied and hash-bound validate/finalize receipts applied.
Waiting, failed, superseded and UNKNOWN generations remain retained. Only the
redundant `release-gens/*/source.bundle` is eligible: its original identity,
frozen checkpoint/manifest and marked independent clone must match the published
candidate. All advertised objects must be locally connected. Original commit roots
must be reachable from retained refs/HEAD; original annotated tag OIDs require
their exact advertised ref to remain bound to that same tag object, including
tag chains. A published peeled commit alone does not preserve tag metadata.
Renamed/missing tag refs and unsupported tree/blob roots are conservatively
retained; no keeper refs are created. These checks run again before deletion,
so ordinary Git GC cannot discard the admitted roots; shallow, partial,
alternate-backed or dirty clones refuse. Ignored WIP is preserved because no
repository or directory body is removed. The native single-file custody owner
performs the same exact-identity/hash/streams/link checks as other transports.
Git inspection disables lazy fetch, replacement objects and optional locks; no
missing object is fetched to manufacture local availability. An unsupported Git
option defers this owner safely. See [Git's global options](https://git-scm.com/docs/git).
Legacy grafts and ambient object/index/repository overrides also defer; proof
must describe this independent repository's ordinary local object graph.
Generation creation, discard and this retirement share the original per-generation
lease. A lost reply reconciles that SAME child; a still-present bundle is unknown
and is never submitted as another delete. Registry migration from known v1/v2
preserves every pending child. Legacy root trees, dependency caches, migration
archives and failed-generation bodies receive no deletion authority from v3.

Focused validation from AgentHub:

```text
node --no-warnings --test tests/application/storage-retention-service.test.mjs tests/composition/storage-retention-composition.test.mjs tests/infrastructure/filesystem/native-merge-transport-retention.test.mjs tests/infrastructure/filesystem/sealed-transport-delete.test.mjs tests/infrastructure/filesystem/selected-git-bundle.test.mjs
node --no-warnings --test tests/infrastructure/filesystem/runtime-release-retention-policy.test.mjs tests/infrastructure/filesystem/runtime-release-retention.test.mjs tests/infrastructure/filesystem/sealed-runtime-release.test.mjs
node --no-warnings --test tests/infrastructure/filesystem/release-generation-transport-retention.test.mjs tests/application/storage-retention-service.test.mjs tests/composition/storage-retention-composition.test.mjs
node --no-warnings --test --test-name-pattern="retention proof|release operation acknowledges" tests/application/release-operation-service.test.mjs
node --no-warnings --test --test-name-pattern="cleanup preserves ignored WIP|published cleanup|isolated native merge|native Test retains" tests/infrastructure/filesystem/task-git-workspace.test.mjs
```

Windows fixtures exercise actual native deletion and real Git transport. Use an
isolated disposable TEMP/TMP directory on the intended fixture volume. Tests do
not read/delete the installation's original migration cohort.

Native API references: [GetFileInformationByHandleEx](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getfileinformationbyhandleex),
[FILE_STREAM_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_stream_info),
[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).
Git's [rev-list --quiet](https://git-scm.com/docs/git-rev-list) tests object
connectivity without printing a full object inventory.

Canonical maintenance writes use the existing bounded asynchronous SQLite
mutation queue. Only one exact SQL create/transition/settlement is retried on
SQLite contention, with its original ID/CAS and current lease; artifact effects
are never inside that queue. Ready/release/stop state is rechecked after queued
admission. A failed write or ambiguous artifact outcome preserves the existing
original for ordinary reconciliation rather than creating a replacement effect.
# Native object reuse and whole-capture retirement

ADR-HUB-385-owned-native-objects adds an explicitly bound new Task-native storage
mode and a separate :repository resource on the existing native retention owner.
Legacy bundle approvals/children stay bundle-only. A complete verified object/raw
archive and original pruning intent precede any repository-file deletion; unique
WIP/UNKNOWN/current/prepared and borrowed-source ODBs remain pinned. Source/Task
acceptance, production installation and actual reclaimed bytes are separate
outcomes. Dependency/release/audit categories are not implicitly disposable.

## Retained source after completed generation retirement (ADR-HUB-385)

A runtime/prepared source remains pinned by its declared and physical path and
by every actual Git/commondir/recursive alternate object store. If the generation
owner has removed its live identity and Git metadata but left source files,
absence of Git alone is not custody proof. Only the exact existing generation
archive, stable plain identity/checkpoint/raw manifest, deterministic original
generation/repository paths and the SAME canonical completed-generation reader
may establish that this remainder has no Git object-store borrower. Its exact
completed candidate must match the runtime publicationRevision and sourceRoot.
This proof keeps the whole source remainder, WIP, prepared body and original
archive; it authorizes no source deletion or UNKNOWN settlement.

Missing/changed/nonterminal/foreign/superseded proof, redirected paths and ambient
Git history/storage inputs refuse. A restored Git marker/alternate borrower or
late ambient input invalidates the proof at the fresh boundary. Reads retain
the existing installation custody and exact per-generation lease with bounded
250ms admission; there is no global reservation, new ledger, cap or deadline.
The existing canonical readGeneration port passes through the same native owner
registry. No public tool argument, release receipt, publication identity or
runtime manifest is rewritten. See ADR-HUB-385-retired-generation-source-custody.

Native missing-object pack encoding keeps Git's object/delta reuse instead of
forcing every historical blob into a separate encoding. Optional delta search
uses window 10, at most 8MiB of search memory and one worker; these are encoding
settings, not object/content admission caps or a total process-memory promise.
The existing Git deadline and original operation identities remain unchanged.
Only a new transfer without an existing output uses this encoding. An existing
incomplete or invalid pack remains under its SAME unknown original and is never
overwritten/replayed by this correction. A real link/allocation-aware fixture
checks two native consumers, complete archive objects/tags, leased fixture GC
and a later missing-only import; fixture bytes are not production savings.

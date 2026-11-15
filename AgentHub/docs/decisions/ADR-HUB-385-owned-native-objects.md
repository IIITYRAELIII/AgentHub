# ADR-HUB-385: owned native objects and archive-first retirement

Status: proposed implementation; independent exact source/current and operational
review remains required before applying the new policy to accumulated data.

## Problem and ownership

Task-native composition previously streamed a complete selected-history bundle
and cloned it into each independent capture. Bundle-only retention deliberately
left every repository and expanded working file. Closing a Task did not retire
those retained bodies, and ignored WIP/dependencies were correctly excluded from
ordinary Task cleanup. These boundaries explain the accumulated copies; a size
report or a small bundle cleanup is not completion of the broader cleanup.

The existing TaskGit native intent and native-merge-transport retention owner
remain authoritative. No new database, capture registry, release publisher or
parallel reconciliation lane is added. The existing maintenance-operation store
holds the object-store resource, exact imports, consumers, archive receipts and
same retirement child. SQL retry queues wrap bookkeeping only, never Git/native
artifact effects.

## New native provisioning

Only new Task-native records bind owned-immutable-git-objects-v1. Old records and
identity serialization remain unchanged. Generic release composition and the
published-main/dev synchronization policy do not enable this provisioning port.

One bare owned store contains immutable Git objects and private internal refs.
The producer enumerates exact source closure and imports only missing OIDs using
the existing owned Git streaming output descriptor. Incremental strict indexing
runs against that owned store, so existing parent/tree objects are available.
Complete import/ref custody precedes the consumer. Physical resource replacement,
foreign output, ambient Git history/storage inputs or an unproved partial output
refuse; no silent clone/copy fallback or source ref/config mutation is allowed.

Durable successful imports and archives retire only their deterministic owned
pack/index intake aliases after complete object/ref verification. SAME successful
original re-entry finishes that retirement after a lost reply, without a new
operation or replaying transfer. Both aliases must still be the exact physical
files held by the owned pool; the whole pair is preflighted before unlinking.
Foreign/replaced aliases refuse, and active consumer links remain untouched.
Archive-lease entry completes this intake retirement before owned GC or deletion,
so obsolete input names cannot pin a second pack encoding after repacking.

Every capture has a real separate .git, config, HEAD, refs, index and working
directory. Only immutable pack/index/reverse-index/loose object files hardlink to
the owned store. This requires same-filesystem hardlink support; failure is an
explicit refused provisioning, not acceptance with a different storage policy.
Unlinking/repacking the store cannot break a consumer: its own links retain data.
Mutable dependency trees are not implicitly made hardlinks by this policy.

## Complete archive before retirement

The new :repository resource is distinct from the legacy bundle candidate and
cannot reuse its approval/maintenance ID. Admission requires a unique original
integration record, exact known terminal canonical Task/MCP evidence, completed
published Task/result, completed native journal, clean independent repository
and no ignored/untracked or unexpected work. The existing Task/process guard
and runtime installation lease protect source/consumer lifetime. Current,
rollback and every unretired/prepared manifest's source and recursively declared
read-only alternate object stores remain pins.

The archive preserves ALL local object identities, including unreferenced proof
objects, not only HEAD ancestry. Storage commits anchor every original commit
DAG; original tags get owned refs, and every blob/tree is retained in a storage
tree. Raw working files and Git administrative files are Git blobs with exact
paths/physical identities/SHA-256 in the archive manifest. Pack/index encoding
is reconstructible from the retained complete object set; it is not kept as a
second full opaque history copy. These storage commits/refs never become Task
results, agreed bases, publications or native review capabilities.

Archive intent precedes transfer; confirmed archive and original pruning intent
precede the first destructive batch. The same canonical child supports positive
partial progress and a lost native reply. An unknown or changed binding remains
unknown; late user data stops before another deletion. Repository deletion
preserves merge.json, integration records, source branches/refs, original
receipts and reviews. Legacy source.bundle must be retired independently first.

An admitted child can lose installation admission before archive intake begins.
Its missing intent is neither proof of no effect nor a permanent recovery veto.
The SAME owner repeats the complete independent-source/publication/inventory
preflight and requires exact equality with the original binding before deriving
and persisting that child's deterministic archive intent. Incomplete or changed
source cannot enter this path. Lost intent replies use the committed row and
the same archive operation; all archive verification, final object lease and
pruning-intent/deletion checks remain in place. No pending slot is cleared by
interpretation, no cap/deadline changes and no replacement original are needed.

The native Windows boundary holds no-follow ancestors/root, checks every
allowlisted file identity/hash and ADS, rejects foreign links and late entries,
and joins each bounded child. Intentional immutable object links use handle
disposition without changing attributes shared by another consumer. There is
no rm/recursive-delete fallback.

Every archive reuse checks the complete original object/type set and its actual
reachability, including the exact separate original-tag anchors. The final
destructive read and its native batch hold the same object-store lease; owned
GC/import/ref updates cannot intervene. A lost/changed anchor or missing object
keeps the SAME retirement child unknown and retains the source. Both public
TaskGit archive/record entries apply their existing recording exclusion before
reading arguments or lease ports.

## Historical reads and limits

The historical Task reader locates the exact archived child, rechecks its Git
objects/raw capture and uses the same pure graph/content core. Its existing
separate source-history checks remain. Live original execution refuses an
already retired capture instead of recreating or retargeting it.

Proof math uses an invocation-owned bare scratch with an alternate to the archive
only while the object-store lease is held. No proof objects, index or mutable
refs are written into the archive. The scratch is removed through the same
handle-bound boundary after verification, preserving failures and foreign data.

Allocation evidence includes the selected old roots and new pool using unique
physical file IDs/FileStandardInfo.AllocationSize. Scheduler cumulative logical
counters and unrelated volume writers do not establish reclaimed allocation.
Earlier bundle removals retain their original attribution and are not counted
again. Release copies, ignored dependency trees, moved audit originals and
independent open/UNKNOWN Tasks still require their own exact owners/evidence;
this policy is not a generic disk cleaner or a claim that all measured bytes
are disposable.

## Focused validation

Real Git/SQLite tests cover two native checks sharing history once, separate
indexes/refs, later missing-only input, pool removal/consumer GC, original
consumer lost reply, full repository archival/deletion, dangling proof retention
after GC, partial/lost native deletion and late useful-WIP refusal. Physical
checks use the Windows sealed helper, not free-volume changes.

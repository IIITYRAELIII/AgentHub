# REL-001 — Task-backed Workspace release

## Authority and identity

For a release-enabled Workspace, the Dashboard `Task` aggregate is the live
authority for ownership, readiness and release completion. Its `workspaceId`
and `streamId` identify the Workspace and executor Stream. The durable Task
`row_revision` is the CAS version for every release-relevant mutation.

Every numbered file-changing Task owns a local branch whose name is exactly its
stable human-facing Task number, for example `HUB-11`, and a managed worktree.
Legacy unnumbered Tasks retain `agenthub/task/<taskId>/<repositoryKey>` until
their next managed preparation renames the branch.
`hub_task_claim` and `hub_task_start` return that worktree. All Task changes must
be made there. Provider turn identity remains journal metadata and is not a
source of file ownership.

Task launch persists its request owner, planned destination and row-revision CAS
before creating a Stream, Thread or delivery. While a new destination is not yet
a catalog member, the awaited `task.starting` event is Workspace-scoped, carries
the destination in its payload and deduplicates by Task/request identity. A
rejected event therefore leaves an exact prepared launch without producing the
downstream effects. Startup never launches it automatically; the original MCP
receipt becomes `unknown` rather than a replay lease. An Architect may explicitly
cancel it only with exact caller, Task owner and revision evidence plus proof that
the planned Stream and admitted delivery content do not exist. Cancellation
first wins a durable per-Task `prepared -> cancelling` CAS against the launch
runner's `prepared -> admitted(attemptId)` CAS. Only the admitted attempt may
enter Stream, Thread or delivery effects. An already admitted launch makes
cancellation fail; a successful cancellation fence makes every old or concurrent
runner fail admission before effects. Cancellation then terminalizes the
original receipt before clearing launch ownership. These SQLite CAS transitions
arbitrate across connections/processes without a global or timeout lock. Claiming a
still-`starting` Task is rejected; after cancellation the Task can follow the
normal existing-Stream start or claim path without the old request taking it
back.

Each managed Task worktree enables sparse checkout at the Git boundary before
it is returned. When the selected project root is a strict descendant of the
source worktree, cone mode uses that exact repository-relative subtree as its
only scope and the returned `projectRoot` is the matching directory inside the
managed worktree. When the selected project root is the repository root, the
explicit non-cone pattern is `/*`: the whole repository is the selected
project, so the boundary remains in sparse mode without guessing a narrower
owner or omitting future top-level paths. Scope resolution fails closed if the
selected root escapes its source Git worktree.

Before a managed Task worktree is returned or its provider is launched, Agent
Hub prepares every tracked `package-lock.json` inside the selected sparse
project with lockfile-locked `npm ci`, including declared development
and optional dependencies. Platform-incompatible or otherwise failed optional
packages may be absent as permitted by npm; if an optional package is present,
its installed identity must match the lockfile. Each `node_modules` is an
ordinary local directory below its package root in the managed worktree;
external links and junctions, including links to the primary checkout, fail
closed. A marker inside the ignored dependency
directory binds the policy and lockfile hash to a bounded proof over npm's
local hidden lockfile plus a deterministic enumeration of physical package
roots, including scoped and nested packages. The physical and hidden-lock sets
must match, and every package's canonical lock/path name, `version`,
`integrity`, `resolved` and link identity must match the declared lock wherever
those fields apply. A non-link alias uses the package name recorded by its lock
entry; an ordinary package without that metadata uses its canonical path name.
For a local `file:`/link entry, the resolved target must remain inside the
managed project after `realpath`, and its physical name and version come from
the target lock entry and target `package.json`, not the link's alias path. npm
metadata entries are not package roots. Prisma-generated `.prisma` service
state is accepted only beside an installed lock-backed package whose resolved
source, installed-lock and physical identity is genuinely `@prisma/client` at
the same `node_modules` level; an npm alias merely occupying that path does not
qualify. Its root contains only the local `client` directory;
the bounded generated tree contains no hidden entries, nested `node_modules`,
links, junctions or special files, remains inside the canonical managed project
after `realpath`, and contributes deterministic structural evidence to the
installed-state marker. Unknown hidden service entries still fail closed.
Containment compares resolved candidates with canonical physical project and
package roots, so an equivalent Windows long-name/8.3 alias is not mistaken for
an escape while a different physical target remains rejected. This makes
repeated preparation idempotent without accepting extra packages, impostors,
or stale or malformed package metadata, while a changed lockfile requires a
fresh install. Installation or validation failure fails Task worktree
preparation instead of returning a falsely ready workspace. Markers contain no
checkout path or other machine-specific location. Multiple
tracked lockfiles are prepared serially under one Task/repository interprocess
lock; untracked lockfiles and lockfiles outside the selected sparse project are
ignored.

Dependency preparation remains inside the existing Task lifecycle and managed
dev leases and adds the per-Task/repository dependency lock to that same owner;
it does not create a second process owner. The combined lease signal and
durable ownership assertion fence every npm operation. npm runs through the
Task lifecycle process-tree guard, so lease loss, cancellation or timeout must
stop and prove completion of the entire descendant tree before preparation can
return. An unproven stop leaves the persistent guard in place and blocks the
next owner until operator reconciliation. Recovery joins the exact unknown MCP
request, pending lifecycle transition, Task revision, repository and guard ID
under the Await, Task and repository locks. The repository lease remains held
from durable classification through guard recovery, resumed Git work, lifecycle
terminalization and the original receipt CAS; nested Git steps reuse that exact
lease instead of releasing and reacquiring it. A caller confirmation is not process
evidence. A guard without a captured process identity is recoverable only when
`Win32_OperatingSystem.LastBootUpTime` postdates guard creation; this bounded
recovery deliberately provides no weaker non-reboot proof. Verified recovery
evidence is persisted before removing the guard, so a crash can reuse only the
same guard identity. Reconciliation first classifies durable state: exact
pending Git work resumes, while an exact workflow outcome, rollback or failed
transition only settles the original receipt without replay. A mismatched or
mixed state remains unknown. It never reopens an unknown receipt or replays the
effect under a new request ID. Ownership is rechecked
after external and validation awaits and immediately before and after marker
promotion; losing it prevents a falsely prepared result.

Dependency proof traversal is bounded before queue growth and directory
expansion: each source or hidden package lock is at most 16 MiB, with at most
16 nested `node_modules` levels, 10,000 physical package roots, 5,000 entries
in one scanned `node_modules` or scope container, and 50,000 directory entries
in total. Source locks, hidden locks, markers and package metadata are read from
one opened regular-file handle: its size is checked before allocation, reads
use bounded chunks, and identity, size and modification time are checked again
before close; contents are never fetched through a second path-based read.
Source package entries are collected iteratively; every count, depth and
structural entry is checked before collection growth. Source preflight accounts
only for package roots and required scope containers derived from the lock, so
each declared structural limit remains reachable; service metadata is measured
only by the physical scanner.

Any source or physical overflow is a preparation error, never a cache miss. A
post-install validation failure writes bounded durable evidence keyed by the
exact policy and source-lock hash. Evidence is flushed through a temporary file
in the same directory and atomically renamed over its destination. Temp-name
collisions receive at most four new random-name attempts; only a temp file
successfully created by the current writer may be cleaned up, and exhaustion
leaves the destination unchanged. Repeated preparation never trusts that
marker alone: it independently repeats bounded physical validation and returns
a recorded error without another `npm ci` only when an allowlisted stable code
and state exactly match the reproduced validator outcome. A valid repaired tree
removes forged or stale failure evidence. A changed lock or policy permits one
retry; without matching evidence, a reproducible physical overflow still fails
before npm, preventing a crash-before-first-marker reinstall loop. Recovery is
to repair or remove the invalid `node_modules` tree, or change the lock/policy;
deleting only the failure marker does not authorize another install into the
same overflowing tree. Invalid trees are never marked prepared, and Agent Hub
does not return the worktree or launch its provider without an honest result.
This local integrity cache does not claim protection from a process that can
modify the source `package-lock.json` itself.

Repeated preparation reapplies the same scope idempotently. An existing
managed Task worktree is migrated in place without reset, clean, branch/base
movement or snapshotting: tracked and untracked dirty state must remain
unchanged, including dirty paths outside the new sparse scope. Sparse
configuration is worktree-local; shared and managed `dev` worktrees are not
changed by Task preparation.

One provider turn may perform multiple sequential Task operations. Each claim
is durably identified by its MCP `request_id`, and terminal evidence resolves
the exact `(provider, thread, turn, operation)` binding rather than a
turn-global Task. At most one unterminated Task write operation may exist for a
provider turn. A new explicit claim operation
atomically terminates the preceding binding before it activates the next Task,
so sequential switches are allowed without overlapping active writers.

The persistence compatibility boundary is the absence of `operation_id` on
the binding or work-log table. Store startup rebuilds only that legacy shape,
assigns deterministic `legacy:<taskId>` operation identities and installs the
active-operation guard in the same migration. The rebuild may be removed only
after every supported database version is guaranteed to contain operation IDs.

## Test and acceptance integration

In a Workspace with `settings.releaseWorkflowEnabled === true`, moving a Task
to `testing` snapshots its complete dirty worktree into a local result commit
and merges that result into the shared local `dev` branch. Later transitions to
Await or Done reuse that exact Test-owned result and never take another snapshot.
Git derives the stable changed-file
set between the Task base commit and Task result commit:

`Array<{projectRoot,path,operation:"added"|"modified"|"deleted",turnId:null|string}>`.

`projectRoot` is the canonical Git repository root and `path` is relative to
that root. Git defines the base, result, operation, blobs and patch. Provider
receipts, final text, timestamps and shared dirty trees are never ownership
fallbacks.

The exact local `refs/heads/main` commit is the accepted repository baseline.
Fetching or moving `refs/remotes/origin/main` is observation only and never
changes Task, dev, plan or preflight authority. A new Task atomically verifies
local main and creates its immutable base ref at that exact commit; it never
starts from rolling dev content or a newer remote-tracking tip. Existing Task
base refs remain unchanged. Missing local main fails closed rather than choosing
`HEAD`, dev, publication state or a remote fallback.

Ordinary Task preparation, integration and release evidence only recover and
inspect managed `dev`; they do not fetch or synchronize main. Existing dev must
be clean and contain the accepted local baseline. Explicit post-publication
main-to-dev synchronization requires the exact durable published revision and
also requires local main to equal it. If those exact inputs diverge, or the merge
conflicts, the operation fails or reports `manual_required` only after proving
the old dev head and clean worktree were restored. The owner never checks out or
updates the registered primary worktree, creates `origin/dev`, or treats a
remote ref movement as acceptance. See ADR-0040.

The one-time bootstrap for an already-diverged managed `dev` is itself a Task
result: under the same Task and dev locks, the snapshot owner accepts a pending
Task-worktree merge only when its exact `MERGE_HEAD` is the current managed dev
head. The accepted Task result must contain one unique first-parent merge whose
second parent is the exact current `main`. When ordinary main-to-dev integration
conflicts, the owner constructs an unreachable bootstrap commit `B` with exact
ordered parents `[oldDev, main]`. Its automatic merge bytes come only from those
parents; each conflicting code path is replaced only when the Task-local proof
matches the index's dev/main mode, type and object identities and the accepted
Task result exactly. `CHANGELOG.md` may use the accepted Task snapshot only as
the excluded release-history path in this same atomic integration. A second
unreachable commit `C=[B, TaskResult]` must reproduce the complete accepted Task
tree, including Task-only files that are absent from `B`.

Only one compare-and-swap publishes `dev` from `oldDev` to `C`; neither `B` nor
partial index state becomes a visible dev head. Durable transaction evidence
written before that CAS distinguishes no effect from the exact committed effect:
recovery restores the worktree to `C` only when the ref and ordered parents still
match, and otherwise fails closed. Interruptions before the CAS restore the exact
old dev head, index and worktree. The registered primary checkout is never
changed. See ADR-0039.

A successful Test integration records only the deterministic Task branch and
its accepted immutable result commit on the Task. The base ref and changed-file
set remain Git data and are derived when a release plan is read. A conflict is
returned with exact conflicting paths only after the Task merge abort proves the
pre-merge dev head and clean status were restored. Abort failure or partial
restoration throws instead of reporting an ordinary conflict. An empty diff is
explicit `no_result`, even when the Task HEAD is already ancestral to `dev`, and
cannot enter Test or Await. Snapshot, merge, ancestry verification and recovery
complete before one row-revision CAS atomically replaces Git references, updates
the exact operation binding and changes workflow status. In a release-enabled
Workspace, every workflow transition is serialized with the Workspace release
lock. Test owns the immutable snapshot and successful `dev` integration proof.
A transition into or out of Await changes only accepted release membership and
invalidates any older plan/candidate identity through the Task row revision; it
does not compose `PreRelease`. Any Git, recovery or CAS failure therefore
preserves the prior release membership, while an unrelated selected-delta
composition conflict cannot roll back an already proven Task result.

Moving a Task to `awaiting_implementation` records that its exact immutable
result is accepted for a future release. A ready Await Task requires a valid
exact result and successful `dev` integration. Missing or ambiguous integration
ownership, an effective delta that cannot be applied to the approved main base,
or a dependency on work owned only by Test/In Progress/New blocks the later
explicit candidate preparation, not acceptance of the already proven Task.
Such a dependency is never silently included; the user resolves it individually,
normally by combining the dependent work into one accepted Task.

## Task Git reference and CAS

The server-side Git boundary owns:

- the Task-number branch;
- the internal Task base ref;
- the immutable accepted result commit;
- the integrated `dev` result.

The Task aggregate stores only `{projectRoot, branch, resultCommit}` for each
repository. It does not store a second release-authority copy of changed files,
base/result revision pairs, blobs or manifests. Work-log changed files remain
diagnostic journal data only. There is no separate readiness row, frozen
manifest or freeze command. The release plan hashes the current Task revision
and Git references. Generic status mutation may roll back to a non-result status
at any time, but Test, Await and Done in a release-enabled Workspace require a proven integrated result. Any
intervening Task or accepted-result mutation changes the plan
revision and invalidates an older Architect plan. Provider terminal callbacks
do not infer file ownership or release readiness.

## Release plan and completion

The plan contains every open `awaiting_implementation` Task. For each accepted
Git reference it verifies the deterministic branch and result commit, then
derives repository-relative operations from the internal base ref to that exact
commit. Tasks with a valid non-empty Git result are candidates; Tasks missing or
invalid references are returned as `blocked` and are never silently omitted.
Open `done` Tasks remain an Architect audit set. Plan revision hashes current
Task IDs, row revisions and Git references. Conflict detection reads the
Git-derived plan projection, never work-log files or a shared mutable tree.
Shared paths are diagnostic: the blocking evidence is an ambiguous integration
owner or a failed effective-delta application, not path overlap by itself.

For each accepted Task, Agent Hub finds the Task branch first-parent lineage and
the exact owning merge commits in the `dev` first-parent history. Explicit
release preparation materializes `PreRelease` from the approved `main` by
applying only those effective
merge deltas in their original `dev` order, excluding Task-owned changelog
edits, and writing one aggregate commit. `dev` is never merged into
`PreRelease`; Test-only work cannot enter a release through a broad Task
snapshot.

When selected Tasks have nested first-parent result histories, an integration
claimed by more than one selected lineage belongs only to the unique selected
Task whose exact result is a first-parent ancestor of every other claimant's
result. This selected Task identity permits its accepted net delta to be
projected exactly once before dependent Task deltas. Incomparable claimants,
duplicate owners, or evidence outside the selected Task results remains
ambiguous and blocks the release. An unselected ancestor does not establish
this ownership: only the selected Task's effective integrations remain, and a
later delta that depends on the omitted ancestor fails instead of importing it.

A Task with repeated integrations may use a net delta from its latest shared
main ancestor to its accepted result only after bounded Git ancestry proof.
The frozen evidence carries the exact canonical Task base; that base must
already be an ancestor of the approved release main. Its unique merge base with
the accepted result must occur in the result's bounded first-parent history, so
an approved sibling Task base need not itself be an ancestor of a rewritten
accepted result. A missing or unpublished Task base cannot borrow authority
from a merge base inferred only from the result graph.
Unpublished commits must belong to that Task's first-parent lineage or its
exact canonical integrations; intervening merge wrappers must reproduce the
automatic parent merge exactly. Every repeated integration has a unique commit,
order and selected Task owner, and the last integration under the canonical
`(order, commit)` comparator merges the exact accepted Task result. Unknown or
foreign unpublished contributions cannot become release content through a
Task's merge of dev.

The net delta is placed at that last integration order only when no raw
integration of another selected Task strictly between the first and last Task
integration touches any path changed by any of the Task's integrations. The
comparison disables rename detection so that both source and destination paths
remain part of the conservative identity, and it includes a path changed and
later reverted out of the final net delta. Overlaps entirely before or after
the interval do not invalidate the fold because it does not cross them. A
missing, ambiguous, shared, tied, crossing, unavailable or over-budget proof
retains chronological effective-delta composition and its existing conflict
evidence, never an unchecked result snapshot. This permits a later Task
resolution against published main to replace obsolete intermediate conflicts
without widening ownership. See ADR-0034.

For a reopened Task, an earlier integration's result already contained in the
approved main base is accepted only when that integration's automatic merge
tree is still verified. Ownership is proved before overlap detection; proven
Tasks use their pending net paths at the final owned order, while unproven Tasks
retain all effective replay paths.

If chronological replay of a reopened Task conflicts because its stale parent
does not contain bytes already present in the approved base, Agent Hub may use
one Task-local base merge as resolution evidence. The merge must be the unique
bounded member of the Task result's first-parent lineage shared with the replayed
integration, its second parent must equal the exact approved base, and every
conflicting path must match the index base side plus the same accepted mode,
object type and blob in the merge, Task result, integration and current `dev`. Missing, foreign,
non-exact or ambiguous evidence leaves the release blocked. Only those exact
accepted conflict paths are staged; this proof does not admit a Task snapshot
or change integration order.

A raw historical integration may instead resolve one stale conflict path from
Git's direct merge of the exact approved main and that integration's exact Task
side. The integration must be automatic and uniquely owned by the selected
Task. Index stage two must equal approved main by mode, type and object; the
direct merge must report no conflict for the path; and its resulting entry must
equal index stage three, the integration entry and current accepted dev entry.
Only that entry is staged. A different parent, owner, base, path conflict,
mode/type/object or dev state rejects the proof; later Task results and bootstrap
merges cannot retroactively authorize an older integration.

At explicit release start, Architect reads and selects the exact ready Await
set. Before choosing the base, Agent Hub fetches without pull/merge/rebase and
reports every local unpublished or remote main change since the last published
revision, including commit identities, authorship and affected paths. Local and
remote main are not advanced or accepted automatically. The user explicitly
chooses the exact local and origin main commits, and the preflight rechecks both
values before candidate publication. A second fetch immediately before push is
a compare-and-set guard; movement of `origin/main` stops publication for another
user decision.

When the approved origin commit differs from accepted local main, approval of
the audit is not adoption. Before any contour or candidate side effect,
preflight also requires an immutable content-addressed adoption receipt for one
selected frozen Task result plus ancestry of that exact origin commit in current
managed dev. The receipt binds Task ID, canonical repository and key, immutable
Task base, accepted local-main baseline, exact adopted SHA, Task branch and
snapshot commit/tree, unique bounded first-parent merge proof and its exact
parents/tree, operator request ID and Git blob hash. Ordinary prepare, claim,
Test, integration, plan and preflight paths can verify this authority but never
create it. The supported operator surface is `npm run release:policy --
task-upstream-adoption preview|enable --project-root <root> --task-id <id>
--branch <branch> --task-base <sha> --accepted-local-main <sha>
--adopted-commit <sha> --snapshot-commit <sha> --request-id <id>`; preview has
no write effect, while enable atomically verifies the pinned local main, Task
base and Task branch before creating one immutable Git ref to the receipt blob.
Graph shape or later preflight approval cannot retroactively create authority.
A remote-only commit, broad dev merge, missing/mismatched receipt or changed
snapshot fails closed. If origin advances after a pinned Task adoption, the new
tip requires a new audit and a separately authorized Task adoption.

If the preflight response is interrupted after candidate preparation, recovery is
readback-only. The Architect may reconcile the original request only by naming
the exact original request, original preflight arguments, plan revision and
repository revisions. Agent Hub first binds that request to the authoritative
MCP operation receipt by tool, Workspace, caller Stream/provider/thread and
immutable arguments hash, then reads the existing frozen candidate checkpoints
and manifests through the release Git owner. A prepared checkpoint is only
candidate snapshot evidence, even when it is causally bound to the same request:
failures can still occur after the checkpoint before the final preflight guard.
The original request may be reported as reconciled only from a separate
authoritative final-phase outcome that covers candidate preparation, final
primary/release invariant checks and all required validation. Without that final
evidence, the response is only `candidate_snapshot_only` and the original
outcome remains unknown. Missing, stale, moved-plan, tampered-manifest,
contradictory manifest/checkpoint request identity, wrong Workspace or stale Task
revision/result evidence keep the original outcome unknown. Reconciliation never
reruns preflight, reuses a generic replay lease, finalizes the old receipt or
manufactures Test Contour, validation, main-review or publication evidence.

For repositories without an Agent Hub Test Contour, release preflight requires a
repository-owned production validation adapter. The minimal supported adapter
contract for Bookworm-style Android repositories is enabled only by explicit
`releaseValidation.repositories[]` policy. The default unconfigured state fails
closed with an operator action. A configured adapter runs the approved QA checks
against the exact frozen candidate in isolation after `PreRelease` preparation,
then persists bounded server-owned evidence naming repository identity, plan
revision, Task IDs and revisions, Task result commits, candidate commit and tree,
immutable manifest identity, relevant build input identity, check commands,
outcomes and artifact digests. The
preflight adapter accepts only an exact match to the selected repository, plan,
candidate and Task result evidence. Historical QA reports, mutable build outputs,
tree equality, developer-authored reports, or a ready string are not production
validation evidence unless an explicit adapter proves the full input-equivalence
boundary.

Repository-scoped publication baseline adoption from an external publisher
requires an explicit supported authority for that repository. For a GitHub
release/tag source, the adapter must verify the repository remote identity,
publisher API response, immutable release/tag identity, tag target commit, and
staleness/moved-tag conditions before writing bounded publication evidence for
that repository through the publication-state owner while retaining other
repositories. The supported operator surface is `npm run release:policy --
github-baseline preview|enable --project-root <root> --owner <owner> --repo
<repo> --tag <tag> --release-id <id> --target-commit <sha>`; preview has no write
effect, enable writes only the verified repository-scoped record. An unscoped
local JSON file, an arbitrary supplied SHA, a foreign remote, a moved tag or an
Actions run head SHA fails closed. Activation of such an adapter is a separate
operator decision; existing unscoped state is not rewritten in place.

An Agent Hub legacy publication that predates repository-scoped state may be
adopted only through the separate operator surface `npm run release:policy --
local-publication-receipt preview|enable ...`. This adapter does not infer scope
from a SHA or ancestry. It binds the exact raw legacy state and successful local
publisher receipt by SHA-256; verifies their revision, generation, publication
time, Workspace, repository root, frozen plan/manifest and finalization
identities; and verifies the exact active installed release and its runtime
manifest were produced from the publisher checkout. The operator also pins the
canonical origin and current remote-tracking `origin/main`; local main must equal
the legacy published revision and that revision must be contained in the pinned
origin observation. The adapter never fetches or moves refs. Preview is
zero-write. Enable repeats all verification under the canonical publication
lock and appends repository-scoped evidence through the publication-state owner,
retaining the legacy fields and other repositories. Exact retry is idempotent;
changed bytes, identity, deployment, refs or conflicting scoped evidence fail
before write. This migration neither authorizes newer upstream content nor
bypasses ordinary preflight.

Every publication-state writer acquires or re-enters the canonical publication
lock before reserving its per-file write turn. A writer outside the current
owner therefore cannot occupy the write queue while waiting for that owner and
block a nested owner write. The write turn still serializes same-file updates,
and a rejected write releases its turn so later writers can continue. Duplicate
repository evidence is compared recursively across the complete persisted
record, including nested publisher and receipt fields; two records that differ
below the first object level are conflicting rather than silently coalesced.

The Architect explicitly prepares one selected set, supplies its consolidated
`CHANGELOG.md`, and freezes the calendar version before validation. Freeze binds
the exact main base, release-plan revision, included Task IDs and current row
revisions, Task results, owning dev integrations, aggregate `PreRelease` head,
manifest hash, standalone candidate head and Agent Hub package version. Later
Await Tasks are not silently added. The frozen release date/version remains the
tested identity even if the local calendar date changes before publication.
Only a Stream with `settings.architect=true` may record verified release
completion.

Explicit preparation ordinarily composes the selected effective deltas. A
bounded incremental preparation may start from an exact previously frozen
manifest only when base, Workspace and selected Task IDs are unchanged, every
other selected result is unchanged, and exactly one selected result advances by
ancestry. Row-revision changes with an unchanged result are metadata-only. The
builder applies only that result's exact non-`CHANGELOG.md` patch to the frozen
candidate, without three-way or alternate fallback, then records the new current
revisions and reuse evidence. A conflict fails normally. Known unselected paths
and any contribution outside the selected delta remain excluded; changed
selection/base or a non-descendant result uses ordinary selected-delta
composition instead of this optimization.

Freeze binds the consolidated root CHANGELOG and exact package metadata to the
prepared aggregate and plan using the same release repository owner and lock.
It records durable freeze intent before promoting the clone's main reference
and resumes the identical target after interruption. Source edits or mismatched
plan/head/content fail closed. The registered primary is never the promotion
target. The frozen candidate remains immutable. Any change of plan revision,
Task revision, Git reference or approved `main` invalidates its use by later
freeze, publication and completion CAS. Architect must explicitly prepare and
refreeze; acceptance changes never mutate an already frozen candidate.

Candidate readback is phase-specific. A `prepared` checkpoint requires the
standalone clone to be an exact clean `PreRelease` checkout. A `frozen`
checkpoint requires an exact clean `main` checkout while both `main` and
`PreRelease` still equal the checkpointed `preReleaseHead`. Other phases and
any branch, ref, tree, index or worktree drift fail closed. Freeze remains the
only owner that promotes and attaches the standalone clone to `main`.

Completion performs one transaction that CAS-checks every exact Task revision
and the plan hash, then changes only those Tasks to `done` and persists a
versioned finalization marker in the same commit. That marker binds the exact
plan and published repository revisions to primary synchronization, dev
synchronization and explicit next-candidate invalidation receipts.
Generic `done` and
`hub_task_complete` do not create production evidence.

Post-deployment verification requires an explicit revision for every frozen
repository. That revision must equal, not merely contain, the checkpointed
`preReleaseHead` bound to the exact `{planRevision, manifestHash, baseCommit}`.
It also proves every accepted immutable Task result is contained, then repeats
publication revision/generation readback immediately before the Task closure
transaction. Once verified, only included Tasks are completed
and their managed branches and worktrees may be removed. Published `main` is
incorporated into `dev` without discarding later Test work. Remaining Await
Tasks stay accepted and the previous candidate is durably invalidated; their
next `PreRelease` is built only by a later explicit prepare. A repeated
completion request resumes only unfinished synchronization stages, never Task
closure or candidate preparation. Each successful stage
persists its receipt through a short canonical mutation before the next stage.
The active marker clears only after all stages have confirmed success.
The last 16 completed exact-plan outcomes remain canonical evidence for lost-response
replay; transport acknowledgment is not permission to forget release completion.
Interrupted Desktop completion reconciles only an existing pending or completed
outcome, never starts fresh Task closure. Legacy Await-only markers cannot prove
primary/dev synchronization: recovery explicitly reports unavailable legacy
evidence and resumes only their original synchronization scope.

The publication executor consumes the frozen manifest; it does not select Tasks
or infer approval. Its durable journal retains exact candidate, validation mode,
run ID, stage results, expected installed release, publication generation and
completion command identity. Before deployment, even after a saved Git success,
it rechecks the approved origin base and frozen plan. Push uses the exact
candidate revision and exact origin lease with an ancestry guard; observing the
same candidate on origin reconciles a lost push response without another push.
The first automated adapter supports one exact repository; multiple repositories
fail before publication rather than receiving partial completion evidence.

Starting a different publication identity cannot overwrite a nonterminal run.
Under the canonical publication lock, the existing start owner may automatically
mark a dead run `interrupted` only when its exact journal and checkpoint show
that execution reached solely the named pre-effect validation stages, no effect
stage was started, reused, completed or failed, and progress is empty. The old
terminal status is durably archived beside its existing log before the new
status is created; an exact retry after a crash between those writes is
idempotent. A live owner, unknown stage, effect-stage history, progress or
checkpoint mismatch fails closed and remains subject to its specific recovery
path.

Before replacing an already terminal publication identity, the start owner
archives the exact prior status beside its canonical run log. A conflicting
archive or a log identity outside the canonical run directory fails before the
new status is created. This preserves the terminal publication evidence even
though `publication-status.json` remains the current-run projection.

Deferred restart and `--skip-restart` with an unready runtime are
`awaiting_restart`, not success. Publication-state is recorded only after
required exact runtime readiness. Pending finalization stays recoverable and
retains checkpoints. A ready replacement resumes only readiness, publication
recording and canonical completion under the publication lock, without build,
deploy, push or restart; startup readiness does not wait for that work.
Only completed Workspace finalization yields `succeeded`. A low-level publisher
without a Workspace adapter yields `published` and does not claim Task closure.
When the safe restart owner defers rotation, the publication result carries the
machine-readable `yield_current_turn` handoff. The current release agent ends
its turn without starting more work; this neither interrupts another user's
turn nor requests an early restart before the existing safety gate.

Exact runtime readiness uses the authenticated bounded `runtime-health`
command, not the full application snapshot. Its live/ready flags and process
release ID/PID must match the filesystem runtime status, and the endpoint ID is
reread after the probe so an endpoint swap cannot be accepted. A mismatch keeps
completion pending and performs no publication or Task-finalization effect.

After readiness, durable `awaiting_finalization` is continued by the single
owner of the original publication operation without new user input. An explicit
`retry_required` repeats only the persisted Workspace finalization under the
same publication lock; retries are bounded by a shared budget and end with an
explicit reason once it is exhausted. Repeated readiness/resume events are
idempotent and create neither a second owner nor a second terminal. Already
successful tests, build, Git publication and deploy are never repeated.

An ambiguous finalization transport result retains the same command identity.
Only an authenticated definitive Desktop rejection proves that the durable
command is terminal and permits one fresh command identity for the same saved
publication completion. The Workspace completion owner then resolves an exact
completed outcome or pending marker idempotently; it does not repeat Task
closure, Git publication, deployment or runtime activation.

Validation is explicit and persisted: full, focused by affected surface, or a
user-authorized quick mode without the test gate. All modes retain publication
identity and readiness checks. Unknown paths expand the publication scope but
cannot override an explicit quick choice; focused mode retains full validation
for unknown paths. Full validation runs candidate smoke first.
Successful test files are reused only with the same proven input fingerprint;
opaque dynamic inputs without an explicit declaration are uncached. The v2 cache
survives successful suites/publication, with 30-day and 2000-result bounds; legacy
or proofless entries are not evidence. A failed file has no unconditional retry.
The full-test stage has a two-hour wall-clock and ten-minute output-idle bound.
These timeouts report failure, not an inferred external outcome. The two cosmetic
browser matrices run in `test:visual`, affected focused UI validation and full
validation exactly once, rather than every ordinary unit run. See ADR-0034.
The process-per-file runner overlaps at most two files after CPU/memory admission
and only for an explicit execution declaration proving distinct disposable
roots, locks, Git repositories, ports and browser profiles. An undeclared file
is exclusive; equal shared-resource tags serialize. Every child gets a unique
temporary environment root, while the same selected file set, failure set and
checkpoint fingerprints remain authoritative. A miss logs only stable policy
reason codes or `input fingerprint changed`; it never logs input contents.
Validation subprocesses are observers, not delegated publication stages: the
test runner removes inherited publication session and stage-delegation markers
before every child process. Publisher-owned deploy, activate and verification
stages retain their separately verified live-owner delegation. Validation that
exercises publication locking uses a fixture-local lock root, never the live
publisher target already held by the parent pipeline. This applies both to
direct state/adoption writers and to validation wrappers whose production
defaults acquire the publication lock, including safe restart and publication
orchestration tests, and runtime publication-completion recovery.

After one successful Worker deploy, live verification may retry only a
recognized exact-index byte-count or SHA-256 mismatch. It keeps the same
published candidate, changed-file set and verification checkpoint, performs no
deploy call, and is bounded to six attempts and 60 seconds. A transport,
authorization or policy failure is not classified as convergence and is
returned immediately. Persistent byte mismatch becomes the terminal
`WORKER_DEPLOYMENT_MISMATCH` result with expected/actual hashes and lengths but
without an HTML body dump.

Verified release completion invokes the same Task Git owner with each exact
published repository revision. The returned `devSynchronization` evidence
distinguishes `already_current`, `fast_forwarded`, `merged`, `conflict`, and
`manual_required`. Publication and Task completion remain truthful when local
dev needs manual reconciliation: publication is not rolled back, but dev
integration is never represented as successful.

## Task close and destructive deletion

`hub_task_complete` and `hub_task_delete` are two-step operations. The first
call returns a confirmation token and an exact preview of branches, worktrees,
dirty and untracked paths, result commits, publication state and deletions. A
confirmed operation is serialized by the Task lifecycle lease and the token is
revalidated against the current Task revision, Git state and exact durable
publication generation. Replacing publication evidence at the same revision
invalidates confirmation before cleanup.
Both Desktop Dashboard actions and MCP tools enter the same application
lifecycle owner. The owner acquires the Task lease before computing either the
preview or the confirmed preview, and enumerates branch/base/result refs from
all stored Git references even when their worktree is already absent.

Complete closes an implementation Task only after workflow Done, rejects dirty
worktrees and removes a branch plus its protective result ref only when the
exact result commit is contained in `origin/main` and durable publication state
names that same revision and a non-empty generation. A local `main` ref alone is
never publication evidence. A Task without Git artifacts
may close as analysis. Delete is the explicit destructive route for unpublished
results. It records a durable cleanup transition, performs Git cleanup first and
deletes the Task row only after cleanup succeeds; failure leaves the Task and its
prior workflow state available.

## Test Contour

The explicit `test-contour.mjs accept-release` command is a separate bounded
artifact-acceptance scope (ADR-0035), not a rolling contour refresh. It consumes
already-built previous/candidate Windows runtime artifacts, verifies and retains
their exact manifest hashes and never rebuilds or edits their release bytes.
Every run owns a fresh isolated root; its candidate RuntimeHost supplies a
persistent isolated environment across WMI replacement. All control calls,
pointers, locks, homes and synthetic adapter state belong to that root.
Success requires observed simultaneous live previous/replacement PIDs, exact
candidate ready lock/control identity, and previous process exit. The report
must enumerate checked and excluded scenarios; passing this lifecycle scope
does not imply coherent production-data or queue/outbox recovery parity.

Test Contour branding is a staging transformation before manifest hashes are
computed. It cannot mutate an already manifested release. A failed preparation
leaves stable launchers and the current pointer unchanged; artifact acceptance
still verifies every manifested byte, including the test interface document.

Explicit recording inputs prepare a fresh writable cohort from immutable capture
evidence through the existing preparation owner. The acceptance launcher uses a
v2 marker binding the exact root/profile and SHA256 of provider, preparation,
project descriptor and persistent config. Every independent Windows launch
verifies these identities and reconstructs the same isolated recording homes;
unknown profiles, partial cohorts or old launcher capabilities fail before Hub
startup. Cleanup uses stable root ownership, so changed config cannot prevent
closing its already-owned process job. Recording acceptance reads the existing
selection and never creates a synthetic Thread, replays user input, drains queues
by force or turns a waiting restart into successful replacement.

There is one rolling Test Contour. It is always built from `dev`; Agent Hub does
not deploy a contour per Task branch. The contour status records the exact
`dev` head it displays. Candidate preparation completes before the current
runtime is stopped, so a Git or build preparation failure leaves the previous
working contour available.

Every refresh is one persisted maintenance operation, not a provider turn. Its
identity binds the exact contour root, contour marker, port, model, source `dev`
head, candidate release and owner process. Refresh, verify and release preflight use
one interprocess lease per contour root. A second process waits for that lease;
after acquisition it either coalesces with an already-ready identical target
(`root`, marker, port, model and source) or
creates a newer operation that deterministically supersedes the prior result.
Callers may read an exact operation revision without polling and must treat a
superseded readback as a stale result, not as validation of the newer contour.

The candidate release does not become `current` until its exact manager and
runtime report ready. The serving runtime writes a per-launch nonce and its
contour, operation, release, model, PID, expected port and actual listening port
into `/health`; all values must match the refresh operation. The root-local
instance lock must independently name the same spawned runtime PID, candidate
release and `ready=true`. A forged lock or a healthy unrelated server on the
requested port is not readiness evidence. If the operation owner dies, the next lease
owner finalizes an already-ready exact candidate or records the interrupted
operation as failed before starting new work. A planned replacement is reported
as refresh state and is not classified as a runtime crash.

An explicit release preflight prepares the exact current selected set. It may
use only the bounded frozen-candidate successor optimization above; no other
cached or broad `dev` candidate is accepted. After refresh,
`TestContour.source.headCommit` must equal the exact Agent Hub repository `dev`
HEAD observed by the preflight. Only this release preflight additionally
requires every selected immutable Task result commit to be an ancestor of the
corresponding repository `dev` HEAD. Ordinary plan reads do not impose that
integration requirement. Preflight accepts only an exact `ready` readback for
the returned operation ID, source head and full target identity; `not_found`,
`failed`, `refreshing`, `superseded` and identity mismatch all fail closed. The
post-refresh confirmation has one 10-second attempt budget. The budget gates
the start of each read and bounds its HTTP health request by the time remaining
when that read begins. A read admitted within the budget may finish synchronous
local diagnostics afterward: exact-ready is accepted, while a non-ready result
cannot start another read after the budget. This is not a hard interruption
bound for local file or SQLite diagnostics. Only a still-live exact runtime with
a transient unavailable/not-ready health response may be retried; stopped
processes and operation, target, runtime, port or lock identity mismatches fail
immediately with a stable diagnostic reason. The preflight does not reconstruct
or compare blob manifests.

Persisted operations created before the target included `model`, or runtime
states created before the per-launch health nonce, are never eligible for
same-target coalescing. The next refresh replaces them; this compatibility guard
may be removed once all supported contour roots have completed one refresh with
the full identity.

Ordinary contour start, refresh, verify, and release preflight source resolution
remains `dev`-only. The publication pipeline's explicit `--release-candidate`
verification is a separate gate: it resolves source bytes
directly from the Agent Hub-owned standalone release clone, requires that clone
to be clean and attached to `main` with `HEAD == refs/heads/main`, and records
that exact source identity. It never prepares or falls back to a `dev` checkout
inside the contour root. The ownership/isolation guard remains mandatory, and
the source identity is checked again immediately before and after candidate
deployment so a changed clone fails before activation. No ordinary command
selects this source mode. An ordinary `start` always resolves the current exact
`dev` identity before reusing a persisted runtime; a persisted release-candidate
runtime is replaced by `dev` rather than restarted.

The rolling contour is preview evidence, not release proof. Release validation
still requires the prescribed isolated candidate checks and publication
pipeline before production side effects.

A prepared recording cohort may exercise recovery under the boundaries in
RST-001 and ADR-0038. It does not change the single rolling contour, dev source,
operation lease or exact-readiness rules. Its captured Task Git references are
evidence only: Task/Release Git operations must fail before Git effects and Task
CAS until an independently owned Git cohort is available. A locally recorded
delivery or excluded operation cannot authorize production publication.

Complete/Delete confirmation is a projection of the authoritative server cleanup
preview. Before the confirmed request the client displays every available Task
branch, managed worktree and HEAD, dirty/changed/untracked paths, result commit,
publication revision/generation/state and exact deletion target. The client does
not derive cleanup policy or publication authority, and cancellation sends no
confirmed mutation.

## Workspace policy and Architect role

`settings.releaseWorkflowEnabled=true` activates Task release tracking and the
built-in workflow rules. Architect authority is only
`stream.settings.architect === true`; multiple Architect Streams are allowed.

Both checkbox-generated policy blocks explicitly permit a user's instructions
for the current work to override conflicting workflow requirements, including
Task creation, validation scope and publication sequence. Only an explicit
request establishes an exception; urgency or frustration does not. The agent
must preserve its agreed scope in continuation and rotation context until that
work is completed or the user changes it, without extending it to later work.
This delegates workflow choices only: system instructions, safety/security,
unrelated developer instructions, tool authorization and integrity checks still
apply, and skipped checks and publication state must be reported accurately.
The default Task and release requirements below apply absent that exception.
This is prompt policy, not a new persisted authorization owner or a bypass of
the server transitions and evidence checks defined in this contract.

Composition recognizes the exact former Workspace V6 and Architect V1 generated
prefixes and replaces them with the current templates without duplication.
Authored variations are preserved, not identified by headings or fuzzy matching.
The editable Workspace projection also removes the exact V6 prefix. These
compatibility entries may be removed only when supported stored rules can no
longer contain those generated versions. Existing custom text is not rewritten.

When that setting is false or absent, every Task workflow status, including
Test, Await and Done, is an ordinary database transition through the same
Task lifecycle owner. It keeps row-revision CAS, durable operation outcomes,
exact claimed-turn bindings and status events, but does not acquire a Git lease,
require a Stream/project root, prepare a worktree, snapshot or integrate Git,
or invoke release preflight. Existing Git references remain unchanged. This
scope clarification is recorded in ADR-0031; Complete/Delete retain their
separate artifact-aware cleanup contract.

A Stream with `settings.teamLead=true` sends each exact implementation result
to an independent Workspace Stream for review; the implementation executor
does not review its own work. The review request is limited to the Task
requirements, actual Git diff and consequences of the changes. The Task is
blocked when those changes fail its requirements, cause or worsen a real
regression in existing behavior, or add unnecessary functionality that must be
removed. Pre-existing unrelated defects, impractical edge cases without
contract impact, unsupported findings and out-of-scope issues do not block the
Task. Initial review may use any suitable independent Workspace Stream. After
a `RETURN`, the corrected exact result goes back to the same reviewer, and that
`RETURN` remains open until that reviewer confirms the correction.

By default, the built-in rules require a Task for every change to a repository,
configuration, data, documentation or another deliverable. Read-only diagnosis,
explanations and answers do not create Tasks. If diagnosis becomes
implementation, claim a Task before the first change and continue only in its
main-based managed sparse worktree. Project-root selection follows the current
Stream working directory, then the Workspace working directory, and never a
historical provider Thread.

Disabling release workflow changes only Workspace policy. It does not mutate or
discard Tasks or historical publication evidence.

## Bootstrap of the release-control wiring

Publication plan reads during freeze and Git publication use the bounded
120-second repository-operation deadline. Planning may prepare managed Git
state and must not inherit the 10-second interactive Desktop deadline.
This does not relax the exact plan, manifest, repository or Git lease checks.

The canonical planner and completer must reach Desktop through both startup
composition layers. A first update from an installation missing that wiring
may explicitly supply a local MCP context bound to its exact published revision
and Workspace. Only `Task release plan is unavailable` permits a live call to
the existing `hub_release_plan_get`; its canonical dev preparation remains in
force. A cached plan is never a substitute. Other errors, Git publication and
finalization never fall back to MCP through this bridge. The context capability
is not part of durable publication identity or logs. Delete the local context
after the first update; retire this compatibility bridge when the old wiring is
outside the supported migration range.

An accepted release-projector correction that is not yet installed may bootstrap
one exact `Test -> Await` transition from its clean Task checkout. The local
cutover verifies the exact source commit and resolver SHA-256 before opening the
production stores, then requires that commit to be the unique immutable Task
result for the canonical repository. It binds both source identities and the
expected Task revision and status in the canonical MCP arguments hash, and
invokes the ordinary `hub_task_status_update` owner.
When a selected dependency must enter Await before the Task that owns the
accepted projector, the cutover may name that separate source Task. Source and
target must belong to the same Workspace and canonical repository. The source
Task ID, Test revision, unique result commit and resolver hash are bound into the
receipt; the Await owner acquires both Task locks in deterministic order and
rechecks the source Task and clean checkout inside those locks immediately
before the target lifecycle transition. The current target Workspace/Stream and
both effective repository roots are re-read under those locks. The same SQLite
transaction that begins the lifecycle transition then fences the exact current
target and source Task revisions/statuses, Workspace and Stream ownership, both
repository roots, the source result reference and the enabled release workflow,
so a settings or source-authority write cannot pass between readback and
transition. The target Task remains the only Task whose result, status and
release membership change.
The same Task, repository and Await locks, lifecycle transition, immutable result,
dev integration and unknown-receipt rules apply. The successful transition
invalidates older candidate identity and does not compose `PreRelease` or roll
back because another selected Task is not currently composable.
The one-shot composition skips startup reconciliation of unrelated receipts and
does not patch `PreRelease`, refs or SQLite directly. Its request ID is subject to
the same no-blind-retry rule as the installed MCP operation.
If that extended receipt becomes unknown after a durable terminal outcome, its
operator reconciliation must reproduce the complete original cutover arguments
hash. The expected revision and status must equal the durable prior Task, the
source commit must be its unique result for the canonical repository and must
equal the recorded lifecycle result, and the resolver SHA-256 remains mandatory.
For a cross-Task cutover, durable lifecycle evidence additionally binds the
original source Task ID and revision. Terminal reconciliation uses that recorded
authority even if the source Task later advances; altered, missing or mixed
source identity remains unknown and performs no Git or lifecycle replay. A
pending recovery resumes with the exact immutable source evidence from its
existing transition and preserves that evidence in the terminal outcome.
Missing, altered or mixed cutover identity stays unknown; terminal reconciliation
performs no Git or lifecycle replay.

## Legacy cutover

A legacy open Await Task that predates Task Git references may be adopted only
through the explicit Architect-only MCP migration. The caller names the exact
terminal Stream turn, its reported result commit and an exact equivalent commit
already contained in local `main`. Adoption requires an unchanged Task revision,
no existing Git references, terminal evidence that names both the Task and the
reported commit, matching single-parent non-`CHANGELOG.md` patch IDs and changed
path operations, and an adopted commit that is an ancestor of local `main`.
The operation creates the deterministic Task branch, base ref and legacy
adoption marker ref. If an earlier status attempt already prepared that branch
at current local `main`, adoption may realign only its clean Agent Hub-managed
worktree and matching base ref to the verified result; any dirty, external or
otherwise divergent branch fails closed. Release evidence for the exact marker excludes every
`CHANGELOG.md` because release history is consolidated by Architect. It never
creates a synthetic commit or moves the registered primary checkout. The Task
stores the adopted immutable result and an append-only audit row identifying the
evidence turn, source commit, main commit, patch ID, actor and request. Arbitrary
`HEAD` adoption and adoption of an already evidenced Task fail closed.

Active legacy registry entries and Task-freeze rows are imported into their Task
aggregate before cutover. Every source row is exported to append-only history
and verified by source identity, payload cardinality and SHA-256. Only then are
the live registry/freeze source tables physically dropped. The retained history
is audit-only and is never read by release planning. All new work follows
ADR-0009 Task branches, ADR-0010 integration boundaries and ADR-0011
Git-reference authority.

## Independent release repository

`PreRelease` is materialized only in an Agent Hub-owned standalone clone under
runtime data. Its Git common directory is distinct from the registered primary
Workspace. It imports the exact frozen Task results without sharing branch
ownership; a linked worktree is never a release holder. Publication entrypoints
require the independent-clone marker and reject the primary Workspace.

The clone writes a content-addressed execution manifest and retry checkpoint
containing the exact plan revision, approved local and origin main base, Task
IDs and row revisions, result commits, owning dev integration lineage and
`PreRelease` head. Candidate construction uses detached temporary state and
CAS-swaps the branch plus checkpoint only after complete success. A failed exact
or three-way application therefore leaves the last good `PreRelease` and its
checkpoint intact. This is audit evidence, not a second readiness authority;
retry may reuse it only when the complete frozen identity and head match.

The registered primary must own and remain attached to `refs/heads/main` before
preflight, after candidate preparation, during retry, after publication and at
startup reconciliation. Release code must not switch, detach, reset, stash,
clean, or otherwise mutate its HEAD, index or working tree.

At runtime startup, reconciliation receives the working directory of every
release-enabled registered Workspace from the Workspace catalog. It audits those
roots even when `release-repositories` is absent and no checkpoint has ever been
written. A legacy Workspace without its own working directory uses the runtime's
registered default project root; historical thread roots are not treated as
primary authority. A detached primary and every linked `main`, `PreRelease`, or legacy-named
holder are diagnostic evidence; discovery performs no clone creation, checkout,
branch change, cleanup or removal. Checkpoint enumeration additionally recovers
Agent Hub-owned clones that are no longer associated with a registered root.
For each registered root the audit also derives the exact managed repository
layout. An existing `releaseRoot` without its matching valid checkpoint, or with
an absent/mismatched ownership marker or shared/invalid Git common directory, is
an orphan and yields `manual_required`; startup never adopts, repairs or removes it.

The effective Workspace and Architect developer rules, and the visible release
tooltip, state the same execution boundary: the primary is not a release checkout;
the frozen release runs only from `releaseCandidates[].releaseRoot` in the
standalone clone; legacy linked release worktrees are neither created nor reused.
Compatibility injection removes the old Architect instruction to update local
`main` or use a separate linked integration worktree.

After verified publication, synchronization is limited to a guarded `--ff-only`
update while the primary still satisfies the invariant. Existing dirty paths are
hashed first. Overlap with published paths, a non-fast-forward, or an invalid
primary yields `manual_required`: the successful release stands and primary HEAD
and local bytes remain untouched. A successful fast-forward must preserve every
pre-existing dirty-path hash.

Linked release holders from before ADR-0013 are detection-only migration
evidence. They are never reused or removed by startup/retry. Cleanup requires a
separate authorization and proven Agent Hub ownership. The detection guard may
be retired only after every supported installation has an independent-clone
checkpoint and no supported migration can contain a linked holder.

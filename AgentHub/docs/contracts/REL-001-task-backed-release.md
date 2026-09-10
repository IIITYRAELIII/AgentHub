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
metadata entries are not package roots. This makes
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
next owner until the existing operator-proof recovery. Ownership is rechecked
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
to `testing`, or directly to a later implementation status,
snapshots its complete dirty worktree into a local result commit and merges that
result into the shared local `dev` branch. Git derives the stable changed-file
set between the Task base commit and Task result commit:

`Array<{projectRoot,path,operation:"added"|"modified"|"deleted",turnId:null|string}>`.

`projectRoot` is the canonical Git repository root and `path` is relative to
that root. Git defines the base, result, operation, blobs and patch. Provider
receipts, final text, timestamps and shared dirty trees are never ownership
fallbacks.

`TaskGitWorkspaceService` is the single owner of published/current `main` to
managed `dev` synchronization. Under the repository's existing dev lock it
fetches one explicit `refs/heads/main:refs/remotes/origin/main` refspec with
tags and recursive submodule fetch disabled, resolves the exact current main
commit, verifies that the managed dev worktree is clean, and then incorporates
that commit before new Task preparation, Task integration, and release
preflight. Remote tag settings cannot widen this fetch: local `main`, remote
`dev`, protective branches, and every tag ref remain unchanged. It never checks
out or updates the registered primary worktree and never creates or pushes
`origin/dev`. A new Task still starts from the exact main commit returned by
that locked operation, not from rolling Test content.

If `main` and `dev` diverge, the owner creates a local merge commit whose result
must contain both the former dev head and current main as ancestors. A conflict
is collected, aborted, and reported only after the dev head and clean worktree
are proven restored. Dirty dev or a published-revision mismatch is
`manual_required`; an abort that cannot prove restoration throws. No Task
preparation or integration is reported as successful in either case.

The one-time bootstrap for an already-diverged managed `dev` is itself a Task
result: under the same Task and dev locks, the snapshot owner accepts a pending
Task-worktree merge only when its exact `MERGE_HEAD` is the current managed dev
head. The resulting two-parent Task snapshot contains current `main` and the
previous dev line. Integration recognizes those two proven ancestors and merges
the Task result directly instead of first replaying the conflicting main-to-dev
merge. Until the owner snapshots and integrates that result, neither `dev` nor
the registered primary checkout is changed.

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
lock. A transition into or out of Await rebuilds the complete Await-only
`PreRelease` while that lock remains held. If the rebuild fails after the status
CAS, a second exact CAS restores the prior status, Git references and requested
workflow bindings before the error is returned. Any Git, recovery, CAS or Await
rebuild failure therefore preserves the prior release membership.

Moving a Task to `awaiting_implementation` records that its exact immutable
result is accepted for a future release and atomically rematerializes mutable
`PreRelease`. A ready Await Task requires a valid exact result and successful
`dev` integration. Missing or ambiguous integration ownership, an effective
delta that cannot be applied to the approved main base, or a dependency on work
owned only by Test/In Progress/New blocks the transition. Such a dependency is
never silently included; the user resolves it individually, normally by
combining the dependent work into one accepted Task.

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
the exact owning merge commits in the `dev` first-parent history. Mutable
`PreRelease` is rebuilt from the approved `main` by applying only those effective
merge deltas in their original `dev` order, excluding Task-owned changelog
edits, and writing one aggregate commit. `dev` is never merged into
`PreRelease`; Test-only work cannot enter a release through a broad Task
snapshot.

A Task with repeated integrations may use a net delta from its latest shared
main ancestor to its accepted result only after bounded Git ancestry proof.
Unpublished commits must belong to that Task's first-parent lineage or its
exact canonical integrations; intervening merge wrappers must reproduce the
automatic parent merge exactly. Unknown or foreign unpublished contributions
cannot become release content through a Task's merge of dev. Net projection is
not used where its affected paths overlap another selected Task's effective
delta: those Tasks retain chronological effective-delta composition and its
existing conflict evidence. Unavailable or over-budget proof selects that same
existing composition, never an unchecked result snapshot. This permits a later
Task resolution against published main to replace its obsolete intermediate
conflicts without widening ownership. See ADR-0034.

At explicit release start, Architect reads and selects the exact ready Await
set. Before choosing the base, Agent Hub fetches without pull/merge/rebase and
reports every local unpublished or remote main change since the last published
revision, including commit identities, authorship and affected paths. Local and
remote main are not advanced or accepted automatically. The user explicitly
chooses the exact local and origin main commits, and the preflight rechecks both
values before candidate publication. A second fetch immediately before push is
a compare-and-set guard; movement of `origin/main` stops publication for another
user decision.

The Architect adds one consolidated `CHANGELOG.md` entry when it exists, then
freezes the exact main base, release-plan revision, included Task IDs and row
revisions, Task results, owning dev integrations, aggregate `PreRelease` head,
manifest hash and standalone candidate head. Later Await Tasks are not silently
added. Only a Stream with `settings.architect=true` may record verified release
completion.

Prepared Await materialization precedes publication freeze. Freeze binds the
consolidated root CHANGELOG to the exact prepared aggregate and plan, using the
same release repository owner and lock. It may change only that CHANGELOG,
records durable freeze intent before promoting the clone's main reference,
and resumes the identical target after interruption. Source edits or mismatched
plan/head/content fail closed. The registered primary is never the promotion
target. The frozen candidate remains immutable. If an included Task changes, is
withdrawn or is excluded before completion, its Task revision or Git reference
changes and completion CAS fails. Architect must explicitly rebuild and
refreeze the release before it can complete; acceptance changes never mutate an
already frozen candidate.

Completion performs one transaction that CAS-checks every exact Task revision
and the plan hash, then changes only those Tasks to `done` and persists a
versioned finalization marker in the same commit. That marker binds the exact
plan and published repository revisions to primary synchronization, dev
synchronization and remaining-Await rebuild receipts.
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
Tasks stay accepted and mutable `PreRelease` is immediately rebuilt for the next
explicit release. If that rematerialization fails, the caller receives
`retry_required`; a repeated completion request resumes only unfinished
synchronization/rebuild stages, never Task closure. Each successful stage
persists its receipt through a short canonical mutation before the next stage.
The active marker clears only after all stages have confirmed success.
The last 16 completed exact-plan outcomes remain canonical evidence for lost-response
replay; transport acknowledgment is not permission to forget release completion.
Interrupted Desktop completion reconciles only an existing pending or completed
outcome, never starts fresh Task closure. Legacy Await-only markers cannot prove
primary/dev synchronization: recovery explicitly reports unavailable legacy
evidence and resumes their original rebuild scope.

The publication executor consumes the frozen manifest; it does not select Tasks
or infer approval. Its durable journal retains exact candidate, validation mode,
run ID, stage results, expected installed release, publication generation and
completion command identity. Before deployment, even after a saved Git success,
it rechecks the approved origin base and frozen plan. Push uses the exact
candidate revision and exact origin lease with an ancestry guard; observing the
same candidate on origin reconciles a lost push response without another push.
The first automated adapter supports one exact repository; multiple repositories
fail before publication rather than receiving partial completion evidence.

Deferred restart and `--skip-restart` with an unready runtime are
`awaiting_restart`, not success. Publication-state is recorded only after
required exact runtime readiness. Pending finalization stays recoverable and
retains checkpoints. A ready replacement resumes only readiness, publication
recording and canonical completion under the publication lock, without build,
deploy, push or restart; startup readiness does not wait for that work.
Only completed Workspace finalization yields `succeeded`. A low-level publisher
without a Workspace adapter yields `published` and does not claim Task closure.

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

An explicit release preflight always prepares a fresh candidate from `dev`; it
must never reuse or start a cached candidate. After refresh,
`TestContour.source.headCommit` must equal the exact Agent Hub repository `dev`
HEAD observed by the preflight. Only this release preflight additionally
requires every selected immutable Task result commit to be an ancestor of the
corresponding repository `dev` HEAD. Ordinary plan reads do not impose that
integration requirement. Preflight accepts only an exact `ready` readback for
the returned operation ID, source head and full target identity; `not_found`,
`failed`, `refreshing`, `superseded` and identity mismatch all fail closed. The
preflight does not reconstruct or compare blob manifests.

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

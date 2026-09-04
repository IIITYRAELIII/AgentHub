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

Moving a Task to `testing`, or directly to a later implementation status,
snapshots its complete dirty worktree into a local result commit and merges that
result into the shared local `dev` branch. Git derives the stable changed-file
set between the Task base commit and Task result commit:

`Array<{projectRoot,path,operation:"added"|"modified"|"deleted",turnId:null|string}>`.

`projectRoot` is the canonical Git repository root and `path` is relative to
that root. Git defines the base, result, operation, blobs and patch. Provider
receipts, final text, timestamps and shared dirty trees are never ownership
fallbacks.

A successful Test integration records only the deterministic Task branch and
its accepted immutable result commit on the Task. The base ref and changed-file
set remain Git data and are derived when a release plan is read. A conflict is
aborted and returned with exact conflicting paths. Git failure never rejects the
requested workflow-status transition.

Moving a Task to `awaiting_implementation` records that its exact immutable
result is accepted for a future release. The status transition does not build,
rebuild or mutate `PreRelease`. A ready Await Task requires a valid exact result
and successful `dev` integration; invalid or missing evidence is explicitly
blocked from release without rejecting the selected Task status.

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
and Git references. Generic status mutation may select any workflow status at
any time; any intervening Task or accepted-result mutation changes the plan
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

At explicit release start, Architect reads and selects the exact ready Await
set, updates from `origin/main`, builds `PreRelease` from current `main` plus the
selected exact Task results, and then freezes the exact release-plan revision,
included Await Task IDs and resulting `PreRelease` head. `dev` is never merged
into `PreRelease`; Test-only work cannot enter a release. Architect writes one
consolidated `CHANGELOG.md` entry in `PreRelease` when that file exists,
validates the exact frozen revision, integrates it into `main`, and publishes
`main`. Later Await Tasks are not silently added. Only a Stream with
`settings.architect=true` may record verified release completion.

The frozen candidate remains immutable. If an included Task changes, is
withdrawn or is excluded before completion, its Task revision or Git reference
changes and completion CAS fails. Architect must explicitly rebuild and
refreeze the release before it can complete; acceptance changes never mutate an
already frozen candidate.

Completion performs one transaction that CAS-checks every exact Task revision
and the plan hash, then changes only those Tasks to `done` and closes them.
Generic `done` and
`hub_task_complete` do not create production evidence.

Post-deployment verification proves that every accepted immutable Task result
commit is an ancestor of the published `main` revision. It does not compare a
second stored blob manifest. Once verified, only included Tasks are completed
and their managed branches and worktrees may be removed. Published `main` is
incorporated into `dev` without discarding later Test work. Remaining Await
Tasks stay accepted for the next explicit release; Agent Hub does not prebuild a
mutable next candidate.

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

## Workspace policy and Architect role

`settings.releaseWorkflowEnabled=true` activates Task release tracking and the
built-in workflow rules. Architect authority is only
`stream.settings.architect === true`; multiple Architect Streams are allowed.

The built-in rules require a Task for every change to a repository,
configuration, data, documentation or another deliverable. Read-only diagnosis,
explanations and answers do not create Tasks. If diagnosis becomes
implementation, claim a Task before the first change and continue only in its
main-based managed sparse worktree. Project-root selection follows the current
Stream working directory, then the Workspace working directory, and never a
historical provider Thread.

Disabling release workflow changes only Workspace policy. It does not mutate or
discard Tasks or historical publication evidence.

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
containing the exact plan revision, `origin/main` base, Task IDs, result commits
and `PreRelease` head. This is audit evidence, not a second readiness authority.
Retry may reuse it only when the complete frozen identity and head match.

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

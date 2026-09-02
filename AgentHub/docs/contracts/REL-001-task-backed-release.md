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

Moving a Task to `awaiting_implementation` additionally rebuilds `PreRelease`
from current `main` plus the exact result commits of every accepted Await Task.
`dev` is never merged into `PreRelease`; Test-only work must not enter a release.
Returning, withdrawing or replacing an Await Task rebuilds `PreRelease` without
its old result. An Await Task without successful `dev` and `PreRelease`
integration is explicitly blocked and cannot be released.

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

At explicit release start, Architect freezes the exact release-plan revision,
included Await Task IDs and resulting `PreRelease` head. Architect updates from
`origin/main`, writes one consolidated `CHANGELOG.md` entry in `PreRelease` when
that file exists, validates the exact frozen revision, integrates it into
`main`, and publishes `main`. Later Await Tasks are not silently added. Only a
Stream with `settings.architect=true` may record verified release completion.

Completion performs one transaction that CAS-checks every exact Task revision
and the plan hash, then changes only those Tasks to `done` and closes them.
Generic `done` and
`hub_task_complete` do not create production evidence.

Post-deployment verification proves that every accepted immutable Task result
commit is an ancestor of the published `main` revision. It does not compare a
second stored blob manifest. Once verified, only included Tasks are completed
and their managed branches and worktrees may be removed. Published `main` is
incorporated into `dev` without discarding later Test work, then `PreRelease` is
rebuilt from any remaining Await Tasks.

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

Active legacy registry entries and Task-freeze rows are imported into their Task
aggregate before cutover. Every source row is exported to append-only history
and verified by source identity, payload cardinality and SHA-256. Only then are
the live registry/freeze source tables physically dropped. The retained history
is audit-only and is never read by release planning. All new work follows
ADR-0009 Task branches, ADR-0010 integration boundaries and ADR-0011
Git-reference authority.

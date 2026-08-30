# REL-001 — Task-backed Workspace release

## Authority and identity

For a release-enabled Workspace, the Dashboard `Task` aggregate is the live
authority for ownership, readiness and release completion. Its `workspaceId`
and `streamId` identify the Workspace and executor Stream. The durable Task
`row_revision` is the CAS version for every release-relevant mutation.

Every file-changing Task owns a local branch named
`agenthub/task/<taskId>/<repositoryKey>` and a managed worktree.
`hub_task_claim` and `hub_task_start` return that worktree. All Task changes must
be made there. Provider turn identity remains journal metadata and is not a
source of file ownership.

## Mutable work state

Moving a Task to `awaiting_implementation` snapshots its complete dirty
worktree into a local commit. Git derives the stable changed-file set between
the Task base commit and Task head commit:

`Array<{projectRoot,path,operation:"added"|"modified"|"deleted",turnId:null|string}>`.

`projectRoot` is the canonical Git repository root and `path` is relative to
that root. Git defines the base, result, operation, blobs and patch. Provider
receipts, final text, timestamps and shared dirty trees are never ownership
fallbacks.

Agent Hub then merges the Task head into the single local `dev` branch. A
successful merge records the changed files and repository revisions directly on
the Task. A conflict is aborted and returned with exact conflicting paths. Git
failure never rejects a requested workflow-status transition: the Task remains
visible in `awaiting_implementation`. A new Await request clears the previous
derived Git projection first, so a failed integration is explicitly blocked in
the release plan until complete evidence is recorded again.

## Task evidence and CAS

The server-side Git boundary derives:

- exact base and result commit or tree object ids;
- repository-relative operation for every changed file;
- the Task branch and integrated `dev` result.

The Task aggregate stores changed files and repository revisions. There is no
separate readiness row, frozen manifest or freeze command. The release plan
hashes the current Task revision and evidence. Generic status mutation may
select any workflow status at any time; any intervening Task mutation changes
the plan revision and invalidates an older Architect plan. Provider terminal
callbacks do not infer file ownership or release readiness.

## Release plan and completion

The plan contains every open `awaiting_implementation` Task. Tasks with changed
files and repository revisions are candidates; Tasks missing either are returned
as `blocked` and are never silently omitted. Open `done` Tasks remain an
Architect audit set. Plan revision hashes current Task IDs, row revisions and
Task evidence. Conflict detection reads recorded Task files and revisions,
never a shared mutable working tree.

At explicit release start, Architect freezes the selected `dev` head, updates
from `origin/main`, validates that exact integrated revision, integrates it into
`main`, and publishes `main`. Only a Stream with `settings.architect=true` may
record verified release completion.

Completion performs one transaction that CAS-checks every exact Task revision
and the plan hash, then changes only those Tasks to `done` and closes them.
Generic `done` and
`hub_task_complete` do not create production evidence.

Post-deployment verification proves file-by-file that the published `main`
revision contains every recorded Task result. Once verified, managed Task branches and worktrees may
be removed. The `dev` branch advances with published `main` while retaining any
later unreleased Task merges.

## Test Contour

There is one rolling Test Contour. It is always built from `dev`; Agent Hub does
not deploy a contour per Task branch. The contour status records the exact
`dev` head it displays. Candidate preparation completes before the current
runtime is stopped, so a Git or build preparation failure leaves the previous
working contour available.

The rolling contour is preview evidence, not release proof. Release validation
still requires the prescribed isolated candidate checks and publication
pipeline before production side effects.

## Workspace policy and Architect role

`settings.releaseWorkflowEnabled=true` activates Task release tracking and the
built-in workflow rules. Architect authority is only
`stream.settings.architect === true`; multiple Architect Streams are allowed.

The built-in rules require a Task only for work that changes a repository,
configuration, data or another deliverable. Read-only diagnosis, explanations
and answers do not create Tasks. If diagnosis becomes implementation, claim a
Task before the first change and continue only in its returned worktree.

Disabling release workflow changes only Workspace policy. It does not mutate or
discard Tasks or historical publication evidence.

## Legacy cutover

Active legacy registry entries and Task-freeze rows are imported into their Task
aggregate before cutover. Every source row is exported to append-only history
and verified by source identity, payload cardinality and SHA-256. Only then are
the live registry/freeze source tables physically dropped. The retained history
is audit-only and is never read by release planning. All new work follows
ADR-0009 Task branches, `dev` integration and Task-owned Git evidence.

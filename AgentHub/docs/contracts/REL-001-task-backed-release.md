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
successful merge makes the Task eligible for immutable freeze. A conflict is
aborted and returned with exact conflicting paths. Git failure never rejects a
requested workflow-status transition: the Task remains visible in
`awaiting_implementation`, but without a current frozen release revision until
the conflict is resolved and the merge succeeds.

## Immutable evidence, mutable Task

Before freeze, the server-side Git verifier derives or verifies:

- exact base and result commit or tree object ids;
- repository-relative operation and base/result blob for every file;
- canonical per-file patch SHA-256 when available;
- verifier and Git evidence.

Freeze is one expected-revision CAS. It explicitly increments `row_revision`
even when the live status is already `awaiting_implementation`, appends
immutable rows keyed by `(taskId, taskRevision)`, stores the manifest hash and
keeps the workflow status at `awaiting_implementation`.

Frozen rows are historical evidence, not a lock. Generic status mutation may
select any workflow status at any time. Title, placement, executor and lifecycle
controls remain editable. Any later Task mutation advances the live revision;
a frozen manifest whose revision no longer equals it is excluded automatically.
Terminal callbacks do not own Task status, changed files or release freeze.

## Release plan and completion

The candidate set contains open `awaiting_implementation` Tasks whose current
revision equals their immutable frozen revision and whose Task head was merged
into `dev`. Open `done` Tasks are an Architect audit set. Plan revision hashes
the sorted exact triples `(taskId, taskRevision, manifestHash)`. Conflict
detection reads frozen files and recorded Git revisions, never a shared mutable
working tree.

At explicit release start, Architect freezes the selected `dev` head, updates
from `origin/main`, validates that exact integrated revision, integrates it into
`main`, and publishes `main`. Only a Stream with `settings.architect=true` may
record verified release completion.

Completion performs one transaction that CAS-checks every exact frozen Task
revision and manifest hash, appends durable deployment evidence, then changes
only those Tasks to `done` and closes them. Generic `done` and
`hub_task_complete` do not create production evidence.

Post-deployment verification proves that the published `main` revision contains
the frozen Task results. Once verified, managed Task branches and worktrees may
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

Disabling release workflow is blocked while active Task release evidence exists
and returns an explicit cleanup requirement. Frozen or released evidence cannot
be discarded through compatibility APIs.

## Legacy cutover

Legacy release tables remain immutable compatibility archives. Existing frozen
Task revisions remain valid. ADR-0008 exact-turn synthetic trees are supported
only for already-recorded evidence; all new Task work follows ADR-0009 branches,
`dev` integration and Git-derived manifests.

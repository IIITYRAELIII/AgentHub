# REL-001 — Task-backed Workspace release

## Authority and identity

For a release-enabled Workspace, the Dashboard `Task` aggregate is the only
live authority for change ownership, readiness and release completion. Its
`workspaceId` and `streamId` identify the Workspace and executor Stream. The
durable Task `row_revision` is the CAS version for every release-relevant
mutation.

A provider turn may write Task evidence only through an existing durable
binding keyed by exact `(provider, providerThreadId, turnId)`. `hub_task_claim`
creates that binding for ad-hoc work. A Task-started run creates it as soon as
the provider accepts the exact turn. Missing, conflicting or ambiguous binding
rejects evidence; `dashboardTaskId`, latest Task, text and timestamps are never
ownership fallbacks.

## Mutable work state

One exact terminal turn may append a work-log row and merge a non-empty stable
set of changed files:

`Array<{projectRoot,path,operation:"added"|"modified"|"deleted",turnId:null|string}>`.

`projectRoot` is the containing Git repository root and `path` is relative to
that root. Rows are sorted and deduplicated by repository and path. Exact
provider file-mutation receipts define which paths the bound turn owns; text,
timestamps, the current dirty tree and files changed by other turns are never
ownership fallbacks. Provider path candidates with migration operation
`observed` are audit metadata only and never become authoritative changed
files. Git independently derives the actual operation and result tree by
applying only those owned paths to the claim-time baseline tree. A turn without
exact file-mutation receipts creates no changed-file or release evidence.

The same exact binding stores captured baseline Git trees. A completed or
interrupted terminal projection records matching result trees and may backfill
a baseline carried by that exact completion when claim-time capture raced turn
startup. A finished fix becomes eligible for automatic freeze only when its
exact bound turn previously requested `awaiting_implementation`; a later
completed no-diff continuation may freeze already recorded evidence, and no
final-text classifier may infer that intent.

## Immutable evidence, mutable Task

Freeze is one expected-revision CAS. Before persistence, the server-side Git
verifier derives or verifies:

- exact base and result repository tree/commit object ids;
- exact repository-relative operation and base/result blob for every file;
- canonical per-file patch SHA-256 when available;
- verifier and Git evidence.

The successful CAS increments the Task revision, appends immutable rows keyed
by `(taskId, taskRevision)`, stores the manifest hash, and changes workflow
status to `awaiting_implementation`. The frozen rows are historical evidence,
not a lock on the Dashboard card. Generic status mutation may select any
workflow status, including `awaiting_implementation` and `done`; title, placement,
executor and lifecycle controls remain editable as well.

Any post-freeze Task mutation advances the live Task revision. A frozen manifest
whose revision no longer equals the live revision is automatically excluded
from the release candidate set. Rolling a Task back from
`awaiting_implementation` also clears pending automatic-freeze intent so a later
terminal callback cannot restore a status the user already changed.
Recording `changedFiles`, `workLog` or repository revisions never changes the
user-selected workflow status; evidence and status are independent state.

## Release plan and completion

The release candidate set contains open `awaiting_implementation` Tasks whose
current revision equals their immutable frozen revision. Open `done` Tasks are
included as an Architect audit set. The plan revision hashes the sorted exact
triples `(taskId, taskRevision, manifestHash)`. Conflict detection reads frozen
files, never the mutable shared worktree.

Only a Stream with `settings.architect=true` may record verified release
completion. Publication
must first verify exact clean published repository revisions and deployment
evidence. Completion performs one transaction that CAS-checks every exact
frozen Task revision and manifest hash, appends durable completion evidence,
then changes only those Tasks to workflow `done` and closes them. Neither
`hub_task_complete` nor generic `done` status creates release-completion
evidence or closes a published Task on behalf of the release transaction.

Post-deployment verification reads the immutable published revision recorded by
the publication pipeline and proves that every frozen Task result revision is
an ancestor of it. Physical source clones with the same canonical Git origin
are one logical repository. Their mutable working-tree state is not publication
evidence and cannot block completion after a clean integration worktree has
already been committed, pushed and deployed.

The rolling Test Contour is preview evidence, not release proof. The isolated
release-candidate contour, full HTTP/1.1 large-resource verification, chunked
attachment reconstruction and deterministic fake-provider probe remain required
publication evidence before production side effects.

## Workspace policy and Architect role

`settings.releaseWorkflowEnabled=true` is the only Workspace activation source
for Task release tracking and built-in workflow rules. Architect authority is
only `stream.settings.architect === true`; multiple Architect Streams are
allowed. Legacy `settings.releaseRole` and exact Stream name `Architect` are
recognized once only by migration, persisted as `architect:true`, then removed
as runtime fallbacks.

The built-in rules require a Task only for work that changes a repository,
configuration, data or another deliverable. Read-only diagnosis, explanations
and answers do not create Tasks. If diagnosis leads to requested changes, the
exact turn must claim a Task before the first change.

Disabling release workflow is blocked while active Task release evidence exists
and returns an explicit cleanup requirement. Frozen or released evidence cannot
be discarded or deleted through compatibility APIs.

## Legacy cutover

Before cutover, every existing legacy release table is exported row-for-row to
an immutable ordered archive with table cardinality and payload SHA-256
verification. Active legacy rows and active ChangeSets are imported once into
their logical Task union. Only legacy ready ChangeSets with exact files,
repository evidence, manifest hash and verifier evidence migrate to
`awaiting_implementation`; path-only ready claims remain `in_progress` and need
a new verified freeze.

After the atomic marker commits, all legacy tables reject insert, update and
delete. They remain read-only compatibility archives in this phase. Physical
drop is a separate, explicitly verified migration and never occurs in a store
constructor.

# Agent Hub Task release model

Dashboard Tasks are the only live release authority. There is no separate
release registry, readiness row, frozen manifest or release-entry lifecycle.

## Readiness

- `in_progress` means implementation is still being changed.
- `testing` means the implementation is being checked.
- `awaiting_implementation` means the Task is ready for the next release.
- `done` means production publication was verified and the Task was closed.

An exact bound turn selects the Task and its dedicated worktree. On Await, Git
snapshots that Task branch, merges it into `dev`, and records changed files and
repository revisions directly on the Task. Release planning reads every open
`awaiting_implementation` Task. A Task without changed-file or
repository-revision evidence remains visible in the plan as `blocked`; it is
never silently omitted.

## Publication

The release plan revision hashes the current Task IDs, row revisions and Task
evidence. The Release Manager integrates that exact plan and verifies the published
repository revisions. Completion CAS-checks the same Task revisions, then marks
and closes those Tasks. Any intervening Task edit changes the plan revision and
forces the Release Manager to read it again.

Legacy release tables and the later Task-freeze tables are migration inputs only.
Their source rows are physically dropped after Task data has been loaded and an
immutable history export has passed source-cardinality and SHA-256 payload
verification. The retained history is never consulted by live release planning.

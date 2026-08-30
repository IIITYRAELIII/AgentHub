# ADR-0009 — Task-only release state

## Status

Accepted. Supersedes the freeze and registry decisions in ADR-0003, ADR-0005 and
ADR-0007. The exact provider-turn claim remains required to select the Task
worktree; Git-derived Task branch evidence is the file-ownership boundary.

## Decision

The Dashboard Task aggregate is the only live owner of readiness and release
completion. Setting a Task to `awaiting_implementation` directly makes it part
of the Workspace release plan. A separate freeze command, immutable manifest
row and release-state table are not used.

The plan hashes each current Task revision together with its changed files and
repository revisions recorded when the Task branch is integrated into `dev`.
Awaiting Tasks with missing evidence are returned as blocked instead of being
omitted. Completion checks the same Task revisions and verified publication
before setting them to `done` and closing them.

Legacy registry and Task-freeze source tables are removed only after their Task
migration and immutable history export pass source-cardinality and SHA-256
payload verification. The retained history is not a live release authority.

## Consequences

Dashboard status and release readiness cannot disagree. Editing an awaiting
Task changes the plan revision through normal Task CAS rather than invalidating
a hidden frozen revision. Missing evidence is visible to the Architect and must
be repaired at the Task ownership boundary before publication.

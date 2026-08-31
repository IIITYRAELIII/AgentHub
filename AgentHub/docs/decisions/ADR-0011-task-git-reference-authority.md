# ADR-0011 — Task Git-reference authority

## Status

Accepted. Supersedes the duplicated changed-file, repository-revision and
manifest authority described in ADR-0009 Task-only release state. It refines
the Task branch decisions in ADR-0009 and ADR-0010.

## Decision

While implementation is active, a file-changing Task is identified by its
dedicated deterministic Git branch. At `testing` or a later implementation
status, Agent Hub snapshots that branch and records only the repository root,
branch name and immutable accepted result commit on the Task.

The Task base remains an internal Git ref. Release planning verifies the branch
and accepted commit, then derives changed paths and operations directly from
Git between that base ref and the accepted commit. Derived files, blobs and
manifests are projections, not separately persisted release authority.

Release-plan CAS hashes Task row revisions and accepted Git references.
Publication verification requires every accepted Task result commit to be an
ancestor of the published revision. Overlap resolution is validated as part of
the frozen release integration; publication does not require final file blobs
to remain byte-identical to an earlier Task commit.

Legacy Task changed-file and repository-revision rows are exported to immutable
release history and removed. Work-log changed files remain journal diagnostics
and are never used to decide release ownership or readiness.

## Consequences

Git is the single source of truth for Task file contents and diffs. A movable
branch is sufficient during implementation, while an immutable commit fixes the
accepted result. Release planning performs bounded Git reads at explicit status
and release boundaries, not in provider start or completion hot paths.

The model no longer needs blob reconciliation when later integration or conflict
resolution legitimately changes a file. Missing branches, base refs or result
commits remain visible as blocked Tasks instead of being reconstructed from
stale database evidence.

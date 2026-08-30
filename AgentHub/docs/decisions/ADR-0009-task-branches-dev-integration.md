# ADR-0009 — Task branches and dev integration

## Status

Accepted. Supersedes ADR-0008 for new Task work.

## Decision

Every file-changing Dashboard Task owns a dedicated local Git branch and
managed worktree. Agent Hub snapshots that whole worktree when the Task moves to
`awaiting_implementation`, derives release evidence from its base and head
commits, then merges the Task head into the shared local `dev` branch.

The one shared Test Contour is always built from `dev`. It is not duplicated per
Task branch. A candidate must be prepared successfully before the running
contour is stopped. At release, Architect freezes the selected `dev` head,
validates it, integrates it into `main`, publishes production and closes only
the included Tasks.

Workflow status remains a user-controlled field. Git preparation, commit,
merge, evidence or freeze failure is reported but never rejects a requested
status transition. A Task whose merge conflicts stays visible in
`awaiting_implementation` without becoming a releasable frozen candidate.

## Consequences

File ownership no longer depends on provider-specific changed-file hooks,
terminal timing or transcript identity. Concurrent Tasks cannot contaminate one
another's manifests. Integration conflicts appear once, at the explicit merge
to `dev`, and the previously working Test Contour remains available while the
conflict is resolved.

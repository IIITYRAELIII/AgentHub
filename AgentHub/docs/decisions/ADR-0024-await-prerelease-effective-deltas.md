# ADR-0024: Await-only PreRelease from effective dev deltas

## Status

Accepted for effective-delta projection. The eager Await and post-publication
materialization portions are superseded by ADR-0043.

## Context

Task result commits may contain an updated `dev` parent or earlier integration
history. Merging those broad snapshots again into `PreRelease` creates false
conflicts and can carry work owned by Tasks that are only in Test. Treating every
shared path as a conflict also blocks compatible changes that `dev` has already
integrated successfully.

## Decision

`dev` remains the Test-plus-Await integration branch. For each accepted Task,
Agent Hub derives the Task's exact integrations from the `dev` first-parent
history and the Task branch first-parent lineage. `PreRelease` is rebuilt from
the approved `main` by applying those effective merge deltas in original `dev`
order, excluding Task-owned changelog edits, then writing one aggregate commit.

Path overlap is diagnostic. Missing or ambiguous integration evidence and an
effective-delta application failure are blocking conflicts. An Await Task may
not require work owned only by a non-Await Task; that case remains in Test until
the user resolves ownership, normally by combining the work into one Task.

The mutable Await-only `PreRelease` is rebuilt whenever Await membership or an
accepted result changes. Explicit release authorization freezes its complete
identity. Before selecting the main base, Architect fetches and discloses any
remote or unpublished local changes since the revision recorded by the last
successful publication, with authorship and impact, then waits for the user's
decision. Both reviewed local and remote main SHAs are repeated exactly before
side effects continue. A second fetch immediately before push is a
compare-and-set guard against movement of `origin/main`.

One Workspace release lock serializes Await status changes and candidate
publication. Task status writes use row-revision and prior-status CAS, while the
builder rechecks the complete plan revision after constructing the candidate.
It builds on detached temporary state and CAS-swaps the `PreRelease` ref and
checkpoint only after successful application and validation, preserving the
last good candidate on every failure. The frozen manifest records exact Task
row revisions as well as IDs, results and integration lineage. After verified
publication closes the included Tasks, the same lock protects rebuilding
`PreRelease` from the remaining Await set.
If that post-publication rebuild fails, its pending evidence is committed with
Task completion and a repeated completion request retries only rematerialization.
The published Tasks remain completed exactly once, and the pending marker is
cleared only after the next candidate is successfully installed.

## Consequences

- Test-only commits in `dev` cannot enter `PreRelease` through a Task snapshot.
- Compatible same-file changes no longer require manual conflict approval.
- Earlier integrations of a repeatedly updated Task remain part of its accepted
  result because the complete owned first-parent integration lineage is replayed.
- Hidden dependencies and ambiguous ownership fail closed instead of expanding
  the release set automatically.
- Failed rebuilds do not destroy the last valid `PreRelease` or leave a Task
  membership change paired with a stale candidate.
- Publication removes only the frozen Tasks and immediately rematerializes the
  next Await-only candidate without including later Test work.
- A post-publication rematerialization failure is explicit and retryable without
  misreporting or repeating the already verified release completion.

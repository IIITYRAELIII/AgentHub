# REL-001 — Logical release ChangeSet

## Identity and lifecycle

One logical task owns one ChangeSet across correction and follow-up turns.
Provider turns are observations of that ChangeSet, not separate release changes.
Paths reported by a terminal provider turn are observation candidates, not an
ownership claim. They remain attached to the `TurnObservation` for audit, while
the owner Stream maintains a separate replaceable draft file selection. Only
that explicit selection may participate in conflicts, readiness and release.

The lifecycle is `draft -> ready -> released|discarded`. `ready` is an explicit
freeze of repository base revisions and exact result blobs or patch hashes.
Further edits require reopen/amendment and a new revision; released records are
immutable. A ready ChangeSet cannot have an empty manifest hash.
Terminal observation never promotes either a ChangeSet or a legacy compatibility
entry to `ready`; readiness always follows explicit file selection and owner
confirmation.

Freeze evidence is verified server-side before persistence may transition a
ChangeSet to `ready`. For every repository, Git must confirm the submitted root
as its top-level, the exact base/result commit objects and object format. For
every file, the path at each revision must resolve to the submitted blob, with
`absent` accepted only for the missing side of an add/delete. A submitted
`patchHash` is SHA-256 of the verifier's canonical binary, full-index, Myers,
three-context-line, no-renames Git diff for that literal path. The freeze audit
event records the verification result, verifier version and Git version.

## Ownership and integration

- The owner Stream controls readiness; Architect overrides are explicit and
  audited.
- Release plans hash frozen manifests, not current shared-worktree paths.
- Compatibility is determined by patch applicability/three-way merge, not only
  path equality. Same-Stream overlaps are not silently ignored.
- The long-term execution model uses isolated Stream worktrees and an Architect
  integration worktree. The legacy shared tree remains a migration mode, not the
  target architecture.

## Workspace activation

Release registration is opt-in per Workspace. The durable Workspace setting
`releaseWorkflowEnabled=true` is the only activation source for both terminal
change registration and the built-in release-oriented developer policy. A
disabled Workspace records neither legacy release entries nor ChangeSet turn
observations. Disabling with active registrations requires explicit user
confirmation and atomically marks active legacy entries and ChangeSets
`discarded`; released history remains immutable.

## Phase 1 compatibility boundary

The existing `hub_release_changes` registry and release plan remain the only
publication source. In an enabled Workspace, terminal projection dual-writes a
`TurnObservation` into the new ledger but never marks its ChangeSet ready.
Existing legacy statuses are not migrated automatically except when the user
explicitly disables the Workspace release workflow and confirms discarding all
active release registrations.
New legacy compatibility entries preserve provider-reported paths as
`observedFiles`, start with an empty selected `files` list in `draft`, and expose
an owner-only full-list replacement operation during the migration period.

Publication verifies cleanliness only for the exact paths declared by the frozen
release plan. Unrelated dirty paths in a shared repository do not block the
release, while any tracked or untracked change on a frozen path does.

The new ledger becomes authoritative only after frozen manifests participate in
release planning and every active legacy entry is either linked, released or
discarded by its existing owner. Until Stream roles are persisted explicitly,
the audited Architect override may recognize the existing `Architect` Stream
name; this fallback must be removed after all Architect Streams carry
`settings.releaseRole = "architect"`.

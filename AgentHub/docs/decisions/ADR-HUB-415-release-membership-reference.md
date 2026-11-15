# Release membership references preserve decomposition ownership

An accepted Task may already belong to an archived release's checklist. The
single `linked_task_id UNIQUE` relation remains decomposition ownership; it
must not be moved, copied into a second owner or relaxed for release preparation.

The existing checklist row gains a separate nullable `release_task_id` and
`release_reference_json`. The latter binds the exact accepted Task row revision
and complete canonical Git references. A row uses one relation kind. A release
can reference a Task once; different releases can retain their own references.
Only ownership projects `checklistParent` or authorizes absorption. References
preserve Task history and cannot be split across Workspaces or silently retargeted.

The existing MCP `link` accepts explicit `release_reference`. It requires the
real Release Manager role in the same release-enabled Workspace, repeated inside
the existing queued Task write. The transaction checks parent CAS, exact target
revision, Await/Done state, full canonical result, same Workspace and cycles.
Old requests keep their original semantic hash; exact repeats use the same
checklist receipt/outbox, including after reopening. No second ledger is added.

The ordinary installed-version schema initializer migrates the existing checklist
table in one transaction, preserving all row IDs, values, original receipts and
archived ownership; it never rebuilds Tasks. Each reference also has its canonical
Workspace key, protected by two deferred composite foreign keys to both endpoints.
Update cascades let the existing whole-Workspace reassignment move both endpoints
in one transaction, including older writers; a real split fails at COMMIT and
rolls back. There is no permission flag, side ledger or per-row workspace veto.
A reference
does not advance source acceptance or grant publication. Service closure still
requires completed members and immutable published evidence, and also checks the
captured result against each member's current canonical references. Publication
may legitimately advance a Task revision; it cannot replace the captured result.

This correction ships only through the unified release. No pre-publication
production migration, source CLI, private install or historical UNKNOWN replay
is needed. Release selection remains the canonical plan/manifest, not checklist
projection. The normal authenticated metadata operation becomes available after
the published version is installed.

## Completed metadata-only release cards

The same release-service completion owner must not create a managed checkout
merely to close a card with no implementation result. Canonical Done members
identify one repository and their exact results; the existing indexed original
reader must positively prove the entire completed publication and raw manifest.
Absent source has no legacy-publication fallback. Existing Task directories,
detached/unregistered work, branch/custody refs, extra results, changed original
receipts and unknown completion refuse. The original is reread after Git proof.

Primary main intentionally may remain at the original approved local pin. Only
the exact completed original can establish this case, with both approved pins
ancestral to the exact published candidate and tracked main containing it.
Candidate tree and all selected ancestors are checked in the actual repository.
The normal clean managed-source path remains, including ownership and unpublished
HEAD refusal. Preview/confirm, source preservation, idempotent outcome and the
post-publication application sequence remain unchanged. This closes metadata;
it does not delete archives, settle old UNKNOWN previews or certify unfinished
operational cleanup.

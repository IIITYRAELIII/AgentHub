# ADR-0061 — Separate card CAS from release acceptance identity

Status: accepted (HUB-235, 2026-09-16).

Task title/description updates and checklist writes increment row_revision.
The former release hash used that row revision and open Done audit Tasks, making
editorial updates invalidate unchanged prepared or frozen release candidates.

Keep row_revision for Task write concurrency. Add release_revision on that same
aggregate for workflow and membership transitions; exact Git references remain
part of release identity. The plan and existing manifest taskRevision field use
this acceptance revision. Hash only Await membership; retain Done as audit output.
No new readiness table, release clone, manifest format or recovery owner is added.

Completion validates accepted identity and membership in its existing transaction
and closes rows using their current CAS revision. Thus editorial updates during
publication verification survive without authorizing a changed result. Return and
reacceptance invalidate old identity even if the commit is unchanged.

Initialize the new revision once from the existing row revision. Old unchanged
candidate identities remain compatible. Completion may recognize the exact old
row-based hash including Done audit, only with the existing frozen publication
verification and strict old row checks. Changed old evidence stays rejected.
Old prepared plans whose hash changes require normal preparation again; existing
frozen files and operation receipts are never silently rewritten. Remove legacy
hash compatibility once no supported pending publication can use that form.

Standalone-clone isolation, exact source/metadata hashes, approved base and dev
integration evidence remain necessary. Manifest describes the candidate;
checkpoint records execution progress. Date changes and unchanged retries retain
identity. Validation covers real SQLite writes/CAS/migration/completion and real
Git prepare/freeze reuse, plus rejection of changed results and membership.

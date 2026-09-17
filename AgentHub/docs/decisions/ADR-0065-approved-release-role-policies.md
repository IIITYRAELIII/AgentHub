# ADR-0065 — Consolidated release and role instructions

Status: accepted

The user reviewed the release workflow, Release Manager, Team Lead and
auto-review policies in Russian. Their current generated English blocks are
replaced together, without writing live custom Workspace or Stream fields.

Task absorption has explicit criteria: duplicate outcomes or work that cannot
reasonably be implemented, checked and released independently. Sharing files
alone is insufficient. Handoff preserves requirements, unfinished work,
attachments and native Task links; validation precedes combined closure.
Closure is not publication and preserves cards/history.

The Release Manager verifies the composition recorded by the canonical
mechanism instead of maintaining another register of technical identities.
The included Tasks, branches and worktrees remain frozen by agent policy.
Abandoning an unpublished release requires reconciliation before declaring
them unfrozen; unknown publication effects cannot be treated as cancellation.
This change adds no mutation gate, database migration or cancel/unfreeze engine.
Post-publication cleanup still verifies exact current evidence and reports
publication, synchronization and cleanup separately.

A shared test environment and its lock are conditional project capabilities.
An agent acquires the lock only for actual testing and releases it on completion,
failure or cancellation. Workspace commands and the existing canonical lease
remain authoritative. No manual replacement-coordination rule is reintroduced.

Auto-review chooses the executor's provider and excludes Astra unless the user
explicitly names the reviewer Stream. An unavailable reviewer can be replaced
by the user or Team Lead with all open findings/history transferred, subject
to the same restrictions. Team Lead may implement only on explicit user request.

Both independently enabled release blocks retain the scoped user-exception
clause. Generic policy contains neither a Hub CLI nor a calendar version scheme.
Existing release authorization, publication evidence and tool integrity checks
remain in force.

The original prefix-compatibility decision is superseded by ADR-0066 at
the user's explicit request. Current generated blocks remain unchanged; custom
Workspace and Stream text is preserved without recognizing old policy copies.

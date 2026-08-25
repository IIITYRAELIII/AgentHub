# Agent Hub release registry model

## Why a registry exists

All Streams currently edit one shared working tree. Git can show the aggregate
diff but cannot tell which logical task owns each change or whether its owner
considers it complete. The registry is therefore still necessary as a
coordination ledger until Stream worktrees are isolated.

## Current legacy model

1. A terminal provider turn with changed files records one legacy entry keyed by
   provider, provider thread and turn.
2. A completed turn becomes `ready` immediately; another terminal outcome
   becomes `blocked`.
3. Files are inferred from patch observations plus the aggregate shared-tree
   baseline diff.
4. The release plan hashes active rows and rejects cross-Stream path overlaps.
5. Release completion marks the frozen ready rows `released`.

This model freezes a claim about ownership, not the bytes to be delivered. A
later edit can change the shared file while the ready row remains unchanged.
Multiple turns for one task create multiple entries, a post-release status turn
can create a late entry, and path equality cannot distinguish compatible hunks
from real conflicts.

## Target model

- `ChangeSet`: one logical task, owner Stream, lifecycle and revision.
- `TurnObservation`: provider turns that contributed evidence to the ChangeSet.
- `ChangeFile`: repository, path, operation, base blob and result blob/patch hash.
- `ReleaseBatch`: frozen plan, repository revisions and deployment evidence.

The first mutation creates or resumes a draft ChangeSet. Provider completion only
adds an observation. The owner explicitly freezes `ready`; the freeze requires a
nonempty manifest hash and immutable file evidence. New edits reopen or amend a
new revision. Architect integrates the frozen evidence and records an audited
batch.

## Removal decision

Do not delete the registry while Streams share a tree: that would remove the
only ownership/readiness signal. First dual-write the target model, migrate new
work to isolated Stream worktrees, finish all legacy active entries, then retain
the legacy table as read-only audit history.

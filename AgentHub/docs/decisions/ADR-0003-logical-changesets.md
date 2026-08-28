# ADR-0003 — Logical ChangeSets and isolated worktrees

## Status

Superseded as live authority by ADR-0005. Its isolated-worktree direction and
immutable Git evidence are retained and refined there.

## Decision

Release ownership moves from one auto-ready entry per provider turn to one
explicitly frozen ChangeSet per logical task. Turn observations remain audit
evidence. New Streams ultimately work in isolated Git worktrees; Architect
integrates frozen commit ranges in a separate integration worktree.

## Consequences

The registry becomes a patch ledger rather than a claim over shared paths.
Compatible hunks can coexist, stale and late turns cannot silently enter a
release, and Git three-way merge replaces path-only overlap heuristics.

The former dual-write migration was transitional only. ADR-0005 removes
ChangeSet and legacy registry live authority after verified Task cutover.

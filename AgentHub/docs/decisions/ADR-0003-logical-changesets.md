# ADR-0003 — Logical ChangeSets and isolated worktrees

## Status

Accepted target architecture; staged migration pending.

## Decision

Release ownership moves from one auto-ready entry per provider turn to one
explicitly frozen ChangeSet per logical task. Turn observations remain audit
evidence. New Streams ultimately work in isolated Git worktrees; Architect
integrates frozen commit ranges in a separate integration worktree.

## Consequences

The registry becomes a patch ledger rather than a claim over shared paths.
Compatible hunks can coexist, stale and late turns cannot silently enter a
release, and Git three-way merge replaces path-only overlap heuristics.

Migration is dual-write first: terminal turns append observations while the
legacy release plan remains authoritative. Explicit Stream roles and frozen
manifest planning are required before the compatibility ledger and Architect
name fallback can be removed.

# ADR-0051 — Task journal and on-demand Git review

Status: accepted
Date: 2026-09-15
Contracts: UI-001, REL-001, PERF-001, MCP-001

## Context

The Task card read the removed changedFiles field. Work-log writes had no
production caller. Exact Task/turn bindings and terminal journal records survived.

## Decision

Replace the obsolete file list with explicit Git diff for the exact managed Task
worktree, from its stored base commit to current tracked and untracked contents.
Do not stage, commit, integrate or publish to obtain a preview. Disable external
diff and textconv, exclude Task-excluded CHANGELOG files, bound preview output
and visibly report truncation or errors. This is an observation, not immutable
release evidence. Refuse missing worktrees and mismatched ownership.

Project history by joining exact provider/thread/turn bindings to the persisted
journal. Include terminal turns without changed files; exclude provisional,
aggregate and probe records. Multiple bindings of one Task to one turn produce
one entry. Journal revisions invalidate board caches. Links retain provider,
task Thread, source Thread and turn identity.

## Migration

Existing exact bindings reveal retained journal records without backfill writes.
Preserve legacy work-log entries only where no matching terminal journal entry
is available. Remove this compatibility path when supported databases no longer
retain pre-journal work logs. Never reconstruct missing history from text or time.

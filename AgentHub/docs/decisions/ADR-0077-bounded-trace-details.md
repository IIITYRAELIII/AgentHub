# ADR-0077 — Bounded trace previews with explicit source details

## Decision

Adopt the Sol6 benchmark's bounded copy-on-write rollout preview, exact-turn
history cloning and revision-keyed fact cache. Keep complete provider sources
and the existing terminal/history/accounting owners authoritative.

Close the preview's missing-detail gap through the existing task-history route:
an explicit page request scans an immutable-length source prefix in the rollout
worker, returning a bounded page and generation/length/hash cursor. Pagination
replaces the previous page. It does not run during ordinary snapshot refresh.
Reject missing, oversized, changed or ambiguous evidence instead of shortening
text or guessing an occurrence.

The version-1 annotation schema gains optional traceGroupId for new reasoning
quotes. Canonical content hashes bind one full group and the original provider
item identity. Old locators keep their old semantics. UI navigation verifies
all three hashes before highlighting, including after an exact source read.

## Consequences and limits

- Raw transcripts, final answers, receipts and journal facts are not trimmed.
- Explicit reads retain bounded memory but rescan the fixed prefix on each page;
  large sources can therefore take time. Missing local sources remain unavailable.
- Duplicate source IDs fail closed. Anonymous legacy sequence IDs have no
  cross-tail identity guarantee; hash checking prevents a guessed highlight.
- A reasoning block over 512 KiB cannot be transported by this detail endpoint;
  the error leaves its full source untouched.
- Cache byte budgets describe serialized payload, not total RSS or JS heap.
- Fact cache revision and data share one read transaction. Full account
  aggregation and cold reconstruction remain necessary.
- Behavioral evidence covers real worker reads, source preservation,
  append/rewrite/ambiguity, SQLite external updates/deletes/rollback/restart,
  exact history routing and browser paging/citation navigation.

# SYS-002 — Workspace cards and permanent archive

## Archive and deletion

- Archiving a user Workspace is reversible and has no deadline. Startup clears
  every legacy `purge_after_ms` value before archive data is projected, and no
  elapsed-time cleanup remains.
- System Workspaces cannot be archived or permanently deleted.
- Permanent deletion is available only from the archive UI and requires the
  complete current Workspace name with exact case.
- The catalog reads the current row after `BEGIN IMMEDIATE`, validates its name,
  user kind and archived state, and repeats the current name and update revision
  in the delete compare-and-swap. Rename or restore before the transaction makes
  stale confirmation fail closed.
- The production run coordinator owns a bounded in-memory marker from entry into
  direct, deferred, or durable client-input admission through persistence,
  preflight and launch. A scheduled durable item revalidates that its Stream
  still exists immediately before run registration, so a delete that wins the
  scheduler gap prevents provider launch. The marker and active-run registry are checked immediately before the
  synchronous catalog transaction. The JavaScript event loop cannot admit a new
  local run between that final check and commit. Agent Hub's single-instance
  owner remains the authority for local run admission; this feature introduces
  no parallel lease, receipt or recovery engine.
- Workspace deletion and Dashboard Task assignment share one SQLite writer
  boundary. A Task committed first blocks deletion. A deletion committed first
  leaves a durable Workspace fence whose insert/update triggers reject later
  Task attachment. Failure rolls back both fence and deletion.
- Exact retry after deletion returns the same `{id, name, deleted: true}` result;
  a different confirmation name fails. A permanently deleted Workspace ID is
  not reusable.

## Cards and menus

- Workspace and Stream cards use native click and double-click events without a
  click-delay timer. Double-click is accepted only for the original connected
  node and stable identity; removed, replaced or reordered cards fail closed.
- A known Codex or Claude Stream menu contains Edit, Rotate and exactly one
  opposite-provider continuation command. Missing or unknown provider exposes
  no enabled continuation command.

## Provider Thread names

- A new Hub-created Codex Thread uses `Workspace — Поток N`, where the number
  is the bound Stream's durable ordinal. An explicitly named Stream contributes
  its exact name instead of `Поток N`, including when it is the only Stream.
  Workspace/Stream UUIDs, the first message and transport timestamps are not
  naming sources. Creating a Thread never renames its Workspace implicitly.
- The durable Workspace/Stream binding precedes the provider name write. The
  existing pinned-title and expected-title stores retain the intended name for
  normal catalog reconciliation; naming introduces no second identity owner.
- Rotation transfers the compaction result and only the ordered suffix of the
  compacted turn after that exact compaction: turn items before it are already
  represented by the compaction and are never transferred again. The boundary
  is the single rollout `compacted` record whose replacement history carries the
  transferred compaction item. An empty suffix is valid; a missing or
  non-unique boundary refuses the transfer before a new Thread exists.
- Rotation proves readiness before any authoritative switch: create the new
  Thread, inject the bounded compaction transfer, then freshly read that exact
  Thread and require its status to be `idle`. These steps never start a model
  turn or request a generated measurement. Only that successful read permits
  catalog binding, selection and deferred-input retargeting. Failure keeps the
  source authoritative, attempts to delete the unbound target, and releases the
  maintenance reservation through its existing owner. A failed automatic
  rotation is not retried for the same compaction.
- The successful `rebirth` binding owns the target's managed title through normal
  Workspace/Stream naming. Existing explicit custom titles remain preserved;
  discovered foreign Threads are not renamed. No measurement-specific title
  repair, startup scan or provider call is added.
- The post-compaction percentage is a preliminary provider estimate. It belongs
  to the same exact Thread, turn and current compaction, requires a finite
  observation timestamp at or after the compaction boundary, and is labelled
  `estimated`. The first valid estimate is retained; later normal user-turn
  usage cannot replace that historical value. Missing evidence stays unknown.
  Rotation neither generates nor invents a target after-transfer percentage.

## Quick replies and quote input

- Quick replies persist as ordered `{title, text}` entries. Legacy strings
  migrate to identical title/text values.
- Click inserts reply text at the active quote-comment caret, falling back to
  the composer. Ctrl+click sends only reply text and does not mutate the current
  composition.
- In quote comments, Enter sends once, Shift+Enter and Ctrl+Enter insert a
  newline at the caret, and Meta+Enter preserves the main composer steer action.
  IME composition, repeated keydown and a pending send cannot duplicate it.

See [ADR-0021](../decisions/ADR-0021-permanent-workspace-archive.md).

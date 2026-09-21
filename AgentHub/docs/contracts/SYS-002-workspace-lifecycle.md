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

- Workspace creation and editing show an independent **Авто-ревью** checkbox
  immediately after **Релизный процесс**, with a separate help control.
  `settings.autoReviewEnabled === true` injects the review policy into all
  Workspace Stream contexts; absent or false leaves it out, independently of
  release workflow. Settings updates that omit this field preserve its current
  value. Generated instructions do not become authored Workspace rules.
  The short Team Lead help describes delegation, not review forwarding.

- Workspace and Stream cards use native click and double-click events without a
  click-delay timer. Double-click is accepted only for the original connected
  node and stable identity; removed, replaced or reordered cards fail closed.
- A known Codex or Claude Stream menu contains Edit, Rotate and exactly one
  opposite-provider continuation command. Missing or unknown provider exposes
  no enabled continuation command.

## Server account cards

- Account cards display the provider's current account email or authentication
  method, separately from the state of a login attempt. Idle/succeeded attempt
  history never proves current authentication. Missing or failed account reads
  are unknown; only an explicit provider response establishes signed-out state.
- The existing login service owns this ephemeral display projection. Codex uses
  account/read without token refresh; Claude uses auth status --json in the same
  configured invocation as login. Reads are bounded, coalesced per provider and
  refreshed on snapshot access after 30 seconds, without blocking snapshots.
  Account-change notifications invalidate earlier reads before refreshing.
- Shared snapshots contain only allowlisted display state, email and method,
  never credentials, login URLs, account IDs or raw CLI output. This projection
  is not usage-attribution evidence and does not alter running turns or auth.

See ADR-0067.

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

## Squash-absorbed Task cards

Exact squash absorption never deletes either Task card or its audit history.
The survivor remains in Test with a new release identity; the source returns to
work and carries the immutable transfer outcome linking it to the survivor.
Both row updates are one SQLite transaction after exact Git readback. Ordinary
edits and lifecycle operations are excluded from both cards while that shared
transition is active. After durable publication, explicit confirmed completion
may close the source and remove only its exact clean branch/worktree; the card
and lifecycle outcome remain available as history.

The bounded local squash bootstrap is the only exception to the ordinary
Test-to-Test admission precondition. It may start with the survivor in Progress
only when that survivor still has its exact previously accepted Test result and
the source remains in Test. The pending lifecycle transition does not project a
synthetic Test state. The survivor becomes Test, and the source returns to
Progress, only in the same two-row commit after exact cutover and squash Git
readback. All ordinary public squash calls continue to require two Test Tasks.

## Published duplicate Task cards

A Release Manager may close an open zero-own-delta duplicate into an already
Done survivor only through the explicit published-duplicate absorption mode.
The durable source card and history remain available and link to the exact
survivor; the operation does not assign the survivor's result to the source or
fabricate a squash outcome. The source branch/worktree is preserved. Ordinary
absorption still requires an open tested survivor, and ordinary Complete still
requires workflow Done.

# SYS-002 — Workspace cards and permanent archive

## Archive and deletion

Catalog mutations composed inside one synchronous catalog transaction retain
that outer SQLite owner. Nested operations use savepoints: an inner refusal
rolls back its own writes, and an outer refusal rolls back all nested writes.
Workspace layout migration therefore retains one atomic backed-up application,
including Thread rebinding and its migration marker. No second queue, connection
or migration authority is introduced.

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

- The Codex Stream model dropdown ends with the separate action
  **Обновить доступные модели** after all model values. It invokes the existing
  catalog refresh owner without changing or saving a model. Pending refresh
  disables that action; catalog failure preserves the saved model and permits
  an explicit retry, including when no selectable catalog is available.

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

- A new Hub-created Thread uses `Workspace - Stream N` (ASCII hyphen). An
  explicitly named Stream contributes its name; an unnamed Stream uses
  `Поток <Stream ordinal>`. N is the exact binding's durable `position`, not the
  Stream ordinal or a number parsed from a title. Whitespace is normalized and
  the 80-character bound preserves the numeric suffix.
  Workspace/Stream UUIDs, the first message and transport timestamps are not
  naming sources. Creating a Thread never renames its Workspace implicitly.
- The catalog allocates position, advances its high-water and persists the exact
  naming intent in one transaction before a provider name write. First allocation
  initializes high-water from max confirmed current positions (new Stream: 0).
  This explicit legacy baseline cannot recover unknown deleted/moved history.
  Replay of an exact binding consumes nothing. Rebind/split preserve source
  high-water and allocate target positions through the same catalog owner;
  gaps remain valid ordering keys. Moving an existing Thread is not creation
  and supersedes an unfinished intent without automatically renaming it.
  Naming revalidates that exact binding/intent after each asynchronous step and
  before another provider dispatch or title projection. Supersession cancels
  further effects with an explicit authority-changed error, not a pending retry.
  A provider write dispatched while authority was valid cannot be recalled;
  its late acknowledgement/readback does not authorize stale local projections
  or an automatic corrective rename. No SQLite transaction spans provider I/O.
- The existing naming service owns create, rotation and pending-name recovery
  on normal resume or before first input. Codex requires `thread/name/set` and
  exact metadata-only `thread/read` name/identity confirmation before completion.
  Lost replies retain the intent and read back that same Thread, never create
  another or increment N. An unconfirmed name blocks provider input and remains
  a visible naming error; independent settings/projection errors are preserved.
  Resume timeout or post-resume naming failure does not authorize replacement;
  definitive resume-not-found or wrong-project evidence retains legitimate
  startup recovery. No timer, table sweep or second recovery owner is added.
- Pinned/expected titles remain projections. Claude receives the same canonical
  Hub name with explicit `providerRename=unsupported`, not a false native-rename
  success, transient error or permanent pending retry. No provider DB/transcript
  writes are introduced. Legacy/discovered bindings without an intent and
  completed explicit custom titles are not automatically renamed. Bounded
  legacy correction requires an exact preview and explicit supported rename.
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
  discovered foreign Threads are not renamed. Rotation's confirmed naming uses
  the same owner as creation; no measurement-specific repair or startup scan
  is added. Selection, client and deferred titles retain the canonical name.
- The post-compaction percentage is a preliminary provider estimate. It belongs
  to the same exact Thread, turn and current compaction, requires a finite
  observation timestamp at or after the compaction boundary, and is labelled
  `estimated`. The first valid estimate is retained; later normal user-turn
  usage cannot replace that historical value. Missing evidence stays unknown.
  Rotation neither generates nor invents a target after-transfer percentage.

## Quick replies and quote input

- In the main composer, Ctrl+Enter and Shift+Enter insert a newline at the
  caret or replace selected text. Ctrl+Enter does not submit or execute an open
  slash-menu command. Desktop Enter keeps normal send/queue behavior, Meta+Enter
  keeps its steer behavior, and mobile Enter remains a newline. IME composition
  does not submit or select a slash command.
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

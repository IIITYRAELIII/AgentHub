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
- Rotation proves readiness before any authoritative switch. The new Thread is
  probed while still unbound. Only a completed probe with an exact usage
  measurement allows binding it to the Stream, retargeting the selection,
  client selections and deferred inputs, and recording the rotation together
  with that probe's turn identity and measurement time. A definite failure
  deletes the new Thread: either its probe turn ended unsuccessfully, or every
  accepted probe attempt that did not materialize was then observed terminal in
  the Thread itself. An acknowledged interrupt request alone is not that
  evidence. An unknown outcome — an accepted probe could not be interrupted or
  its stop was not observed, the probe did not settle, stayed active or produced
  no exact measurement — stops without a further attempt, leaves that Thread
  untouched and records it as quarantined on the source compaction operation. In both cases the source Thread stays
  authoritative and its queue is woken normally. One compaction receives at most
  one rotation attempt; a later compaction may try again.
- Before its readiness probe the unbound rotation target is named from the
  source Thread's Workspace and Stream, so probe text and responses cannot
  become its title. Nothing is pinned for the unbound target; its `rebirth`
  binding after readiness owns the managed title. Existing explicit custom
  titles are preserved. Probe title repair has bounded provider calls; failure
  does not prevent the probe, and repair after confirmed idle cannot hold
  admission. Normal pinned/expected-title reconciliation retries the intended
  name and excludes probe text from title history.
- Probe-time title preservation applies only to exact bindings marked `created`
  or `rebirth`, using their current Workspace and Stream, and to an unbound
  rotation target named from its bound source. Foreign and merely discovered
  Threads remain untouched. Naming adds no bulk legacy-title repair work or
  provider calls to catalog discovery or startup.

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

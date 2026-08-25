# Agent Hub stabilization roadmap

This roadmap converts the accepted contracts into staged changes. A phase is
complete only when its exit criteria are observable; a code patch alone is not
completion.

## Phase 0 — Governance and evidence

- Keep accepted contracts and ADRs machine-indexed.
- Require affected contract IDs in Agent Hub changelog entries.
- Preserve a bounded incident map and command-stage telemetry.

Exit: `contracts:check` succeeds and changed paths can be mapped with
`contracts:affected`.

## Phase 1 — Durable command boundary

- Add one command ledger keyed by `clientUserMessageId`.
- Move local durable ACK ahead of full state, catalog, history and cleanup work.
- Reconcile same-ID retries without a duplicate provider effect.
- Dual-read legacy receipts and deferred intake during migration.
- Choose one occupancy aggregate; queue and run admission cannot disagree between
  Stream-wide and Thread-wide ownership.

Exit: crash and lost-response fixtures recover one command; concurrent full
state writes cannot delay or erase compact intake.

## Phase 2 — Terminal transaction and outbox

- Commit terminal status, final content and revision before releasing admission.
- Deliver live/history/UI projections from a durable terminal outbox.
- Track channel intents separately as projected, outbox-created and acknowledged;
  a crash between terminal commit and channel delivery must remain repairable.
- Make terminal state absorb late progress and reconnect snapshots.

Exit: restart and immediate next-turn scenarios preserve one complete final.

## Phase 3 — Canonical UI projection

- Replace optimistic/queue/active/history pairwise merges with one entity store.
- Separate user turns from probes, measurements and maintenance operations.
- Mark exact visible final revisions read without awaiting history hydration.

Exit: reordered snapshots cannot duplicate, hide or revive a terminal entity;
opening a Stream clears unread in one interaction.

## Phase 4 — Logical release ChangeSets

- Dual-write logical ChangeSets and turn observations.
- Require explicit ready freeze with immutable patch evidence.
- Stop terminal turns from producing auto-ready release intent.
- Migrate new Streams to isolated worktrees and Architect integration worktree.

Exit: one logical task produces one frozen ChangeSet; stale/late turns do not
enter the release; compatible hunks are integrated by Git evidence.

## Phase 5 — SLO and fault matrix

- Instrument every command stage from client submit to terminal visibility.
- Publish local ACK, intake, dispatch, provider and projection metrics separately.
- Exercise burst, large state, SQLite lock, crash boundary, lost response,
  duplicate/reorder and restart sweeps.

Exit: PERF-001 budgets pass in Test Contour and the same-ID correctness matrix
reports zero duplicate effects and zero lost acknowledged commands.

# TURN-001 — Terminal turn commit and delivery

Audit byte cursors and completed historical work remain durable across restart.
Removing context measurements does not authorize a history rewrite, periodic
full-history scans or resubmission of provider operations.

## Identity and owner

A provider run is identified by `provider + threadId + turnId`. A terminal
revision extends that identity. The terminal record is the only durable owner of
final status and final content.

The minimal `provider_run_terminals` lifecycle ledger is not a second final or
delivery owner. The managed-run completion boundary records only the immutable
normalized outcome (`completed`, `failed` or `aborted`) needed by external
ownership recovery such as a surviving manual Test Contour helper. It contains
no final content, message command identity or outbox and cannot satisfy or alter
the terminal projection invariants below. Codex's ordinary terminal record
remains authoritative for its final status/content and is also valid lifecycle
evidence; Claude uses the minimal record because it has no Codex delivery
terminal.

## Invariants

- Terminal status, final content, usage identity and last-message identity are
  committed before admission or queue ownership is released.
- The post-turn reservation is acquired before admission release. Once the
  terminal is durable, admission completion starts reserved post-turn
  maintenance independently of outbox delivery. A stalled delivery cannot hold
  an otherwise idle Stream in preparation. The existing maintenance reservation
  has an exact identity: cancellation before provider start releases only that
  preparation and wakes the original queued input. Late idle checks and cleanup
  cannot start work or release a replacement reservation. Cancellation after
  provider start is not reported as confirmed without provider evidence.
- Post-turn context idle checks bound awaited rollout discovery and observation
  by one deadline. If the check cannot establish inactivity before that deadline,
  no compaction is started; its reservation is released and the original queued
  input is woken through normal admission checks. Late read completion cannot
  resume the abandoned check or start provider work. A read timeout is not
  evidence that an already-started provider operation has finished.
- A Codex `task_complete` event carrying an error is a failed terminal, not a
  successful empty answer. Exact-turn, tail and historical readers retain the
  same outcome. Context maintenance does not generate a user turn, and terminal
  reconciliation has no special prompt, client-ID or response-text classifier.
- Optional rollout usage, pricing and tool-metadata reconstruction never delays
  terminal commit or admission release. The terminal audit resumes from its
  durable append-only byte checkpoint and reconciles that metadata afterward.
  A cold exact-turn lookup locates the matching turn start by scanning backward
  from the rollout tail, then reads forward only from that boundary.
- Turn-start hooks, managed-run admission, observers and terminal audit never
  capture Git baselines. Task file ownership is handled separately by REL-001
  Task worktrees and the explicit `Await` snapshot.
- The authoritative provider final is retained byte-complete by the terminal
  projection; live-preview bounds must not truncate durable final content.
- A provider completion event is not sufficient evidence to persist a known
  prefix while the authoritative final is still materializing. Terminal commit
  uses the exact reconciled provider final after a bounded settle window.
- A managed Claude result does not release its exact process owner while the
  provider tree is still live. Completion closes input, gives the provider a
  bounded nonzero graceful-exit window, and verifies the exact root and
  descendant identities even when the root has already exited. A remaining
  live tree receives one owner-verified, deadline-bounded stop before terminal
  delivery. Exact stop targets and an unknown-outcome fence are durable before
  the first external stop effect. An unconfirmed stop retains the run,
  descendant identities and the same in-flight stop attempt; it cannot
  authorize another killer by numeric PID alone or after restart.
- Terminal is absorbing: late running, progress, snapshot or reconnect events
  cannot revive it.
- A bounded restart or opened-history-page reprojection may replace a corrupted terminal user
  projection only when the retained terminal payload and command ledger prove
  the same non-empty `provider + threadId + turnId + runId` for every distinct
  Hub command identity. Missing, duplicate or conflicting proof fails closed;
  successful reprojection preserves terminal state and never dispatches again.
- Live, focused, history and badge views derive from the same terminal revision.
- Terminal completion and history payloads retain the raw root prompt separately
  from body-only live user projections. Their `clientUserMessageId` is nonempty
  and at most 200 characters; invalid or conflicting provider identity and its
  origin are omitted before `payload_json` and outbox serialization.
- Versioned response-annotation source locators for user, final agent and
  non-final agent provider items attached to the turn prompt are
  retained byte-for-byte through terminal history persistence and reload after
  intake validation; terminal coalescing cannot strip or retarget them.
- Delivery uses a durable outbox. A missing UI ACK retries delivery without
  reverting terminal state or regenerating the provider effect.
- Recovery may stage a bounded batch of exact outbox revisions and perform one
  shared journal projection. Every revision remains unacknowledged until its
  history and journal data are persisted and the shared projection succeeds.
  Projection failure preserves retryability; a superseding revision retains its
  own delivery identity. Ordinary live completion does not wait for a batch.
- The durable terminal outbox is the sole retry owner for terminal projection.
  A projection revision is acknowledged only after canonical readback confirms
  its exact journal record, matching immutable accounting fields in the
  deterministic usage fact, and a turn index produced from a journal revision
  at least as new as that record. The index and its source revision are replaced
  atomically by the existing journal projection owner.
  An already-complete projection is acknowledged without rewriting richer
  display metadata or account attribution. Projection-only recovery never
  repeats the provider turn, command trace or Telegram delivery.
- Transient SQLite busy/locked and journal-revision conflicts receive one
  runtime-scoped, bounded single-flight retry with capped backoff. Conflict
  recovery re-reads the exact projection before another write. A retry of an
  already durable terminal cannot infer its historical account from the
  runtime's current ambient account; independently persisted attribution may
  still be retained or enriched by its existing evidence owner.
- Projection recovery reads only projection-pending outbox rows in durable
  least-recently-attempted order. A bounded page of permanent failures moves to
  the back without starving later rows. Exhausted fast retries and enumeration
  failures remain eligible for the existing owner's low-frequency pass; no
  zero-delay full-page loop is allowed.
- A later user turn cannot suppress or mutate the previous terminal entity.
- Projection overlays the exact latest terminal independently of a later active
  turn, so both entities remain visible in provider sequence.
- Generated response attachments belong to the exact provider turn and are
  materialized into both the terminal completion and its history snapshot.
  Importing a file for live history is not evidence that terminal persistence
  contains it.
- A richer exact-turn terminal revision supersedes an earlier empty revision.
  Notification deduplication must not discard generated attachments merely
  because the same terminal identity was already delivered without them.
- Attachment projection may update the same final card after a short bounded
  materialization delay, but it must not require a page refresh, reopening the
  Stream or another user turn.

## Generated attachment runbook

When a final answer mentions a generated image but the final card has none,
inspect the chain in this order:

1. Confirm that the provider created the image under its generated-image root.
2. Confirm that the rollout associates the generated-image source with the
   exact terminal `turnId`.
3. Confirm that the attachment importer created the durable private copy.
4. Inspect `provider_turn_terminals.payload_json`: both
   `completion.responseAttachments` and `history.responseAttachments` must
   contain the same generated attachment IDs.
5. Confirm that the latest terminal revision, rather than an earlier empty
   revision, reached the projection outbox and final card.

Required regression coverage includes direct ImageGen, multiple ideate outputs,
an empty terminal delivered before a richer generated-image revision, and
exclusion of viewed or supplied input images from generated response outputs.

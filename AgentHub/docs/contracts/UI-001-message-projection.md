# UI-001 — Canonical message projection

## Invariants

- Optimistic, queued, active and historical forms of one command are one entity
  keyed by `clientUserMessageId`, not separately appendable cards.
- Provider entities use `provider + threadId + turnId`; items additionally use
  `itemId + role`.
- `clientUserMessageId` is the sole Hub ownership signal for a user message.
  Provider `itemId`, text, time, position and Hub-shaped strings cannot adopt or
  erase another occurrence. Full-snapshot replacement requires explicit source
  authority; bounded or otherwise unproven observations remain incremental.
- Replayed incremental observations coalesce only by an internal
  `sourceOccurrenceId` bound to an immutable source generation and exact record
  occurrence. Codex rollout identity uses one validated canonical `session_meta`
  generation plus the exact raw record start byte coordinate and canonical
  structural-record fingerprint. The coordinate comes directly from bounded
  Buffer reads rather than decoded/re-encoded text or filesystem metadata and
  remains stable when an older equal record leaves a moving tail. Missing,
  malformed or conflicting
  provenance projects no unkeyed provider user, so replay cannot append aliases.
  A later equal record has a different occurrence and remains visible. Capped,
  evicted, malformed, partial or bounded source data is never exposed as a
  complete per-turn projection. The App Server adapter retains its exact source
  occurrence when `clientUserMessageId` arrives later; this same-source evidence
  replaces the earlier unkeyed entity and preserves Hub payload/origin.
- `unknown` is displayed as unknown and never inferred as running.
- Internal probes, measurements and maintenance operations have separate kinds
  and never create user-turn cards.
- Unread state is computed from the latest canonical final revision versus a
  monotonic account read cursor.
- `mark-read` names the exact final revision already shown to the client; history
  hydration remains background work.
- Current Codex limits expose every available provider window separately. A
  healthy short window cannot hide an exhausted longer window for the same model.
- Codex response-annotation locators cross the provider boundary as unique
  positive safe-integer indices in the provider annotation range `1..20`,
  never as service markup. The trusted Codex parser consumes every complete
  line-start marker with a quoted index payload before validating the payload;
  invalid payloads retain only a readable generic fallback and do not enter
  structured state. Partial markers remain hidden while streaming. The UI
  resolves each valid index to the nearest preceding annotated user entity by
  its canonical message key,
  renders the user's annotation/comment text and exposes a keyboard-operable
  jump to that exact annotation card only when the target annotation exists.
  Missing mappings render non-interactive
  `Цитата N`. User-authored marker-like literals and code remain ordinary user
  content.
- A new user-created annotation records its exact source user or agent provider
  item, including an active non-final agent item, one
  versioned rendered surface, a bounded UTF-16 range and SHA-256 boundaries for
  canonical message content, surface content and selected content. Equal text
  is not source identity. Clicking the user-created annotation card validates
  every source boundary, reveals a hidden source trace when necessary, scrolls
  and focuses that exact source surface, and temporarily highlights only the
  addressed range across Markdown DOM splits. Clicking a response citation
  instead scrolls, focuses and temporarily highlights the corresponding user
  annotation card. A missing, stale or malformed locator cannot highlight
  another source range and does not change the response-citation target.
  A user-created annotation card is keyboard-operable only when it owns a valid
  locator. Legacy annotations
  without a locator keep the annotation-card jump and are never backfilled by
  text, time or display order.

## Canonical reducer

The client projection has one reducer. User submissions are keyed by the alias
set `clientUserMessageId + submissionId`; either alias binds the optimistic and
canonical forms without using text, time or display order. Provider turns are
keyed by `provider + threadId + turnId`; item entities additionally include
`itemId + role`. Canonical intake atomically replaces its optimistic projection.
When the client snapshot says the Stream is idle, the exact submission is
rendered immediately as one optimistic conversation card. A durable
`message-intake` ACK keeps that same card visible through dispatch and labels it
`Принято`, never `В очереди`. The durable deferred row with
`clientProjectionIntent=conversation` preserves that placement through an
idle-to-busy admission race and when the bounded receipt is absent during
reload or reconciliation.

When the client snapshot says the Stream is busy, queue and steer submissions
are rendered only by the queue surface above the composer. Durable queued,
dispatching, ambiguous and attention-required forms remain queue-owned until
exact provider acceptance. A new turn requires the exact command identity plus
`runId + turnId`; a steer requires `steered=true` plus the exact target
`turnId`. An active run snapshot is accepted only when `run.turnId` equals
`run.providerStart.turnId` and provider-start state is
`accepted-awaiting-first-event` or `observed`. Optimistic, queue, active and
history projections reuse the same `clientUserMessageId` and cannot create a
second card.

If admission detects that an apparently idle Stream became busy, its canonical
`task-running` result preserves the same optimistic conversation card according
to its immutable `clientProjectionIntent=conversation`. A busy-origin command
with `clientProjectionIntent=queue` remains queue-only if admission later finds
the Stream idle. Attention-required and ambiguous commands remain queue-owned.
Reconciliation never renders both forms and never loses the logical entity.

Direct ACK, remote-result reconciliation and snapshot reconciliation use the
same classifier. Receipt snapshots are bounded. The durable explicit projection
intent restores the chosen surface after its receipt leaves the current window.
Legacy rows without that field use exact `conflictKind=message-intake` only as a
temporary compatibility boundary; remove it after every retained active command
has an explicit projection intent. Text, time and display order cannot choose
the surface or promote a command into history.
The server applies a receipt only to a user item that already carries its exact
`clientUserMessageId`; receipt count or ordinal position never supplies identity.
Service-only attachment wrappers such as `<image ...>` are removed from both the
main text and annotation request while the attachment object remains visible.
Server-side live, durable, rollout and completion merges share one ownership
rule: accepted payload and origin win for an exact `clientUserMessageId`, while
provider metadata may enrich that same entity. Provider item IDs and generated
ID shapes never establish occurrence identity: colliding, identity-free and
identical provider occurrences remain separate in mixed and migrated turns.
An internal source occurrence coordinate may suppress replay of that exact
observation, but it never adopts a Hub command identity.

History and Journal search documents are independent projections. Rebuilding a
turn's History-owned documents cannot delete or overwrite Journal-owned
documents, and repeated reopen/recovery preserves the same source groups.

Terminal states are absorbing. For one provider-turn identity, a committed
`terminalRevision` wins over every late active/progress/reconnect observation;
lower or duplicate revisions cannot revive the turn. A known positive revision
also absorbs later legacy revision `0`, while a positive revision may upgrade
legacy revision `0`. At the same revision, the durable canonical projection wins
over a temporary terminal overlay; a higher overlay revision still wins over
older durable history. `unknown` is a distinct state and is never projected as active.
The client considers final content caught up only on exact text equality for the
exact provider turn. Prefix equality never proves that a complete final was
rendered and cannot stop history refresh or remove a completion overlay.
Canonical ordering follows durable provider sequence without rewriting user
chronology. Durable intake owns immutable `submittedAt`, which remains the
displayed `time` through queued, active and completed projections. Provider
dispatch owns the separate `startedAt`. Legacy rows without `submittedAt` fall
back to the existing user-message time and only then to provider start.

Unlabelled fenced blocks are treated as prose-oriented preformatted text and
wrap inside the message column without horizontal page movement. Fences with an
explicit language preserve code whitespace and may scroll horizontally. Both
presentations copy the original unmodified block text.

## Legacy chronology

Legacy turns without a timestamp keep their durable provider position relative
to adjacent turns across SQLite pagination, provider hydration, reconnect,
journal overlay and reload. Their missing time remains `null`; a read model never
replaces it with the observation time or uses text/time as entity identity.

## Operation kinds

Every live projection has an explicit `operationKind`. Only `user-turn` may
produce user-visible running state. `probe`, `compaction`, `measurement` and
`maintenance` may have dedicated system presentation but cannot create or revive
a user-turn card. An explicit non-probe `operationKind` or ordinary
`clientUserMessageId` is authoritative user-operation identity even when the
prompt or final output exactly equals the reserved context-probe sentinel.
A task snapshot with no active run is authoritative after any available
completion has been promoted: it removes the cached live card, probe and
live-user projection even when the previous card was a valid `user-turn`.
Queued inputs remain represented by the queue surface and cannot keep a drained
run card alive while waiting for, or after completing, later turns.

## Read protocol

The snapshot exposes the latest final as
`provider + threadId + turnId + revision`. After rendering that final, the client
sends `mark-task-read` with the exact identity. The server compares it with the
current latest final and advances the account cursor only on an exact match;
stale requests are rejected with the newer identity and retries are idempotent.
Snapshot receipt alone is not display evidence: acknowledgement is emitted only
after `applyOpened` rendered a terminal card with the same exact identity and
revision. Startup snapshot-before-history therefore cannot clear unread state.
The persisted cursor is monotonic even when an older request finishes last:
`answerAtMs` orders different completion times, a higher revision orders the same
turn at an equal time, and the exact `turnId` is the deterministic tie-break for
different turns completed at the same millisecond. A lower canonical tuple cannot
replace the stored cursor.
Cached history may be returned with the open response, but provider/history
hydration starts strictly as background work and is never awaited by mark-read.

## Migration guards

- Pre-UI-001 terminal records without `terminalRevision` are projected as
  revision `1` and carry `migrationGuard=legacy-terminal-revision`. Remove this
  after one supported release has rewritten every retained terminal record.
- Pre-UI-001 live/message records without `operationKind` use guards explicitly
  labelled `legacy-*`. Text matching is permitted only for the historical
  context-probe sentinel when the record also lacks any client operation identity;
  it is never entity identity and cannot override an ordinary
  `clientUserMessageId`. Remove these guards after all retained snapshots and
  history rows carry explicit operation kinds.
- A retained pre-origin MCP message may recover inter-Stream provenance only by
  exact `mcp:<requestId>` lookup of a successful audited
  `hub_stream_message_send`, `hub_task_start` or `hub_task_reassign` operation.
  Its source Workspace and Stream are rendered with the explicit service marker
  `Служебное`; text, time and display order are never attribution evidence.
  Remove this read-only guard after every retained MCP message carries durable
  `messageOrigin`. Rows without both durable origin and exact successful audit
  evidence remain unattributed rather than receiving a guessed backfill.
- Response annotations created before source-locator version `1` remain readable
  and jump only to their annotation card. This guard is removed only if a future
  authoritative provider export supplies exact item and range identity; local
  text matching is not a migration path.

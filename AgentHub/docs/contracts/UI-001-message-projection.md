# UI-001 — Canonical message projection

## Invariants

- Optimistic, queued, active and historical forms of one command are one entity
  keyed by `clientUserMessageId`, not separately appendable cards.
- Provider entities use `provider + threadId + turnId`; items additionally use
  `itemId + role`.
- `unknown` is displayed as unknown and never inferred as running.
- Internal probes, measurements and maintenance operations have separate kinds
  and never create user-turn cards.
- Unread state is computed from the latest canonical final revision versus a
  monotonic account read cursor.
- `mark-read` names the exact final revision already shown to the client; history
  hydration remains background work.
- Current Codex limits expose every available provider window separately. A
  healthy short window cannot hide an exhausted longer window for the same model.

## Canonical reducer

The client projection has one reducer. User submissions are keyed by the alias
set `clientUserMessageId + submissionId`; either alias binds the optimistic and
canonical forms without using text, time or display order. Provider turns are
keyed by `provider + threadId + turnId`; item entities additionally include
`itemId + role`. Canonical intake atomically replaces its optimistic projection.
After the optimistic card is visible, a durable `accepted=true` receipt keeps
that same card continuously visible while immediate intake passes through a
transient deferred record before provider start. Presence in `deferredInputs`
alone cannot move an accepted command out of the conversation. Only a command
still owned by the deferred queue (`deferred=true`, without acceptance or
dispatch) moves from the conversation to the queue surface. Provider start and
history reconciliation reuse the same command identity and cannot add a second
card. Direct ACK, remote-result reconciliation and snapshot reconciliation use
the same receipt classifier; none may infer queue ownership from
`deferredInputs` presence or the `deferred` flag alone. Receipt snapshots are
bounded, so an active deferred record with `conflictKind=message-intake`
remains authoritative evidence of accepted immediate intake when its receipt
has left the current receipt window. Absence of a receipt must not move that
card into the queue; deferred records with any other conflict kind retain queue
ownership unless an available receipt or dispatch state says otherwise.
The server applies exact turn-receipt aliases before exposing active or durable
user items, so a root or steer cannot coexist with its accepted optimistic card.
Service-only attachment wrappers such as `<image ...>` are removed from both the
main text and annotation request while the attachment object remains visible.

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
Canonical ordering follows durable provider sequence. A queued root message
keeps its original `submittedAt` as metadata, but its displayed `time` becomes
the bound turn occurrence/start time so the clock label cannot contradict its
position after an earlier completed turn.

Unlabelled fenced blocks are treated as prose-oriented preformatted text and
wrap inside the message column without horizontal page movement. Fences with an
explicit language preserve code whitespace and may scroll horizontally. Both
presentations copy the original unmodified block text.

## Operation kinds

Every live projection has an explicit `operationKind`. Only `user-turn` may
produce user-visible running state. `probe`, `compaction`, `measurement` and
`maintenance` may have dedicated system presentation but cannot create or revive
a user-turn card.

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
  context-probe sentinel and never as entity identity. Remove these guards after
  all retained snapshots and history rows carry explicit operation kinds.
- The exact provider-turn root fallback remains only for old rows that lack a
  submission alias. It cannot bind steer or inter-Stream messages and is removed
  after retained history has `clientUserMessageId` or `submissionId` on every
  user command.

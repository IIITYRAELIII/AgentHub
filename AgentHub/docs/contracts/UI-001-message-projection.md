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
- Legacy rollout projections that misclassified a subagent report as a user
  may be corrected only by one matching internally generated source occurrence
  in the same turn. A Hub client identity, origin, missing source identity or
  ambiguous occurrence prevents replacement. This migration guard is removable
  after retained histories from the pre-fix rollout adapter have expired or
  been reprojected; it must never use text or provider item IDs as evidence.
  Reports outside the live tail can be repaired explicitly through `task-history`
  with `repairSubagentTurnIds` (at most 20 exact turns). The provider worker locates
  their retained turn-start boundaries and reads bounded JSONL records from that
  point, matching existing byte-coordinate source identities and recovering
  missing reports from source-native notifications in the exact completed turn.
  A terminal command-only payload is not evidence that subagent reports never
  existed. Later partial final-answer refreshes retain recovered reports. The normal
  history owner persists the correction. This maintenance is never part of startup,
  polling or ordinary refresh, never dispatches a turn, and leaves unavailable,
  rewritten, client-bound or ambiguous evidence unchanged. Remove this opt-in
  migration together with the pre-fix subagent projection guard.
- Distinct client command identities remain distinct when terminal recovery
  supplies no provider item ID. A shared turn/role is not an alias joining those
  commands; inter-Stream authorship must not leak into another user message.
- Internal probes, measurements and maintenance operations have separate kinds
  and never create user-turn cards.
- The ordinary browser shell never waits on the third-party Telegram runtime.
  A same-origin parser bootstrap requests that runtime only when Telegram launch
  parameters or a native Telegram bridge are already present, preserving the
  runtime-before-app ordering required by Mini App authentication.
- Unread state is computed from the latest canonical final revision versus a
  monotonic account read cursor.
- `mark-read` names the exact final revision already shown to the client; history
  hydration remains background work.
- A ready image attachment on VS Code or a trusted-cookie surface opens from its
  durable resource URL. A Telegram Mini App attachment-view descriptor remains
  bound to its authenticated user: the client fetches it with the `tma` header
  and gives the viewer a transient Blob URL, never a credential in the URL.
  Worker attachment manifests and binary chunks occupy disjoint key prefixes;
  publication and expiry accounting enumerate only the bounded manifest set and
  never materialize previously stored image chunks. Exact legacy manifest keys
  remain readable until their bounded capability expires. Every exact mutation
  resolves both namespaces inside the existing Durable Object transaction:
  expired legacy state and its exact chunks are deleted before reuse, live legacy
  state is promoted to the manifest-only namespace before it is changed, and a
  mixed old/new identity fails closed. Promotion, command linkage and result
  cleanup commit atomically, so retries observe either the legacy authority or
  the promoted authority, never a partial handoff.
  Neither path base64-copies the full attachment. Loading is fenced by the exact
  viewer generation, gallery index and resource token. Navigation, close or a
  newer open aborts only the matching pending fetch and revokes only its transient
  Blob URL. One absolute 30-second deadline starts when that generation opens;
  control resolution, authenticated fetch, Blob materialization and browser image
  decode share its remaining budget and never restart it. Every unresolved or
  failed image therefore leaves the loading state within that deadline with a
  visible error, and late work cannot replace or dispose a newer generation.
- Current Codex limits expose every available provider window separately. A
  healthy short window cannot hide an exhausted longer window for the same model.
- Codex response-annotation locators cross the provider boundary as unique
  positive safe-integer indices in the provider annotation range `1..20`,
  never as service markup. The trusted Codex parser consumes every complete
  marker outside Markdown code with a quoted index payload, including after
  ordinary prose, before validating the payload (ADR-0036);
  invalid payloads retain only a readable generic fallback and do not enter
  structured state. Partial markers remain hidden while streaming. The UI
  resolves each valid index to the nearest preceding annotated user entity by
  its canonical message key,
  renders the user's annotation/comment text and exposes a keyboard-operable
  jump to that exact annotation card only when the target annotation exists.
  Missing mappings render non-interactive
  `Цитата N`. User-authored marker-like literals and code remain ordinary user
  content.
- A new user-created annotation records its exact source user command or agent
  provider item, including an active non-final agent item. A user with a durable
  `clientUserMessageId` uses the client namespace scoped by provider and Thread,
  with empty provider turn/item fields; later item hydration does not change its
  locator or canonical content hash. Existing provider-item locators retain
  their original namespace and hash semantics. Missing, mixed or ambiguous
  identity fails closed; no provider ID is synthesized. The locator records one
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

User-selected quote text has no independent length cap. Selection, composer
draft persistence, submission and history retain the complete selected text;
they cannot reject a valid source range or truncate its quote at 400 or 4,000
characters. Existing message/transport and draft-storage bounds still apply to
the complete payload. Source identity, UTF-16 offset validity and all three hash
checks remain mandatory; removing the quote cap does not loosen source matching.
Long composer quote previews scroll within a visual height bound and remain
keyboard-accessible, keeping the quote comment and send controls in view without
shortening stored or submitted text.

## Agent questions

Codex typed `agentMessage.questions` are asynchronous question requests, even
when the provider labels the item `final_answer`. They never become a final
answer or duplicate the live commentary. Each question is durably identified by
provider, Stream, Thread, turn and item; repeated item/terminal observations
reuse that identity. A pending question remains visible in its Stream after
turn completion, refresh and restart. It always permits a custom answer and
never submits a default choice automatically. Background snapshot updates do
not replace an unchanged form or erase its draft.

An explicit answer durably freezes its content, destination and canonical
client message identity before message intake. Intake uses the ordinary message
owner; a form is marked submitted only on a confirmed receipt. An ambiguous
result remains visible with frozen fields, and only an explicit retry may send
the same answer to the same destination. Rotation never silently changes a
claimed destination. Closing a still-pending question is durable and sends no
message; an ambiguous claimed answer cannot be dismissed as if unsent.
These asynchronous cards do not use the blocking tool-approval RPC response.

The question answer uses ordinary durable intake with `followUpMode=steer`.
While an eligible turn is active, it reaches that turn rather than waiting for
the question item to become a final. A real final or completed turn retains the
ordinary queued delivery semantics. Readable answer display contains the question
and answer; routing IDs remain in provider input. Display metadata is applied
only with exact `provider + threadId + clientUserMessageId` receipt identity and
retained with the canonical user message across history reload and receipt
eviction. It does not rewrite raw stored input or supply missing identity.
Legacy answers without this accepted metadata retain their raw display; neither
text-prefix guessing nor command replay is a migration path.

## Canonical reducer

Opening history shares a bounded transport envelope with optional global
snapshot data. If that snapshot leaves insufficient space, the server returns
`snapshot: null` and `snapshotDeferred: true`, preserving the complete quote and
source locator within the existing total response limit. Null is not an empty
authoritative snapshot: the client retains current collections and requests
one ordinary snapshot refresh separately. A typed history-budget failure or a
successful history response marked `transportTruncated` may
retry only the same local history read once without the snapshot; selection
mutations and provider refresh are never replayed. A single message that exceeds
the full transport budget still fails visibly rather than losing annotations.

The client projection has one reducer. User submissions are keyed by the alias
set `clientUserMessageId + submissionId`; either alias binds the optimistic and
canonical forms without using text, time or display order. Provider turns are
keyed by `provider + threadId + turnId`; item entities additionally include
`itemId + role`. Canonical intake atomically replaces its optimistic projection.
When the client snapshot says the Stream is idle, the exact submission is
rendered immediately as one optimistic conversation card. A durable
`message-intake` ACK keeps that same card visible through dispatch and labels it
`Принято`, never `В очереди`. The durable deferred row with
`clientProjectionIntent=conversation` preserves that placement for normal
`message-intake`, including when its bounded receipt is absent during reload.

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
`task-running` result moves the same logical submission to the queue surface.
An explicit `accepted=false` queued/deferred receipt overrides the original
`clientProjectionIntent=conversation`, even when the receipt omits its reason.
A busy-origin command
with `clientProjectionIntent=queue` remains queue-only if admission later finds
the Stream idle. Attention-required and ambiguous commands remain queue-owned.
Reconciliation never renders both forms and never loses the logical entity.
Every canonical queue row exposes an explicit cancellation action. The action
removes a waiting or attention-required command only after durable commit; if
dispatch already owns it, the UI reports that cancellation was not confirmed.

Direct ACK, remote-result reconciliation and snapshot reconciliation use the
same classifier. Receipt snapshots are bounded. A durable waiting command with
an explicit non-`message-intake` conflict restores the queue after its receipt
leaves the window, ahead of its original client projection intent. Otherwise
the durable explicit projection intent restores the chosen surface.
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

A receipt without `streamId` reconciles only when its exact provider and Thread
identify one current snapshot Task. Missing or ambiguous bindings do not change
any outgoing message. A later canonical receipt removes the local unknown-send
retry action and cannot be downgraded by a late failure of the original request.
An unconfirmed local submission remains on the queue-management surface, clearly
labelled as not acknowledged by Hub. While its original request is retained in
the current page, explicit retry reuses its command identity and frozen wire
parameters; changes in model selection or Stream occupancy do not rewrite that
request. Refresh never triggers that retry automatically. This retained request
does not introduce a second durable command store or promise reload recovery.
An exact local preparation cancellation before transport begins is a known
non-submission, not a transport timeout, and may restore the unchanged draft
through the existing composer recovery owner.

Composer recovery uses the same exact `clientUserMessageId`. A transport timeout
or connection loss leaves the cleared composer unchanged and shows the command
as `unknown` while snapshot reconciliation is pending. Only an authoritative
rejection without durable receipt, deferred-input or run evidence may restore
the submitted payload. Such a restored draft persists its exact request
identity, exact payload fingerprint and bounded local re-uploadable attachment
bytes; temporary transport paths are never persisted or reused. A versioned
Blob reference may instead bind byte length, immutable file metadata and the
ordered SHA-256 part manifest in IndexedDB (MSG-002, ADR-0037). Its bytes must be
durably written and verified before recovery is granted, and asynchronously
hydrated and verified before the existing recovery epoch/fingerprint gate.
A Promise is never interpreted as successful synchronous persistence. On reload the
client reconstructs retry identity only when the complete recovered payload
matches that fingerprint. Re-uploadable attachment evidence is accepted only
after strict base64 decode/canonical round-trip, exact declared-byte-length and
bounded canonical name/MIME validation; malformed metadata or bytes invalidate
the whole recovery identity. The persistence owner constructs the exact serialized
candidate first and grants durable recovery only when its canonical fingerprint
still equals the submitted payload; truncation, normalization, count or storage
bounds may not silently weaken this check. Every committed composer mutation
(text, attachment, Task reference, response annotation or programmatic edit)
advances an irreversible Task-scoped edit revision and invalidates the old
identity. Eligible attachment reads fence their exact Task before yielding;
attachment and annotation callbacks commit only to the captured live Task,
generation and revision. Refused/no-op file selections, duplicate annotations
and hash failures do not advance the revision. Later accepted or rejected
evidence from an older revision cannot clear or replace the edited composition,
and receipt evidence without one exact current provider/Thread/Stream identity
cannot complete any composer send.
An explicit retry of the unchanged restored payload reuses the original request
identity and uploads recovered attachments again. If browser privacy or quota
policy, serialization normalization or a configured bound prevents exact atomic
persistence, the client reports that recovery will not survive reload, retains
the complete in-memory payload for the current page, persists no partial recovery
identity and blocks managed runtime reload until the composition is sent or
explicitly edited into independently persistable state. Recovery invalidation is
also recorded as a bounded monotonic epoch in an independent IndexedDB store
before stale local draft data can be trusted again. That authority survives cold
WebView recreation and is compared before any localStorage recovery identity is
restored; Task deletion advances the same epoch, so recreating an identical Task
identity cannot inherit the deleted draft. If the independent authority cannot
be read or advanced, no stored retry identity is trusted, the current page stays
fenced, managed reload remains blocked and the UI warns once. The client never
claims that stale local bytes were durably erased when either store rejects its
write. Initial snapshot acceptance is reconciled only after this recovery read
and restore barrier completes. Snapshot completion deduplication cannot consume
that evidence before a persisted retry identity becomes visible, and a late
restore cannot replace a composition already edited in the current page.

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
back to the existing user-message time. Only the root user message may then
fall back to provider start. A steer never inherits the parent turn's start or
submission time: its exact receipt supplies intake time, or its own timestamp
is used; if neither exists, its time remains unknown until enriched.

Unlabelled fenced blocks are treated as prose-oriented preformatted text and
wrap inside the message column without horizontal page movement. Fences with an
explicit language preserve code whitespace and may scroll horizontally. Both
presentations copy the original unmodified block text.

Complete Markdown `details/summary` blocks render as native disclosures, closed
by default, in both historical and new messages. This is a constrained Markdown
extension, not raw HTML: the opening details tag begins a line; its initial
summary may share that line or span subsequent lines. The closing details tag
occupies its own line, except for a compact block entirely on one line. Nested
blocks are supported to depth 32; malformed or unsupported forms remain literal.
Source attributes, including `open`, are ignored. Summary text and body use the
existing safe Markdown/link renderer; fenced and inline code preserve literal
tags. Paragraphs, lists and code stay within the message column. Native keyboard
and pointer disclosure controls remain available. Unchanged block occurrences
retain their open state when the same keyed message is refreshed or receives
additional text; disclosure content never establishes message identity.

## Journal hierarchy

Collapsed Journal groups show resource totals only. In date, week and month
groupings, expanding a group keeps the Workspace selector on the left and shows
the selected Workspace's Streams on the right. In `workspace` grouping the
outer group already identifies the Workspace, so its expanded body does not
repeat a Workspace selector: it shows that Workspace's Streams with the
Workspace profile alongside them. Turn shells remain inside their Stream. The
Workspace selector always shows turn count, included spend and duration with
each metric's share of the current temporal scope. Every nested Stream shows
the same three metrics with their shares of the selected Workspace. These
resource shares remain visible for selected and unselected Workspace cards. The
user may disable Stream nesting for date, week and month groupings through the
Journal setting without changing persisted usage facts. Streams are ordered by the
currently included credit total descending, with stable recency and identity
ties. Disabling Claude usage excludes Claude credits from headers, group totals
and ordering while retaining Claude turns and their duration as journal facts.
The account-usage panel always includes every provider and is not filtered by
the Journal and statistics `includeClaudeUsage` presentation setting.
Opening a group, Stream and turn are separate lazy actions; a collapsed group
does not materialize turn DOM. In `stream` mode the first Stream retains the
established default-open overview, profile and task-profile presentation; only
that Stream's first turn-shell page, its exact aggregate profile across every
represented provider and a bounded aggregate-only cohort of comparable visible
Streams are fetched. The requested Stream is retained even when it falls outside
the bounded peer cohort. The cohort supplies a real cross-Stream profile baseline
without fetching another Stream's turn shells or bodies. Every other Stream
remains collapsed and resource-only until explicitly opened.

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
Provider rollout projection fails closed while that identity is reordered: an
identity-less exact context-probe sentinel is internal and cannot enter the
canonical user-message, history or running-card projection. A later exact
ordinary `clientUserMessageId` reclassifies that same provider turn as a visible
user operation; a later service probe identity keeps it internal. Suppression
does not discard the separately owned context-usage measurement or maintenance
record.
A current compaction with an unknown outcome has a dedicated system marker,
`Статус свёртки неизвестен`, keyed by its exact maintenance operation identity.
Legacy timeout state has the same unknown presentation, never a failed or
running claim. A later confirmed completion replaces that exact marker. An
active system marker does not require a provider turn ID before acceptance.
Automatic post-turn preparation has its own system marker and context label,
derived from the current maintenance reservation even if the previous compaction
is already completed. Stop is available during cancellable preparation; the
client does not invent a running user turn to expose that action.
A task snapshot with no active run is authoritative after any available
completion has been promoted: it removes the cached live card, probe and
live-user projection even when the previous card was a valid `user-turn`.
Queued inputs remain represented by the queue surface and cannot keep a drained
run card alive while waiting for, or after completing, later turns.

`Изменить` on a queued or paused input never opens a second editor. It returns
the complete source draft to the main composer through the composer state
owner, including editable user text, locally materialized files, exact Task
references and their intents, response annotations and the opaque
inter-Stream-origin transfer identity. Any existing composer text, file, Task
reference or annotation blocks the operation with an explicit message and does
not mutate queue state. A composer revision compare-and-swap prevents a user
edit made during attachment loading from being overwritten. A failed durable
queue removal rolls back only an unchanged transferred draft; an unknown
removal outcome is reconciled from the authoritative snapshot and never causes
an automatic second removal. Queue removal and its committed transfer grant are
persisted in one runtime snapshot. The grant is bound to the exact provider,
Thread and Stream, expires with the deferred-input retention window, and keeps
the original attachment-cleanup obligation. Before receipt admission or a
provider effect, one exact client message identity claims the grant through a
durable serialized write; persistence failure prevents the effect and a
different identity fails closed. After a restart, only that same identity may
reconcile the grant with its durable receipt. An authoritative missing receipt
means the durable claim stopped before admission and lets only that same
identity resume without deleting its source attachments. Provider acceptance
is a separate durable state; only that state makes source-file cleanup
eligible, and an interrupted cleanup is retried after restart. Foreign client
identities and expired grants fail closed without a second provider effect.
Inter-Stream authority is restored only from the deferred
item's durable `messageOrigin`. Envelope-shaped user text without matching
durable origin remains visible user text and cannot supply Workspace, Stream,
provider, Thread or request identity.

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
  context-probe sentinel when the record also lacks any client operation identity,
  including the provider interval before a matching completion item supplies
  that identity; it is never entity identity and cannot override an ordinary
  `clientUserMessageId`. Remove these guards after all retained snapshots,
  history rows and provider events carry explicit operation kinds.
- A retained pre-origin MCP message may recover inter-Stream provenance only by
  exact `mcp:<requestId>` lookup of a successful audited
  `hub_stream_message_send`, `hub_task_start` or `hub_task_reassign` operation.
  Recovery compares stable Workspace, Stream, provider, source Thread and
  request IDs; mutable display names and model are descriptive metadata, while
  any stable conflict fails closed. The successful audit also carries the
  immutable MCP arguments hash and a pre-delivery SHA-256 boundary over the
  exact stable origin plus body; a matching request ID with substituted content
  remains literal. Ordinary ingress cannot mint this reserved command namespace.
  Its source Workspace and Stream are rendered with the explicit service marker
  `Служебное`; text, time and display order are never attribution evidence.
  Live, reconnect and delayed history frames apply the same exact identity
  before rendering: a verified transport envelope is never exposed, while an
  envelope-shaped literal with no matching durable/audited identity remains
  ordinary readable user content.
  Remove this read-only guard after every retained MCP message carries durable
  `messageOrigin`. Rows without both durable origin and exact successful audit
  evidence remain unattributed rather than receiving a guessed backfill.
- Response annotations created before source-locator version `1` remain readable
  and jump only to their annotation card. This guard is removed only if a future
  authoritative provider export supplies exact item and range identity; local
  text matching is not a migration path.

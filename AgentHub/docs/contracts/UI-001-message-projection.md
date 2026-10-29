# UI-001 — Canonical message projection

The Task card's operation action exposes explicit interruption of a bound
claim/workflow attempt, including pending and UNKNOWN. It reaches the same
authenticated owner while the original UI/control mutation waits. Requested
stopping and confirmed stopped are distinct; UNKNOWN past effects are never
presented as undone. Already completed operations retain their completion.
Refreshing the operation panel reads canonical disposition and does not replay
the original action. Legacy rows without a Task binding require exact operator
arguments through the supported owner, never guessed association by timestamp.

The Server page exposes the private sync endpoint through its existing
configuration save/cancel flow. Only HTTP(S) URLs without embedded credentials,
query or fragment are admitted. A pending edit does not change the effective
running endpoint; ordinary restart applies the saved value. Private historical
account policy is never part of the client configuration projection (ADR-0329).

An external-file owner dialog projects only its exact current opening, including
when the same file is reopened. It captures the path, API and operation revision
before awaiting status/preparation/create/poll/revoke. A late response cannot
change another opening's file/link, issue a follow-up creation, close a new
confirmation or overwrite its clipboard feedback. The original admitted server
effect remains intact; projection invalidation neither cancels nor replays it.
An ambiguous creation retains its original artifact/request/TTL envelope.

Task cleanup confirmation projects ignored local paths directly from the owning
server preview, separately from Git clean/dirty state. The existing scrollable
preview exposes those preserved paths without deriving deletion authority in
the browser; cancellation sends no mutation and confirmation retains the exact
server cleanup token (ADR-0126).

Durable command state and terminal revision override the original intake receipt
on live refresh, SSE reconnect and reload. Historical provider acceptance does
not imply current execution. Known saved/queued/starting/running, structured
provider retry, terminal error and unknown outcomes remain distinct; durations
use observed timestamps and never establish an outcome. No failed input is
automatically resubmitted. Retained unknown occupancy stays visible in the
activity rail with its exact Stop target and queue reason, without a running
animation or an active claim in Stream history.

## Explicit Codex trace details

A shortened rollout preview exposes “All stages” only on explicit expansion.
Detail pages do not replace canonical messages or turn identity. For new trace
quotes, the existing version-1 source locator may carry an exact traceGroupId;
its canonical content hash binds that group's complete reasoning and the
unchanged provider/Thread/turn/item identity. Other preview groups entering or
leaving do not invalidate the quote. The existing surface and selection hashes
and exact UTF-16 ranges remain mandatory. Missing or ambiguous source groups
fail closed; no text matching supplies identity. An evicted group is read only
on explicit source navigation. Equal DOM copies in the preview and detail page
may share one source only after their rendered content agrees and all hashes
validate. Existing locators without traceGroupId retain their previous content
hash semantics; they are not retroactively rewritten (ADR-0077).

Persisted trace previews may shorten individual reasoning blocks. A visible
group is trusted for source navigation only after its canonical content hash
matches; a mismatch uses the same exact-group source read as an omitted group.
New Codex group citations read the full source before binding content and surface
hashes. The selected preview must render as an exact prefix of that source, with
the same selected text at the same UTF-16 offsets; otherwise creation fails
visibly rather than guessing offsets. All three hashes remain mandatory on
navigation. Legacy citations already bound to shortened content are not rewritten.

## Invariants

- Local sending is visible before a transport response. The exact durable Hub
  ACK updates that same command immediately, before snapshot/history refresh;
  its final selected state and displayed delivery label must agree. Explicit
  queue intent remains queue-owned. An ACK does not imply provider execution.
- Explicit provider-start preparation is shown as preparation while preserving
  occupied admission and cancellation/queue intent. An exact accepted/observed
  provider turn is shown running even with no answer text. Legacy exact-bound
  accepted responses keep their existing authority; a missing optional marker
  alone is not evidence of rejection. Terminal state remains absorbing after
  reordered snapshots or reconnect. See ADR-0123.

- The Codex picker contains every selectable ID from the last complete successful
  provider catalog, excluding provider-hidden entries. A failed or incomplete
  refresh cannot remove an option. Manual priority controls order, not
  availability; genuinely new IDs lead and their order survives restart.
  The first complete catalog is a baseline, not a batch of new IDs. A saved
  historical Stream model remains visible as a label, but cannot be re-added
  to the active picker after the provider removes it.

- The existing Stream settings dialog reads and writes that Stream's canonical
  settings, not the selected Thread or global preference. An unset value is
  explicitly inherited; an unavailable saved model is displayed as a disabled
  historical label, not silently replaced or re-added to the selectable catalog.
  A settings update does not alter the model captured by an active turn.
  The dialog's manual catalog refresh uses the provider owner and updates the
  picker only after a complete response; failure leaves existing choices intact.

- Technical identifier presentation preserves complete Markdown links, including
  commit/runtime labels and punctuation inside their targets. Link-bearing lines
  remain in the message body rather than being split into technical rows.

- An idle Stream header shows its saved model setting for the matching provider;
  an exact active user turn shows that turn's model. Legacy Threads without
  matching Stream settings retain their observed model. Header labels never
  rewrite historical messages, usage attribution or provider configuration.

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
- `unknown` is displayed as unknown and never inferred as running. A retained
  uncertain managed run still exposes Stop for its original identity; the
  presentation flag never releases admission or removes its live content.
- Successful message intake updates the existing message or queue projection
  without a separate acceptance toast. A refresh failure after acceptance cannot
  duplicate the send or produce an acceptance toast; errors remain diagnostic
  and the canonical receipt remains authoritative.
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
- Context compaction and maintenance operations have separate kinds and never
  create user-turn cards. Context estimates are observations, not generated turns.
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

Triple-click paragraph selection remains quotable when the browser includes an
empty boundary outside the rendered source surface. Normalize only that empty
boundary before calculating the exact UTF-16 range and hashes. Never silently
discard selected text from another message, source surface or adjacent control.

## Agent questions

Task cards expose on-demand Git diff instead of the removed aggregate file list.
Diff responses apply only to the still-open Task and exact latest request;
closing or switching cards invalidates pending responses. Truncation and errors
are visible. Journal links retain the exact provider/task Thread/source Thread/
turn route, including after rotation. Missing identity has no guessed link.

Task creation and description editors preserve complete normalized text without
an independent character cap. The title limit and complete-request transport
bounds remain in force; saving must not silently truncate text (ADR-0050).

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

Closing/replacing a Stream in the client's existing open-column layout releases
its disposable canonical history pages and message projection. Other still-open
columns, including another Workspace's saved open columns, retain their loaded
pages. Reopening reads current canonical history with the original provider,
Thread and Stream identity; it never replays a command or infers read state.
In-flight pages for a closed column are superseded through the existing request
generation fence. Pending sends, drafts, queue/live authority and exact read
receipts are independent and are not evicted with history (ADR-HUB-343).

Hidden or zero-sized chat panes do not automatically expand cached history or
request older pages. Queued frame and scroll callbacks recheck current visibility;
returning to a visible short chat resumes viewport filling, and explicit older-page
navigation retains the same canonical history and pagination identities.

Opening a chat and refreshing its newest history both include the authoritative
active-turn overlay. A paged durable history response alone cannot replace that
combined projection after its exact optimistic user entity has been retired.
The history owner merges the active run; the client uses the existing canonical
reducer and live-card filtering, preserving one user entity without presenting
an intermediate agent response as a final. Older loaded pages and request/Stream
generation fences retain their existing ownership.

Repeated snapshot notifications for the same provider/Thread/Stream coalesce a
following history read without invalidating the page already in flight. Only
dispatched reads advance its request generation; Thread rotation and explicit
pagination still reject superseded responses. An earlier queued refresh cannot
supersede a later navigation or older-page intent merely by dispatching later;
background notifications leave an in-flight explicit older-page read owned by
that request. An initial background read exposes
the existing loading indicator until the canonical page arrives, while retaining
visible receipt/user projections. A refresh never hides already loaded history.
Content-free queue, response-decision and visible-paint measurements retain that
history request's original trace identity through the existing trace owner.

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

An inter-Stream message names its source on its first projected frame. The
accepted receipt of the exact `provider + threadId + clientUserMessageId` owns
the authoritative origin, so the run projection and the local deferred and
receipt cards read it from there while the provider echo has not yet carried the
origin back. The transport envelope is never unwrapped by text shape alone: a
missing, foreign or conflicting origin leaves the literal body, the ordinary
user author and no interstream kind. A later provider enrichment reproduces the
same body, author, kind and origin instead of replacing what is already shown.

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
After an exact steer is authoritatively known to have had no provider effect,
its attention-required row exposes both exact retry and explicit after-turn
queue actions; neither action runs before its own click. The generic current-turn
action is absent from both definite and unknown exact-steer decisions, and the
server rejects a forged generic retarget action. An unknown provider effect
remains fail-closed and does not expose the after-turn conversion.
Every canonical queue row exposes an explicit cancellation action. The action
removes a waiting or attention-required command only after durable commit; if
dispatch already owns it, the UI reports that cancellation was not confirmed.

Direct ACK, remote-result reconciliation and snapshot reconciliation use the
same classifier. Receipt snapshots are bounded. A durable waiting command with
an explicit non-`message-intake` conflict restores the queue after its receipt
leaves the window, ahead of its original client projection intent. Otherwise
the durable explicit projection intent restores the chosen surface.
An explicit queued/deferred receipt with a non-`message-intake` conflict also
overrides conversation intent when Hub has accepted durable storage
(`accepted=true`) but the provider has not accepted the input. In particular,
`runtime-restart` remains queue-owned and visibly says it awaits Hub restart,
both on the direct ACK and after snapshot/reload or receipt eviction. This is
not provider preparation or running, and does not relax the restart barrier.
A scheduled restart alone emits no such admission barrier: ordinary input keeps
its normal intake/steer/queue semantics. The restart explanation applies to the
actual stopping/cutover fence (ADR-0127), never to the pending request alone.
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

Composer pending sends are scoped to their exact current Task identity. A paused
upload or unresolved send keeps that Task fenced against duplicate submission,
but cannot disable another Stream's composer. Independent sends retain separate
original requests and drafts; a late completion releases only its matching
request and Task. Every unresolved send still retains its attachment bytes and
blocks managed runtime reload. Switching Streams never resumes, cancels or
replays an upload or message.

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
identity. Eligible attachment reads fence their exact Task before yielding.
Attachment preparation is additive: callbacks append to the latest draft under
the captured live Task identity, generation and destructive-operation fence,
so typing or another paste cannot silently discard selected files or resurrect
old text. Send, clear, attachment removal, draft replacement and Task rebinding
invalidate pending additions. Annotation callbacks retain the exact captured
revision rule. Refused/no-op file selections, duplicate annotations
and hash failures do not advance the revision. Later accepted or rejected
evidence from an older revision cannot clear or replace the edited composition,
and receipt evidence without one exact current provider/Thread/Stream identity
cannot complete any composer send.
Local file preparation does not await upload capabilities. The draft retains at
most eight files, 256 MiB per file and 512 MiB total; the negotiated server limits
are checked before upload/send (MSG-002). Pending preparation blocks managed
reload until its bytes are committed or discarded. See ADR-0074.
The selected draft shows bounded temporary file previews while preparation is
pending. These previews are labelled as preparation, are cancellable, and are
excluded from serialized/sendable attachments. Send waits for that draft's
pending preparation or explicit cancellation; another Stream's preparation
cannot block it. Settling or invalidating the operation releases its preview URL.
Preparation failure retains the original selected files and their previews in
the live draft with an explicit retry action. Retry repeats only failed work,
keeps its upload identity and does not admit a message. Successful siblings are
not discarded because another file failed. Unresolved preparation still blocks
send and managed reload until successful preparation or explicit removal.
If retained bytes outlive a transport receipt, explicit send/resume may recover
under MSG-002 with one saved fresh transport attempt, preserving the logical
attachment and request identities, text and sibling files. Recovery is visible;
an expired session is never extended. A preview without original bytes cannot
claim recovery after reload. Receipt uncertainty cannot admit another message.
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
The live card and Stream/composer running state use that same exact terminal
fence: canonical terminal history cannot be revived by a later raw active
snapshot for its provider/Thread/turn. A snapshot final reference requires a
positive safe-integer revision before it absorbs a run; a foreign or missing
identity and revision `0` alone do not prove terminal state. A new exact turn
remains active even while the previous turn's final is visible.
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

A startup operation the server marks as background runs outside the startup
barrier and does not gate the interface. Its `pending`, `running` or `failed`
state is not the current stage and is not a startup failure, so it never returns
an already ready interface to the blocking startup screen. The operation keeps
its own state and error text in the projected stage list and in server
diagnostics. Mandatory startup failures, restart and lost-connection states keep
their existing behaviour, and the flag comes only from the operation owner —
never from an operation name.

Completed context rotation is projected from the source Thread's retained
compaction operation, independently of whether the client observed a head change.
Its system marker is keyed by Stream, provider, source Thread and operation ID,
placed after the source answer and restored on first snapshot and reload without
creating a user turn. The bound target Thread and completion time are recorded
after successful catalog binding. Readiness is the fresh `idle` readback of the
exact target after creation and item injection, with no generated model turn.
A live Stream representative follows its highest durable Thread position before
historical selection or retained running state. Stream-only Desktop navigation
uses the catalog owner's current binding, independently of catalog ordering;
an explicit retained provider/Thread reference selects that exact catalog entry.
A historical turn route retains its exact history page while the head evolves.
Selecting the Stream explicitly resumes head-history navigation. Retained links
whose Thread no longer has a catalog entry still resolve through their owning
Stream lineage; the exact historical turn body remains provider/Thread scoped.
A rotation that stopped before switching produces no completed rotation marker.
Percentages name their historical stage. The post-compaction estimate is shown
with an explicit estimated label only when bound to that exact compaction and
turn by a fresh timestamp at or after its boundary. Exact pre-compaction values
keep their own meaning. A missing stage value stays unknown. No post-transfer
measurement is generated or inferred from current target usage.
Legacy `rotated: true` operations without target metadata retain a generic
rotation marker without guessing a target or its context percentage. The existing
live transition observer remains a compatibility path only when no retained
rotation operation is available; remove that path when all supported providers
and retained rotations expose such operations. An unchanged snapshot does not
rewrite the maintenance cache or accumulate discarded older events.

Every live projection has an explicit `operationKind`. Only `user-turn` may
produce user-visible running state. `compaction` and `maintenance` may have
system presentation but cannot create or revive a user-turn card. Prompt and
final-answer text never classifies a turn as internal, including the retired
context-measurement marker. A pre-retirement Codex probe with the generated
reserved `agent-hub-context-probe:<UUID>` provider `client_id` is the sole
historical exception: its exact turn is removed from user history and a saved
last-message overlay only for that same turn. Its original provider start/end
times remain on the accounting record; a later observation timestamp cannot
make it a new user message. Missing or conflicting identity stays visible.
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
completion has been promoted: it removes the cached live card and
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
The same canonical projection runs before snapshot versioning for both full
snapshots and protocol 4 conversation deltas. Final revisions and read-cursor
changes participate in collection hashes; unchanged snapshots reuse the existing
revision cache without re-projecting conversations.
Snapshot receipt alone is not display evidence: acknowledgement is emitted only
after `applyOpened` rendered a terminal card with the same exact identity and
revision. Startup snapshot-before-history therefore cannot clear unread state.
The existing opened-history evidence is rechecked after paint with the same
selected chat, visible document and exact rendered terminal identity. Returning
to a visible document or rendering an already-opened history retries an
unconfirmed acknowledgement with its original operation ID; it never invents
read evidence from a click or snapshot. Pending and retry entries remain
single-flight and retain that ID while their exact final is current in the
canonical conversation collection; a fixed-capacity eviction cannot discard
unresolved operations. Removing a conversation or replacing its final retires
that entry through the same snapshot owner; an absent final reference in an
otherwise current conversation does not prove replacement. The current criterion is rendering in
the selected visible chat, not scrolling the whole final into the viewport.
Viewport intersection is measured separately and does not redefine that rule.
A confirmed server cursor from the acknowledgement or the additive content-free
`readCursor` snapshot tuple is mirrored only as a client projection. Full and
delta snapshots cannot revive an answer covered by that cursor, and a newer
final remains unread. A delayed acknowledgement updates both marker surfaces
only through the current exact final projection; it cannot clear a newer final
or downgrade an active run. The server account cursor remains the sole durable
owner; a new document recovers its state through the ordinary snapshot.
The original acknowledgement ID correlates render/paint, control transport,
final resolution, cursor queue wait/write/contention, confirmed receipt and
after-paint marker state on tabs/cards. These bounded content-free observations
are diagnostic, not additional read authority.
The persisted cursor is monotonic even when an older request finishes last.
Within the exact provider/Thread/turn identity, revision orders reads before
completion timestamps: enrichment of the timestamp cannot resurrect the same
read revision or cover an unseen higher revision. A lower revision cannot replace
a higher one even with a later timestamp; a higher revision may advance its own
turn despite an earlier timestamp. Across different turns, `answerAtMs` retains
the existing chronology and exact `turnId` breaks equal-millisecond ties.
The browser mirrors that same ordering only for server-confirmed receipts.
No new cursor table, timestamp rewrite or background reconciliation is introduced
(ADR-0112). Existing legacy-revision migration guards remain narrowly scoped.
Cached history may be returned with the open response, but provider/history
hydration starts strictly as background work and is never awaited by mark-read.

## Migration guards

- Pre-UI-001 terminal records without `terminalRevision` are projected as
  revision `1` and carry `migrationGuard=legacy-terminal-revision`. Remove this
  after one supported release has rewritten every retained terminal record.
- Pre-UI-001 live/message records without `operationKind` retain generic
  lifecycle projection rules. Marker-shaped text remains ordinary history.
  Only a provider-sourced generated reserved probe `client_id` may suppress
  the exact historical probe turn; other client IDs never classify maintenance.
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

A successful health response with authoritative `ready=true` opens the working
interface even when an optional integration failed. Failed integrations remain
in a separate non-blocking diagnostic with the existing generation-fenced retry.
A slow or failed health read after readiness does not reopen the startup overlay;
the connection owner retains its own diagnostic. An authoritative `ready=false`
response still opens startup, including a replacement runtime with no stage
metadata yet. A queued restart request alone does not prove replacement began.

## Task operation result projection

A durable Task admission is pending, not a successful status/update/cleanup.
The shipped client reads the exact original ID/hash through the existing Task
read control until canonical success, failure, explicit UNKNOWN or stopped
disposition. Read reconnection never repeats the mutation. Existing Task pending
controls and the independent cancellation action remain available; success toast
and final snapshot follow canonical success only. Preview/confirmation keep
their existing token and separate explicit command identities. A transport ACK
is recorded once even if later work fails. A lost worker observation does not
become fabricated failure, NO_EFFECT or permission to replay.

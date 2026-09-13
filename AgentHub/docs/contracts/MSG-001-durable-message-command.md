# MSG-001 — Durable message command

## Identity and owner

`clientUserMessageId` is the immutable command and idempotency identity from the
outermost client boundary through receipt, queue, run, provider prompt and
history. A retry reuses it. Equal text is never an identity.

If a provider omits that identity from a user item, the item remains unbound.
A durable receipt may enrich only a provider item that already carries the same
exact `clientUserMessageId`; receipt count, text, time, attachment names and
ordinal position never repair identity.

Once a turn contains Hub-owned command identities, every provider refresh is an
observation. It may merge only an exact `clientUserMessageId`; it cannot
overwrite the accepted text, origin or chronology. Provider `itemId` values are
not assumed collision-free and their string shape is never ownership evidence.
Mixed and provider-only turns preserve every otherwise unproven occurrence in
provider order, including missing IDs, colliding IDs and equal text.
An owner may replace its prior provider-only projection wholesale only when
both snapshots carry the explicit `userMessageSnapshotAuthority=complete`
contract. Completeness comes from reading the full provider turn/transcript or
from the persisted canonical projection; a non-empty hydration is not evidence.
Incremental/bounded-tail observations append every unproven occurrence. Neither
mode matches occurrences by `itemId`, content, time, position or generated ID
shape.

An incremental source may make replay idempotent only with an Agent Hub-created
`sourceOccurrenceId`. For Codex rollout JSONL, the generation hashes the validated
source-native session id together with its complete canonical `session_meta`
record. Provenance discovery reads at most the first and last 256 KiB and accepts
exactly one well-formed bounded identity; missing, malformed or conflicting
metadata makes provider-owned unkeyed users unavailable rather than assigning a
nullable/fabricated occurrence. Exact Hub `client_id` records remain admissible.
Within a proven generation the occurrence uses the exact raw record start byte
coordinate plus its canonical structural-record fingerprint. The coordinate is
read directly from the bounded Buffer stream, never reconstructed by decoding
or re-encoding text and never derived from filesystem paths, inode timestamps
or provider item IDs. It remains stable when an older byte-identical record
leaves a moving tail: replay is idempotent, while an actually appended equal
record has a new immutable coordinate. A bounded exact-record bridge preserves
identity across a recognized source-preserving rewrite. A changed canonical
session generation and a new equal occurrence are distinct. The full App Server
turn adapter creates its
own exact namespaced evidence and preserves it when that same source item later
gains `clientUserMessageId`; that exact source evidence may replace the earlier
unkeyed projection once, but cannot reconcile conflicting Hub identities.
Provider-supplied IDs and arbitrary occurrence-shaped fields are never accepted
as Agent Hub evidence.

Snapshot authority is per exact turn. A full parse is `complete` only while no
user-message cap, turn eviction, malformed/oversized record, partial trailing
record, parser failure or bounded-tail read affected its evidence. The affected
turn is `incremental`; an error whose turn cannot be proven makes all returned
turns incremental. Completing a cached trailing record may restore completeness
only when the reader retained a full, otherwise lossless generation.

A terminal read-model row that lost its command aliases is repaired only from
the existing recovery owner at startup or when its bounded history page opens.
Page recovery addresses at most 20 exact turns, without extending the startup
window or reading other turns' payloads. The repair uses
the exact retained terminal payload after every payload `clientUserMessageId`
is verified against a terminal ledger record with the same
`provider + threadId + turnId + runId`. Recovery is bounded and idempotent and
never resubmits the provider effect. Missing, duplicate or conflicting identity
evidence leaves the row unchanged; content, time and ordinal position are not
recovery evidence. Once that complete proof exists, the terminal payload is the
authoritative complete user projection; independent external occurrences in it
remain distinct, and stale read-model aliases are replaced rather than guessed.

The durable command ledger owns acceptance and dispatch state. UI cards,
in-memory receipts and runtime snapshots are projections.

A new response annotation may carry one bounded source locator owned by the
original client capture from a canonical user, final agent or active non-final
agent item: exact `provider + threadId + turnId + itemId + role`,
the derived provider-message key, or for a user command the exact
`provider + threadId + clientUserMessageId + user` client-namespace key with
empty turn/item fields. Version 1 accepts this additive identity variant;
provider-item locators keep their existing meaning. Neither variant permits
text matching or synthesized provider identity. Both carry a versioned rendered-surface kind and index,
a UTF-16 range, and SHA-256 boundaries for canonical source content, rendered
surface content and the selected range. Intake validates that schema before the
locator enters a receipt. The same validated object crosses queue, provider
prompt and history with the original `clientUserMessageId`; no downstream layer
reconstructs it from selected text, time or order.

The selected quote has no separate character limit and is never silently
truncated during intake or history normalization. General message/transport
bounds continue to govern the complete command; locator identity, offset and
hash validation remain unchanged.

## State machine

`accepted` may advance to `queued`, `attention-required` or `dispatching`.
`dispatching` may advance to `started`. Terminal states are `completed`,
`failed` and `cancelled`. A timeout with an unobserved result is `unknown`, not
permission to create a second effect.

Transitions are monotonic and idempotent. A canonical record atomically replaces
its optimistic projection by the same identity.

A provider rejection received before provider acceptance moves that command to
`attention-required` and releases its FIFO lane only after the rejection is
durable. A launch with an unknown outcome keeps the lane until exact
reconciliation or an explicit user decision; it never authorizes automatic
resubmission or a later same-lane provider effect.

Hub acceptance and provider acceptance are distinct boundaries. A submission
made from an exact idle client snapshot may have one optimistic conversation
projection before provider acceptance. The client persists immutable
`clientProjectionIntent=conversation` with the command, so a later
`task-running` admission conflict transfers that same entity to the queue
surface, according to authoritative server state (ADR-0028). The immutable
intent records the initial client decision; it cannot override an explicit
negative admission with queued/deferred state. A submission made while the client knows the Stream is busy
persists `clientProjectionIntent=queue` and remains on the queue-management
surface even when admission later finds the Stream idle. Ambiguous and
`attention-required` commands are queue-owned regardless of the optimistic
intent. Later active and terminal projections reuse the original
`clientUserMessageId` in both paths. The projection intent participates in the
request fingerprint and cannot change on retry.

## Occupancy and ordering

Before provider Thread binding, a queued command occupies a provisional lane
scoped by `streamId`. Once `streamId`, `provider` and `threadId` are known, the
same command is atomically rekeyed once to that exact lane. Different Threads in
one Stream are independent lanes; FIFO is preserved inside each exact lane.

One queue-to-run orchestrator derives occupancy from exact nonterminal managed
runs and authoritative provider activity. Completed, failed or cancelled runs do
not block admission while terminal delivery or projections are repaired. A
persisted wait reason is not authority: it is recalculated from current exact
occupancy and self-heals after restart without manual interaction. When terminal
admission is released, every queued lane head
preempts polling backoff and is scheduled immediately because repository
occupancy can couple otherwise independent lanes. A steer whose exact run or
turn is no longer active becomes attention-required with that identity intact;
it cannot enter the later-turn FIFO unless the user explicitly chooses the
ordinary queue action.

An attention-required lane head created by `task-running` or
`activity-unknown` is rechecked against current exact occupancy. Once the
managed or external writer is absent, that same durable command returns to the
queue and keeps its FIFO identity; the persisted decision state cannot reserve
the lane forever. Completion wake-up and runtime startup both trigger this
reconciliation. A stale incomplete Claude transcript alone remains uncertain;
only a successful exact-session process probe may prove its external writer
absent, while probe failure stays fail-closed. Unknown provider-start outcomes remain excluded because they
require exact reconciliation or an explicit user decision before another
effect.
Potential owners must match the configured Claude executable and wrapper-prefix
signature before an exact parsed `--resume` or `--session-id` token can identify
the session; a process name or flag-shaped command line alone is not evidence.
An unresolved PATH shim is not an executable signature and therefore cannot
produce absence authority.

Cached process absence is a queue-reconciliation hint, never launch authority.
Every Claude managed-run creation, including manual context maintenance,
crosses the same lifecycle admission capability. Immediately inside `begin`
and before the run is registered, it performs a fresh global process inventory
and binds its exact session, generation and scan time to that run object. Live,
incomplete, stale or changed-to-unknown evidence fails closed without a provider
effect. Before handoff the launch boundary atomically moves that exact run from
`prepared` to `staged` and passes a one-use opaque ticket; the Claude provider
adapter then requires that ticket, `run.provider="claude"`, and atomically
consumes `staged` immediately before the external effect. Success, provider
failure, completion, a pre-effect dependency failure, and concurrent or
sequential replay never restore the capability.
Copied proof data, another run object, and a provider argument that disagrees
with the run all fail closed without mutating either the presented or target
capability. Only an exact abort with the same run and ticket, or lifecycle
completion/release, may revoke `staged`; foreign evidence cannot revoke a
legitimate launch. Recovery adoption of an already accepted provider turn is a
separate non-launching operation and cannot mint launch authority.
This proof is intentionally point-in-time: an uncooperative external process
can still start after the scan, so provider-side single-writer rejection remains
a required fail-closed guard.

The controller synchronously claims the exact queue item before its first
occupancy or provider `await`. Concurrent wake/backoff callbacks therefore
share one dispatch owner, and cancellation cannot report success after dispatch
eligibility has been claimed. A transient persistence failure rolls an
attention-required transition back to the same pending object; timer-owned
processing records a payload-free error and retries that exact owner with
bounded backoff instead of leaking an unhandled rejection.
Persisted queue errors contain only an allowlisted code and bounded generic
message. Dependency output, command lines, session identifiers, payload and
stack text never enter deferred diagnostics or client state.

An explicitly user-paused command remains durable but does not own the runnable
lane head. Later accepted commands in that exact lane may dispatch in their
relative FIFO order. Provider-occupancy pauses remain transient lane heads and
are rechecked until the exact writer clears.

The queue action `Изменить` is an ownership transfer, not an in-place text
rewrite. The server first durably reserves the exact non-dispatching item and
returns its editable text, persistent attachment descriptors, exact Dashboard
Task references with intent, response annotations and inter-Stream origin. The
client composer owner applies that complete draft only under an unchanged empty
composer revision. Only then may the server remove the queue item. A failed
prepare, materialization or durable removal releases or reconciles the
reservation without deleting its files; duplicate prepare/commit requests use
the same opaque transfer identity. The original attachment files remain owned
by the transfer grant until an accepted resend consumes it. A process restart
returns an interrupted, uncommitted reservation to its previous paused/runnable
queue state.

Manual up/down controls change FIFO order only among queued or paused items in
the same exact Stream lane. Boundary controls are disabled, and the durable
server order remains authoritative.

For a nonterminal Hub-owned managed run, its exact registered `run.turnId` is
the primary steer identity. A lagging or temporarily incomplete Thread
projection must not suppress the `turn/steer` attempt. Thread projection is
consulted only when no exact managed identity exists or when the provider
rejects that identity as stale; only a real provider rejection downgrades the
durable command to queued intake.

Provider `turn/steer` is the authority for whether one exact nonterminal managed
turn remains steerable. Local response projection, including an observed Codex
`agentMessage` with `phase="final_answer"`, does not veto admission or dispatch:
the same provider turn may still accept steering after that marker. Admission
first persists one durable `message-steer` item under its original
`clientUserMessageId`, exact run ID and exact turn ID, then dispatch attempts the
provider RPC once. Provider-internal compaction of that same ordinary turn does
not downgrade admission to generic later-turn intake: the exact steer remains
durable until the compaction barrier clears, then dispatches against its original
run and turn. A Hub-owned compaction, rotation or restart reservation remains an
admission barrier. Exact run/turn movement before dispatch and a definite
provider stale/not-steerable rejection have no provider effect, so the same
durable item becomes visible attention-required state with its command, origin,
attachments and exact steer identity intact. The lane is released, but the item
cannot start a later turn automatically. An explicit `retry` keeps the exact
steer identity; only the explicit ordinary queue action authorizes conversion to
later-turn intake. Timeout or an unknown provider outcome enters bounded
receipt/provider reconciliation, keeps the lane fail-closed and is never blindly
replayed. Local text, phase, elapsed time and rendered state are observations,
never steer authority.

For an inter-Stream command, the envelope `requestId` deterministically restores
the `mcp:<requestId>` command alias when a provider rollout omits
`clientUserMessageId`. That alias reconciles receipt and rollout projections;
display text and card position never substitute for it.

`hub_stream_message_send`, `hub_task_start` and `hub_task_reassign` carry the
audited source Workspace, Stream, provider Thread and request identity as
durable `messageOrigin`. The provider input keeps the same origin in the outer
inter-Stream envelope, including when a Task reference is attached. Task
assignment therefore remains a service command and cannot be reclassified as a
human message while crossing intake, queue, run, receipt or history boundaries.
The envelope is transport-only display data. Raw provider and storage records
retain it. Queue, live-run, observed-provider and durable-history display
projections remove it only when its normalized origin exactly matches durable
`messageOrigin`, or when exact successful MCP audit evidence binds the same
`mcp:<requestId>` to the stable `workspaceId + streamId + provider +
sourceThreadId + requestId` identity. Workspace/Stream display names and model
are descriptive metadata: audit recovery may tolerate their absence or change,
while any present stable-field conflict fails closed. The audit must retain the
original inter-Stream tool, immutable arguments hash and a SHA-256 boundary over
the exact admitted stable origin plus body. The hash is bound before message
delivery and cannot be replaced by a provider-supplied value. Audit recovery
unwraps either the retained envelope or its exact body only when that content
boundary also matches. A reserved-looking client ID alone is never origin
evidence, and ordinary Desktop ingress cannot claim the `mcp:` namespace. A
missing, legacy-unbound or conflicting identity leaves the text visible, so
envelope-shaped ordinary user text is not reclassified or hidden. Managed live
messages may keep a body-only display projection, but terminal, journal and
work-log storage retain the raw root prompt and its separately bounded
`clientUserMessageId` plus authoritative origin.

## Durable ACK

- Local ACK follows one compact durable command write.
- Attachment hashing, full runtime snapshots, catalog refresh, receipt cleanup,
  provider hydration and history projection do not hold the ACK path.
- An ACKed command is recoverable after process death.
- Lost transport responses are retried with the same identity and cannot create
  duplicate provider effects.
- A queue ACK states `providerAccepted=false` until an exact run/turn exists;
  Hub durability is never presented as provider delivery.
- Cancellation commits durably before cleanup. Once dispatch is in progress,
  cancellation fails explicitly instead of reporting an effect that may already
  have reached the provider.

## Remote attachment transport

The shared Dashboard bot's queue notice confirms remote queue admission only.
Its accepted/failed notice follows the local Hub's durable command result. The
same remote control command owns the pending Telegram receipt and its delivery
state; an indexed alarm only addresses that record. Committing a terminal result
does not prove Telegram delivery or discard a pending receipt. Same-ID result
retries preserve the first terminal outcome and share one notification attempt.
Pending receipts retry with bounded backoff for the command's 30-day retention,
survive Durable Object recreation, and never replay Task creation. Successful
delivery restores ordinary 30-minute terminal retention. The authenticated Hub
binding supplies the destination; source metadata cannot choose another chat.
Native replies keep exact incoming-message or submitted bundle-card identity.

Telegram does not provide an idempotency key for `sendMessage`: a lost response
after Telegram accepted a notice can produce another notice on retry. This is
notification delivery uncertainty, never permission to repeat the Task effect.
Legacy terminal commands without persisted notification state are not replayed:
their earlier delivery cannot be inferred. Remove this migration gap only with
authoritative delivery evidence or an explicit user-requested notification.

Dashboard attachment bytes cross the public Worker boundary only through
`agent-hub-attachment-chunks-v1`. Every response is smaller than 25 KiB. Paged
manifests bind the immutable attachment id, total size, SHA-256, chunk count,
chunk size and ordered `{index, size, hash}` descriptors. Chunk reads are exact
and idempotent for the original command identity. The receiving runtime bounds
every page and chunk, requires contiguous indices and exact sizes, verifies each
chunk SHA-256, then verifies the assembled size and final SHA-256 before making
the local file visible to the command handler.

Transport timeout or an incomplete chunk leaves the durable command available
for a later poll with the same command and attachment identities. The client
does not create an immediate retry loop to make a stalled body appear reliable.

A rejected Dashboard poll cannot leave its command workers running into the
next attempt. The first failure stops assignment in both text and attachment
lanes; already-started commands retain their deadlines and settle before the
poll rejects with the original error. The same drain boundary applies inside
attachment chunk groups. This lifecycle rule does not establish network health.

The two permanent remote command consumers use
`agent-hub-control-wake-v1`. An authenticated hibernatable WebSocket carries only
an availability revision. The command is persisted before the revision is sent;
the consumer then claims it through the existing immediate durable pull with
`waitMs: 0`. Initial connection and reconnection always perform the same drain,
so a missed or duplicate hint cannot lose or duplicate an effect. Durable queue,
claim, receipt and result identity remain authoritative.

When the wake endpoint is unavailable during rolling deployment, the consumer
uses only an immediate `waitMs: 0` pull at a fixed ten-second idle cadence.
Consecutive transport or storage failures still use bounded exponential backoff
with jitter and `Retry-After`. A successful wake connection and drain reset that
failure state. After a Durable Object accepts the wake capability, it rejects
nonzero waits on its permanent service pull route. User-scoped result and
snapshot waits are not part of this service transport migration.

The deterministic idle budget assumes two permanent channels, a sixty-second
hibernation auto-response heartbeat and a 250 ms immediate-pull p99. The fallback
is bounded to 17,280 Durable Object requests and 540 GB-s per day; the primary
wake channel has zero idle GB-s and 146 request-equivalents per day. Deployment
verification rejects a published budget that differs from these bounds. Durable
Object unavailability remains an observable `503` service state, not an
unhandled `500` and not evidence that a command was rejected or completed.

Each open wake channel requires a matching pong within a bounded deadline after
its heartbeat. A missing pong invalidates the socket and releases the current
wait directly to the immediate durable pull; reconnect performs another drain.
Only that matching pong confirms transport liveness; an availability frame does
not cancel the deadline. Availability revisions are monotonic, and duplicate or
stale revisions do not trigger another pull while a newer revision remains a
meaningful wake hint. Pong and availability frames never acknowledge, claim or
execute a command, so polling remains the single delivery owner and a missed or
duplicated frame cannot create a second effect.

During rolling deployment, a request without `mode` may still receive the
legacy full-body response, and a new runtime may accept a binary response from
an old Worker that ignored `mode=manifest`. This migration guard is removed
after all deployed Workers and runtimes advertise the chunk protocol; it is not
an alternative source of attachment identity or state.

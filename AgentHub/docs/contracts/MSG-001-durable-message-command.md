# MSG-001 — Durable message command

## Identity and owner

`clientUserMessageId` is the immutable command and idempotency identity from the
outermost client boundary through receipt, queue, run, provider prompt and
history. A retry reuses it. Equal text is never an identity.

If a provider omits that identity from some user items in an exact turn, the
read model subtracts the already bound command identities from that turn's
ordered durable receipts. It binds the remaining provider items only when the
remaining item and receipt counts match exactly. Partial or ambiguous coverage
stays unbound; text, time and attachment names never repair identity.

The durable command ledger owns acceptance and dispatch state. UI cards,
in-memory receipts and runtime snapshots are projections.

A new response annotation may carry one bounded source locator owned by the
original client capture from a canonical user, final agent or active non-final
agent item: exact `provider + threadId + turnId + itemId + role`,
the derived provider-message key, a versioned rendered-surface kind and index,
a UTF-16 range, and SHA-256 boundaries for canonical source content, rendered
surface content and the selected range. Intake validates that schema before the
locator enters a receipt. The same validated object crosses queue, provider
prompt and history with the original `clientUserMessageId`; no downstream layer
reconstructs it from selected text, time or order.

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
`task-running` admission conflict keeps that same entity visible and never
labels it queued. A submission made while the client knows the Stream is busy
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
occupancy can couple otherwise independent lanes. A steer that no longer has
an active turn is downgraded to ordinary intake before the later-turn FIFO
choice.

An explicitly user-paused command remains durable but does not own the runnable
lane head. Later accepted commands in that exact lane may dispatch in their
relative FIFO order. Provider-occupancy pauses remain transient lane heads and
are rechecked until the exact writer clears.

For a nonterminal Hub-owned managed run, its exact registered `run.turnId` is
the primary steer identity. A lagging or temporarily incomplete Thread
projection must not suppress the `turn/steer` attempt. Thread projection is
consulted only when no exact managed identity exists or when the provider
rejects that identity as stale; only a real provider rejection downgrades the
durable command to queued intake.

Codex closes steer admission for one exact nonterminal turn when that run has
observed `item/started` for an `agentMessage` with `phase="final_answer"` and the
item's non-empty `turnId` equals the registered `run.turnId`. The admission
boundary checks this protocol state both before acknowledging a requested steer
and immediately before `turn/steer`, because the phase may advance while the
durable command waits for dispatch. The same command remains ordinary durable
queued intake under its original `clientUserMessageId` and FIFO position until
the turn releases occupancy. Analysis, commentary and reasoning remain
steerable. A different item or turn, missing identity, and every Claude run are
outside this guard; text, elapsed time and rendered state are never evidence.

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

## Durable ACK

- Local ACK follows one compact durable command write.
- Attachment hashing, full runtime snapshots, catalog refresh, receipt cleanup,
  provider hydration and history projection do not hold the ACK path.
- An ACKed command is recoverable after process death.
- Lost transport responses are retried with the same identity and cannot create
  duplicate provider effects.

## Remote attachment transport

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

During rolling deployment, a request without `mode` may still receive the
legacy full-body response, and a new runtime may accept a binary response from
an old Worker that ignored `mode=manifest`. This migration guard is removed
after all deployed Workers and runtimes advertise the chunk protocol; it is not
an alternative source of attachment identity or state.

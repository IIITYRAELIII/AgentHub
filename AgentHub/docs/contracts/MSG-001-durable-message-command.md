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

## State machine

`accepted` may advance to `queued`, `attention-required` or `dispatching`.
`dispatching` may advance to `started`. Terminal states are `completed`,
`failed` and `cancelled`. A timeout with an unobserved result is `unknown`, not
permission to create a second effect.

Transitions are monotonic and idempotent. A canonical record atomically replaces
its optimistic projection by the same identity.

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

For an inter-Stream command, the envelope `requestId` deterministically restores
the `mcp:<requestId>` command alias when a provider rollout omits
`clientUserMessageId`. That alias reconciles receipt and rollout projections;
display text and card position never substitute for it.

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

During rolling deployment, a request without `mode` may still receive the
legacy full-body response, and a new runtime may accept a binary response from
an old Worker that ignored `mode=manifest`. This migration guard is removed
after all deployed Workers and runtimes advertise the chunk protocol; it is not
an alternative source of attachment identity or state.

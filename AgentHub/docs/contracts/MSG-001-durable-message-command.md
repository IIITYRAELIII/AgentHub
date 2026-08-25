# MSG-001 — Durable message command

## Identity and owner

`clientUserMessageId` is the immutable command and idempotency identity from the
outermost client boundary through receipt, queue, run, provider prompt and
history. A retry reuses it. Equal text is never an identity.

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
occupancy and self-heals after restart without manual interaction.

## Durable ACK

- Local ACK follows one compact durable command write.
- Attachment hashing, full runtime snapshots, catalog refresh, receipt cleanup,
  provider hydration and history projection do not hold the ACK path.
- An ACKed command is recoverable after process death.
- Lost transport responses are retried with the same identity and cannot create
  duplicate provider effects.

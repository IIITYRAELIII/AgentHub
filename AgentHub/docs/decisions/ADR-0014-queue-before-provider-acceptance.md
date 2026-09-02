# ADR-0014 — Idle optimism and busy queue ownership

## Status

Accepted.

## Context

The UI originally kept a known-idle submission continuously visible while Hub
durable intake transitioned into provider start. A chronology correction then
labelled that conversation card as queued. The first HUB-135 result removed the
label by moving every pre-acceptance command to the queue, but that also removed
the immediate idle feedback the user explicitly expects.

## Decision

Surface placement is chosen at the exact client submission boundary:

- a Stream known idle gets one optimistic conversation card immediately;
- a Stream known busy gets one queue item and no conversation card;
- steer intent is queue-owned until the provider accepts the exact target turn.

The durable `message-intake` record preserves the idle projection across ACK,
snapshot races and reload. It is labelled `Принято`, never `В очереди`. Other
queued, dispatching, ambiguous and attention-required records remain on the
queue surface until exact provider acceptance:

- a new turn has the original `clientUserMessageId`, exact `runId` and exact
  provider `turnId`;
- a steer has `steered=true` and its exact target `turnId`;
- an active run snapshot has matching `run.turnId` and
  `run.providerStart.turnId` in an accepted or observed provider-start state.

The same identity replaces the queue projection with active/history content.
Text, timestamps, card position and `conflictKind` never prove provider
acceptance.

## Consequences

- Durable ACK, retry, cancellation and restart recovery remain unchanged.
- An idle submission appears immediately without flashing through the queue.
- No conversation card displays `В очереди`.
- A busy submission stays exclusively above the composer until launch.
- Definitive rejection and ambiguous start remain manageable in the queue
  without creating history.
- A reload reconstructs idle placement from `conflictKind=message-intake` and
  busy placement from every other unresolved durable input even when the bounded
  receipt is absent.
- Legacy active records lacking both exact provider-start evidence and an exact
  accepted command receipt stay out of the conversation until provider history
  materializes them.

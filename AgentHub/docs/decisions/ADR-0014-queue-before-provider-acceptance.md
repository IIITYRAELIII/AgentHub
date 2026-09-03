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

The immutable `clientProjectionIntent` is part of the durable request
fingerprint and record. `conversation` preserves the idle projection across
ACK, a later `task-running` conflict, snapshot races and reload; it is labelled
`Принято`, never `В очереди`. `queue` preserves busy-origin placement even when
server admission later finds the Stream idle. Ambiguous, attention-required,
paused and unknown records remain on the queue surface until exact provider
acceptance:

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
- A stale idle snapshot records `clientProjectionIntent=conversation`; canonical
  `task-running` admission preserves the already visible exact entity.
- A busy-origin submission records `clientProjectionIntent=queue` and remains
  queue-only even if canonical admission later finds the Stream idle.
- Definitive rejection removes both pre-acceptance projections and creates no
  history.
- Ambiguous, attention-required, paused and unknown records remain manageable
  in the queue without creating history.
- A reload reconstructs placement from durable `clientProjectionIntent` even
  when the bounded receipt is absent. Legacy rows without the field retain the
  narrow `conflictKind=message-intake` compatibility fallback until migrated.
- Legacy active records lacking both exact provider-start evidence and an exact
  accepted command receipt stay out of the conversation until provider history
  materializes them.

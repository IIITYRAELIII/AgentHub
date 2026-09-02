# ADR-0014 — Queue before provider acceptance

## Status

Accepted.

## Context

The UI previously kept an immediate durable-intake message in the conversation
between Hub ACK and provider start. A later chronology correction labelled that
same card as queued. Because Agent Hub already has a dedicated queue-management
surface above the composer, both variants represented an unaccepted provider
command as conversation history and duplicated queue semantics across surfaces.

## Decision

Hub durable acceptance does not authorize a conversation card. Every unresolved
command, including queued, dispatching, ambiguous and attention-required states,
is rendered only on the queue surface. The command enters the conversation only
after exact provider acceptance:

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
- No user message displays “В очереди” inside the conversation.
- Definitive rejection and ambiguous start remain manageable in the queue
  without creating history.
- A reload can reconstruct queue ownership from the durable input even when its
  bounded receipt is absent.
- Legacy active records lacking both exact provider-start evidence and an exact
  accepted command receipt stay out of the conversation until provider history
  materializes them.

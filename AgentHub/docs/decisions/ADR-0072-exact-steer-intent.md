# ADR-0072 — Preserve exact steer intent until explicit redirection

## Status

Accepted for HUB-229. Supersedes the ADR-0041 fallback that automatically
converted a provider-rejected exact steer to ordinary queued intake.

## Context

A user or inter-Stream sender can explicitly request `followUpMode="steer"` for
one exact managed run and turn. The durable command retains those identities,
but the deferred dispatcher previously changed `message-steer` to
`message-intake` when the target turn moved or the provider definitely rejected
the steer. The same item could then start a later turn without any user action.
That preserved command identity but changed the authorized effect.

## Decision

1. The original steer request authorizes delivery only to its recorded run and
   turn. Target movement before dispatch or a definite provider rejection moves
   the same durable item to visible attention-required state without a provider
   effect.
2. Command identity, steer target, inter-Stream origin and attachments remain
   intact. The lane is released because the rejected effect is known absent.
3. An explicit retry retries the exact steer. Only an explicit ordinary queue
   action converts the item to later-turn intake. New-Thread, edit and cancel
   actions keep their existing explicit meanings.
4. An unknown provider outcome remains fail-closed in bounded reconciliation;
   this decision does not authorize a replay or release its lane.
5. Ordinary queued intake and explicitly queued follow-up behavior outside an
   exact `message-steer` item remain unchanged.

## Consequences

- A stale exact-target steer cannot silently become a new provider turn.
- Later lane work can continue after a definite no-effect result while the
  rejected message remains visible for an explicit decision.
- The user can still choose ordinary queued delivery without creating another
  command or losing audit identity.

# ADR-0028 — Authoritative queue overrides idle intent

## Status

Accepted. Supersedes the idle-to-busy conflict placement in ADR-0016.

## Context

A stale idle snapshot assigned conversation intent to messages which the server
then queued behind an active turn. The client kept showing these as accepted
conversation cards, hiding both their actual waiting state and queue controls.
The user explicitly requested that these messages be visibly queued.

## Decision

Keep immediate idle optimism and normal message-intake placement. An explicit
negative admission receipt with queued/deferred state overrides conversation
intent and moves the same command to the queue. This also works for bounded
snapshot receipts which omit reason. After receipt eviction, a durable waiting
command with a non-message-intake conflict restores that queue ownership.
Only exact provider acceptance promotes the command into conversation history.

## Consequences

Client intent remains immutable request metadata, but is not stronger than
server queue evidence. Reconciliation preserves the original command identity;
it neither duplicates nor resends the message. Ordinary idle intake still
appears immediately, and busy-origin submissions still remain queue-owned.

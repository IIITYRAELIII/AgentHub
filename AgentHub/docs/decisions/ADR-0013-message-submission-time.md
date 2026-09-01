# ADR-0013 — Submission time remains immutable

## Decision

The durable message-command ledger owns `submittedAt`. Provider dispatch owns
the separate `startedAt`. Every projection of one user command keeps
`time = submittedAt` while its state advances monotonically from `queued` to
`active` to `completed` under the same `clientUserMessageId`.

An accepted immediate intake remains one conversation card and displays an
explicit queued state until dispatch. It does not also appear on the separate
deferred-queue surface. Canonical reconciliation may replace an optimistic
client timestamp once with the durable intake timestamp; later live and history
forms cannot replace it with provider start time.

## Consequences

- Queue latency is visible without falsifying the user's send chronology.
- Provider start remains available for diagnostics without becoming card time.
- Legacy rows without `submittedAt` temporarily fall back to their existing
  user-message time and then `startedAt`; remove this guard after retained
  histories have explicit submission timestamps.

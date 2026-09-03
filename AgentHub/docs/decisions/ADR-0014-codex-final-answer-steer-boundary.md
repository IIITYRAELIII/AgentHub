# ADR-0014 — Codex final-answer steer boundary

## Status

Accepted.

## Decision

Treat the exact Codex App Server event `item/started` for an `agentMessage` with
`phase="final_answer"` as the end of steer admission for that nonterminal turn.
The item must have a non-empty identity and its `turnId` must equal the active
managed run's exact registered turn identity. Once observed, a requested steer
is retained as ordinary durable FIFO intake for the following turn rather than
being sent through `turn/steer`.

Run admission owns this decision and checks it both when the command is first
accepted and immediately before the provider RPC. The second check closes the
race where final output starts after durable acknowledgement but before queue
dispatch. No timer, response text, response length, delta count or rendered UI
state participates in the decision. Commentary, analysis and reasoning remain
steerable, and the Codex-specific event does not alter Claude admission.

## Consequences

A follow-up cannot erase a partially streamed final answer by steering into the
turn that is already producing it. The follow-up keeps its original
`clientUserMessageId`, queue order, retry identity and reload behavior. There is
no migration or backfill: active runs already persist exact response-item phase
and turn identity, while runs without that protocol evidence retain the prior
steer behavior.

# TURN-001 — Terminal turn commit and delivery

## Identity and owner

A provider run is identified by `provider + threadId + turnId`. A terminal
revision extends that identity. The terminal record is the only durable owner of
final status and final content.

## Invariants

- Terminal status, final content, usage identity and last-message identity are
  committed before admission or queue ownership is released.
- Optional rollout usage, pricing and tool-metadata reconstruction never delays
  terminal commit or admission release. The terminal audit resumes from its
  durable append-only byte checkpoint and reconciles that metadata afterward.
  A cold exact-turn lookup locates the matching turn start by scanning backward
  from the rollout tail, then reads forward only from that boundary.
- The authoritative provider final is retained byte-complete by the terminal
  projection; live-preview bounds must not truncate durable final content.
- A provider completion event is not sufficient evidence to freeze a known
  prefix while the authoritative final is still materializing. Terminal commit
  uses the exact reconciled provider final after a bounded settle window.
- Terminal is absorbing: late running, progress, snapshot or reconnect events
  cannot revive it.
- Live, focused, history and badge views derive from the same terminal revision.
- Delivery uses a durable outbox. A missing UI ACK retries delivery without
  reverting terminal state or regenerating the provider effect.
- A later user turn cannot suppress or mutate the previous terminal entity.
- Projection overlays the exact latest terminal independently of a later active
  turn, so both entities remain visible in provider sequence.

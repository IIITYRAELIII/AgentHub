# Agent Hub reliability incident map

| Incident class | Repeated symptom | Structural cause | Owning contract |
| --- | --- | --- | --- |
| Local intake latency | Sends wait 5–25 seconds on one machine | Receipt locks, attachment work and one FIFO SQLite writer put unrelated full-state work before durable ACK | PERF-001, MSG-001 |
| Duplicate submission | One message appears optimistic, queued and historical or starts twice | Identity changes between client command, queue, run and provider turn | MSG-001, UI-001 |
| Ghost after reject | Client sees a failed intake, but the message starts after restart | In-memory queue was mutated before durable persistence and was not rolled back | MSG-001 |
| Missing final | Final appears after reopen/next message or disappears on restart | Terminal persistence and live/history delivery have multiple sequential owners | TURN-001, UI-001 |
| Cross-channel final loss | Web history recovers but Telegram final is absent or duplicated after crash | Terminal completion and channel outbox intent are separate commits; Telegram has no provider idempotency receipt | TURN-001 |
| False active turn | Empty “Ход выполняется” survives completion | Transport, observer or unknown snapshot is inferred as provider running | TURN-001, UI-001 |
| Delayed mark-read | Stream must be opened repeatedly | Old final is marked before fresh canonical history is known | UI-001 |
| Restart/compaction hang | Restart banner or maintenance state never clears | Flags replace a persisted exact operation state machine | RST-001 |
| Occupancy disagreement | Queue blocks a whole Stream while run registry permits parallel Threads | Queue and provider lifecycle use different aggregate keys | MSG-001, TURN-001 |
| Release noise | Duplicate/stale ready entries and false overlaps | Turn-scoped metadata freezes ownership, not the delivered patch | REL-001 |

## Common root cause

Temporary projections were treated as authoritative state while operation
identity changed between layers. Every systemic correction therefore requires
one durable owner, one immutable identity, monotonic transitions and idempotent
reconciliation. Timestamp/text heuristics remain migration guards only.

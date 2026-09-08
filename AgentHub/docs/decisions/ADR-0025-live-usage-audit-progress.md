# ADR-0025 — Bounded live usage audit cannot require global idle

Status: accepted

An attention-required input can remain queued indefinitely. Gating live terminal
accounting on an empty global queue prevents completed external turns from ever
receiving model and usage metadata. Live append-only audit therefore retains its
existing byte, turn, file and time budgets but does not require global idle.
Historical backfill retains the interactive-idle gate. This changes PERF-001;
terminal delivery remains independent of optional accounting under TURN-001.

Exact Codex `token_usage_record.turn_token_usage` counters replace inferred
legacy sums for the same turn. They are cumulative, not additive, and the paired
legacy token event must not charge the same response a second time. Old rollout
formats retain the existing legacy reader.

Startup observation exposed another starvation path: local discovery alone can
exceed the 75 ms processing budget, resulting in repeated zero-byte audit passes.
Discovery must not spend the subsequent work budget, and bounded work must make
fair resumable progress even when one unit exceeds that cooperative deadline.
Production live scanning uses the existing worker scanner with exact byte and
parser-state checkpoints. Four-MiB chunks and progress-only one-second catch-up
avoid taking hours to reach current turns in a large retained rollout. Idle and
failed scans back off; historical migration remains separately idle-gated.

Live validation also found per-terminal full-ledger reconstruction on the main
runtime thread. Audit deferral must survive the accounting composition boundary;
delivered corrections use point writes and retain a durable pending-projection
flag until their batch flush succeeds. Full projection runs in the existing usage
worker and commits only against its observed journal revision. The main runtime
continues serving controls while the worker reads and renders retained history.

Active-turn polling also reached full-ledger loading through provisional
retraction, even when the exact turn did not exist. That check uses a point read;
only an actual provisional deletion requests projection. Canonically unchanged
terminal merges likewise leave projection clean without clearing an earlier
pending flush. Worker scan time does not spend the main-thread cooperative
processing budget; byte, turn, stop and checkpoint bounds remain unchanged.

Periodic title synchronization had a separate main-thread projection bypass.
Its metadata lookup and exact changed-record updates also run in the existing
usage worker, with a revision fence before writing. Projection coverage is
recorded with the committed projection so an identical retry after failure or
restart cannot silently leave the old visible title behind.

Pricing-metadata updates, usage-estimate updates and automatic batch recording
also release their mutation lock before invoking the public projection owner.
Their legacy mutation phase still loads the ledger; this remains a migration
gap, not evidence that all main-thread journal work has been eliminated. Full
rendering on these automatic paths uses the same worker projection as live turns.

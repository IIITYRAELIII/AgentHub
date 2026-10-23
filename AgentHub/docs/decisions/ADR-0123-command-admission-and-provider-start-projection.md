# ADR-0123 — Separate admission from visible provider execution

Status: proposed local source correction; independent review and delivery pending.

## Context

The same user command can be durable in Hub while admission, checkpointing or
provider startup still proceeds. Installed measurements show a gap between
durable intake and provider acceptance. Backdating delivery to internal run creation
or labelling an occupied preparing run as executing conceals that interval.
These wall observations do not attribute CPU time or prove a specific disk wait.

The existing reviewed admission reset avoids LRU writes for absent/already-empty
diffs and preserves dirty/in-flight fences. It is carried forward. The existing
runtime snapshot path also enumerated unrelated ledger records to discard them
afterwards, despite owning only IDs present in its input snapshot.

## Decision

Keep the original command ID, durable intake, registry occupancy, mandatory run
checkpoint and provider-start owner. Project and compact snapshot references by
exact ledger point reads. Keep full canonical overlay for recovery; do not add
a second state owner, new retry lane, new command or relaxed CAS.

Derive delivery timestamps from an exact matching provider-start observation.
Persist its captured acceptance time in the terminal completion and reuse it on
command reconciliation/reopen. Keep admission/accounting time separately and
preserve legacy terminal interpretation. Missing or foreign observations cannot
supply a timestamp.
The existing retention tombstone carries only bounded captured time metadata,
including explicit null. Its payload and retention bounds remain unchanged.

Keep local outgoing rendering and receive-before-synchronize. Labels must match
their selected final projection state. Explicit preparation remains occupied and
cancellable, while running requires actual provider acceptance/start; first text,
history and accounting are optional for that presentation. Preserve exact-bound
legacy authority and terminal absorption rather than inferring absence of effect.
Before turn binding, an existing terminal receipt for the exact lane, original
client ID and run ID absorbs stale preparation. Canonical terminal history can
also resolve its exact user identity. Foreign/new originals and unknown receipts
cannot acquire terminal authority through that check.

## Validation and limits

Behavioral coverage uses the unchanged installed source as BEFORE, isolated real
SQLite/reopen, controlled slow persistence/provider boundaries and the shipped
UI DOM. No real user prompt is replayed. A synthetic or source result is not a
production latency claim. Journal/accounting/outbox work retains its existing
owner and ACK invariants; long measured phases remain visible as residual work.
Installation, canonical assignment and lifecycle remain with the authorized
owner and require their ordinary compatibility/identity guards.

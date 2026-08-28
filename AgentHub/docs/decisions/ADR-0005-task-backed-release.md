# ADR-0005 — Task-backed release authority

## Status

Accepted. Supersedes the live ChangeSet authority and migration boundary in
ADR-0003; refines ADR-0004 cleanup and Architect-role persistence.

## Decision

The Dashboard Task aggregate is the sole live release owner. Exact durable
provider-turn bindings attach terminal diffs to Tasks. A Task revision CAS and
append-only Task-owned manifest rows freeze verified Git evidence. Release plans
hash exact Task revisions and Architect completion atomically marks and closes
only the frozen Tasks that were published and deployed.

Legacy release tables are exported with row cardinality and SHA-256 verification,
imported once into the logical active Task union, and made read-only. They are not
dropped during constructor migration and receive no further live writes.

`settings.architect` is the sole runtime Architect marker and may be true for
multiple Streams. Legacy role/name detection runs once only to preserve existing
behavior.

## Consequences

There is one owner for Task lifecycle, diff evidence, readiness and completion.
Retry identity is the Task plus exact provider turn; no latest/text/time fallback
can attach work to another Task. Generic status mutation cannot bypass Git freeze
or publication verification. Frozen evidence survives restart and is protected
from edits, movement, reopen, deletion and destructive compatibility cleanup.

Physical removal of archived legacy tables requires a later ADR with independent
history export, cardinality/hash verification and explicit rollout approval.

# ADR-0104 — Preparation-only candidate recovery

## Decision

A successful Await receipt cannot be replayed to repair a later-discovered
incomplete candidate: its cached return is already terminal. Release execution
also includes validation/publication and cannot represent preparation-only work.
Add one authenticated RM-only `hub_release_prepare` and an original-addressed
`hub_release_prepare_get` to the existing MCP admission/receipt owner.

The command has a distinct original request ID. Its canonical byte-bound
arguments include the whole currently accepted set, editorial Task CAS,
publication state/generation hash, approved base, prior raw checkpoint hash,
manifest/ref/tree, primary/remote main and independently reviewed composed tree.
The source commit/tree are reviewed provenance labels; the complete fixed-root
runtime source inventory is independently hashed and rechecked under ownership.
Frozen loading must first prove these bytes correspond to the reviewed source.

The existing Workspace Await, selected Task and repository locks protect the
existing composer. Each repository retains its existing checkpoint/ref rollback
boundary through one durable terminal receipt. An optional read-only preparation
guard rejects a stale checkpoint, remote, wrong staged full/joint tree, or any
outside-selected mode/type/blob delta before commit-tree/ref promotion. The
corrected registered-base projector is required in the reviewed source closure.
No second composer, ledger, manual ref editor or Task transition is introduced.

The same SQLite receipt owner performs synchronous selected-row and genuine RM
checks in its terminal write transaction. Its bounded result retains original
request/arguments, source/publication/plan and exact candidate identities without
compaction. Selection, Task source/base/status, original successful Await,
release validation, publication and installation stay unchanged.

Definitive callback refusal uses existing expected-head rollback. Ambiguous
terminal persistence preserves the prepared candidate and UNKNOWN. The readback
returns only the addressed original receipt, never infers success from a later
checkpoint or missing lock, and never automatically replays Git. A committed
terminal followed by a lost response is returned from that exact durable receipt.

## Evidence and limits

Affected tests cover genuine RM/non-RM, stale CAS/source/plan/member/publication,
native full15/outside preservation, precommit refusal, callback rollback,
UNKNOWN, duplicate originals and lost terminal response. Corrected projector
applicability additionally requires the independently reviewed full selected
composition, including overlapping paths. Preparation capability and independent
review do not authorize live loading or recovery; the concrete current envelope
still needs the RM's operational disposition.

This is an explicit supported command, not a legacy fallback. The previous
reviewed frozen invoker bytes remain immutable; loading this extended closure
uses a separate source-pinned packet.

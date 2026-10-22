# ADR-0130: Original preparation stages and conservative resumption

Status: proposed implementation for independent review.

The original preparation can finish a main audit and then fail while reading
selected dev integration evidence. A generic error preserves UNKNOWN, but the
old row records no owner stage. Replaying it or declaring no effects from an
absent candidate would violate the original receipt's authority.

Keep the existing preparation owner and MCP operation row. A nullable bounded
JSON column records its immutable envelope/source root, custody identity,
revision, invocation owner ID and phase. Existing SQLite mutation queues and
transactions persist it; no new journal, publisher or global queue is created.
The existing Workspace Await, selected Task and repository leases enclose each
stage and explicit resume. The store compares original caller/tool/hash,
revision, prior raw state, legal phase transition and invocation owner. A
resumer changes owner only after acquiring those same leases. Slow Git and
source verification stay outside SQL retry.

Caught failure settlement also compares the original identity, invocation owner,
revision and prior raw checkpoint inside the existing catalog transaction.
A refusal before owner transfer changes no receipt. A delayed prior invocation
cannot replace a newer owner's reconciling/terminal receipt or error. Lost
checkpoint replies use exact nonce readback and that same settlement CAS; outer
intake/replay refusal does not write stage-backed failures by request ID alone.

`checking` precedes every candidate effect; `paused` records a completed caught
pre-compose interruption. Both can resume under original identity and fresh
guards. The original error is retained even after eventual success. A newer
mechanism verifies the retained original source closure as data; it never
rewrites the old source, hash, envelope or receipts. Changed/missing source
custody refuses. Ordinary duplicate prepare remains forbidden for UNKNOWN;
the explicit RM resume command takes the same original ID and stage CAS.

`composing` is written before candidate admission. `terminal-intent` is only a
proposed result while the candidate owner's rollback remains live. Neither is
proof that an ambiguous effect committed or rolled back. Explicit recovery
refuses both; normal terminal-success readback remains idempotent. Legacy NULL
stages stay NULL/UNKNOWN. The missing historical stage cannot be manufactured
from current state or an administrative approval.

The independent accepted-main bootstrap keeps its existing publication,
generation, ancestry, preservation, process and lease/CAS guards. Its preview
and execution are separate from preparation recovery. No shared dev, primary,
runtime, Contour, publication or cleanup effects belong to this source change.

Removal condition: no special historical inference exists to retain. NULL
stages remain readable indefinitely as unknown history. Additional recovery
past a composing/terminal-intent checkpoint requires the candidate owner's
authoritative original effect/rollback evidence and a separately reviewed
extension; current candidate state alone is insufficient.

Validation: focused `preparation recovery` public-owner tests use actual Git,
SQLite and default CLI consumer; actual audit precedes the ancestry refusal.
They cover normal bootstrap preserving dev-only work, same-original resume,
concurrent revision CAS, drift, legacy missing evidence and ambiguous effects.
No full release suite or live recovery is implied by fixture success.

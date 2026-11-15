# ADR-HUB-389 — Preserve reviewed native Test terminal identity

Status: accepted correction of the existing ADR-0113 recovery boundary.

An applied native Test could not persist its terminal Task CAS after a concurrent
description edit. Its explicit admission CAS and authenticated native review
also excluded the existing terminal-only recovery. Supplying the current Task
revision to reconciliation cannot repair this: it changes the original identity.

The same reconciliation owner accepts the exact original CAS/review family and
independently matches the durable receipt hash, immutable prior admission and
review delivery to the original actor. The existing Git owner accepts only that
same review in its original intent and completed capture. Its existing prepared
composition verifier reauthenticates the review and recomputes the full binding;
source/dev/staging/main/base, clean state, process guards and leases still fence
terminal persistence. It never prepares, snapshots, resumes or merges again.

Only title/description and their derived presentation revisions may differ.
Other Task semantics and unknown operation-evidence families refuse. The current
row CAS preserves presentation and commits the original outcome once; subsequent
reconciliation reads that same outcome. Original UNKNOWN/failure history is kept.
Real isolated Git/SQLite coverage includes a reviewed compatibility merge,
explicit admission CAS, durable reopen, metadata race and same-ID repeat.

A legitimate later Test may advance dev before recovery. The same TaskBoard
outcome owner provides one exact successful Test outcome for each successor
head; its independent successful MCP receipt, current result references and
original native intent/capture must agree. The Git owner walks that first-parent
chain back to the original target and revalidates each completed composition.
Arbitrary descendants, pending receipts, changed captures and divergence refuse.
The current dev head/tree/index remain unchanged. Terminal evidence distinguishes
the original applied merge from the preserved current dev head; it does not
select successor Tasks for release or import their runtime into a repair carrier.

Full composition readback uses each original's own captured native history
authority. The existing owner revalidates that exact binding and its origin
before passing it to the unchanged history/metadata verifier, for both the
reviewed original and every canonical successor. Already published notes/version
may be inherited only under that sealed publication identity and ancestry;
Task-authored notes/version, foreign publication and altered bindings still
refuse. Older captures gain no new context. Omitting the captured context would
incorrectly reject a later Test that legitimately inherited published metadata.

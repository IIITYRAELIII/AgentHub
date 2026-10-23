# ADR-0085: Durable workflow admission refusal

Status: implementation candidate under approved scope, 2026-10-06.

## Context

Concurrent description appends can invalidate the expected Task revision while
an MCP workflow operation waits for ownership. The lifecycle's initial CAS used
a generic error before creating a transition. MCP conservatively stored UNKNOWN;
the original-ID reconciler could not infer target/prior Task from missing state.
A reconciler identity refusal itself could consequently produce another UNKNOWN.

## Decision

Keep the existing lifecycle/Task SQLite/MCP receipt/reconciliation owners. For a
fresh ordinary workflow request, the owned pre-admission CAS boundary commits a
bounded structural refusal into the existing lifecycle outcomes table. It seals
the original intake identity and arguments hash, target, expected/observed CAS and
repository. The same short transaction rejects existing admission/outcome and
validates the actual CAS mismatch. No Task row revision or Git effect is changed.
BEGIN's terminal-outcome check prevents a stale continuation from admitting that
operation later. A rolled-back BEGIN CAS conflict may seal refusal only if no
preparation/effects preceded it. Replays, lost ownership and admitted operations
cannot retrospectively issue a certificate.

The MCP classifier verifies durable owner evidence before recording failed with
NO_EFFECT. Pending-startup readback and canonical original-ID reconciliation can
settle a lost receipt write from this exact evidence. Optional CAS argument shape,
caller identity and repository remain exact; recovery never invokes Git/status
effects for a refusal. Typed error strings are not authority. Immutable refusal
settlement uses only the existing SQLite receipt CAS before
release/Git locks, even with release workflow disabled. A null-root owner proof
needs no caller-invented repository: the existing `project_root` field is optional
only for that case, and any supplied locator grants no Git authority. Non-null
recorded roots still require exact input. Ordinary Git recovery retains all
existing root/workflow/guard/lease requirements. The reconciler's
pre-effect validation/confirmation/active-worker refusals terminalize its own
receipt only. Once recovery/settlement begins, ambiguous failures stay UNKNOWN.

## Limits and delivery

Historical missing-admission operations without positive owner evidence remain
unsupported UNKNOWN. Neither selected disk code, error text, absence of a
transition, current refs nor receipt timestamps prove historical non-effects.
No operator certificate, manual register, new historical API or direct SQL repair
is introduced. This prevents new hangs; it does not resolve the existing legacy
blocked operation. Live original receipts are not changed by source validation.

Validation uses public MCP plus real disposable SQLite, deterministic barriers,
concurrent append 17→18, restart/same-ID readback, outcome-before-receipt failures,
and negative admitted/partial/active/foreign/legacy cases. Source review and exact
published compatibility precede canonical Task integration/selected publication;
no separate production install, restart or release is authorized by this ADR.

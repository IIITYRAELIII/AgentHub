# Malformed workflow status and exact original disposition

Status: accepted with the corresponding reviewed result.

## Context

An admitted ordinary status request used the display label await instead of
awaiting_implementation. The MCP boundary checked nonempty text only. The
downstream domain rejected it generically, so conservative receipt handling
kept UNKNOWN. Existing reconciliation could derive a target only from lifecycle
records, which were correctly absent. Error text and absent rows alone do not
establish absence of effects.

## Decision

Validate the enum at the existing synchronous MCP input boundary using its
private validation error. Do not broaden generic owner-error classification or
change the domain exception globally. Durable admission/readback and original
idempotency remain the same.

For already admitted protocol-v1 ordinary malformed requests, use the existing
RM reconciliation owner and existing receipt transaction. Eligibility requires
the exact five-key ordinary argument family, both original CAS fields, immutable
actor/request/hash/execution identity, invalid enum, matching current Task and
configured repository, and no lifecycle/effect record or alternate operation
family. Invalidity uses the same canonical enum normalizer as ordinary intake,
including whitespace trimming and case folding. A valid case-insensitive status
with an unresolved downstream failure stays UNKNOWN, never validation authority.
The existing Task/repository/Await leases and process guard check apply.
The execution owner must prove a joined local worker; a previous runtime instead
requires the existing trusted native retirement witness and fresh exact job-zero
proof. No Stop/cancel, caller-supplied retired boolean, new queue or ledger exists.

The receipt transaction repeats identity/CAS/lifecycle checks while holding its
SQLite write reservation. It terminalizes only that original as failed, retains
the prior diagnostic and arguments, and records workflow_input_validation.
It never fabricates an earlier lifecycle outcome or global NO_EFFECT authority.
Failure of receipt persistence remains unknown. A valid changed request is a
separate future action after supported disposition; the malformed request is
never rewritten or replayed as a valid status.

Original-ID bounded validation/retirement/settlement timings use CommandTrace;
no status/arguments/content/native witness payload is logged. All valid workflow,
UNKNOWN, actor/hash/CAS and private cancellation behavior must remain intact.

## Verification and migration

Real HTTP MCP and SQLite cases compare exact parent/corrected behavior, check
same-original terminal replay, positive old downstream validation, authority/CAS
and process guards, persistence races, post-effect validation-looking UNKNOWN,
and persisted trace worker close/reopen. Native retirement production evidence
remains required at operational use; controlled runtime ports are not that proof.
The compatibility branch may be removed after all addressed old protocol-v1
malformed originals are durably terminal. Current/source composition and actual
adoption remain separately reviewed under the existing release owner.

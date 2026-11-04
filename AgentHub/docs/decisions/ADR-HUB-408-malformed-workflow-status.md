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

The retained witness reads an actively held primary lock through the existing
native owner with read access and Read/Write/Delete sharing. Windows requires
write sharing even for a reader when the instance already holds write access;
sharing grants no write access to this observer. The bounded 16 KiB read pins
the JS snapshot's volume/file index/creation/size/write identity, opens the final
component without following reparse points, rechecks the same handle and named
path, and compares the complete SHA-256. All handles are disposed on refusal.
Changed/replaced/reparse/oversized locks refuse before manifest publication.
Native Host/Node/job continuity, nonce and current-user pipe authority remain
unchanged. Because the collector source hash includes this reader, a new capture
must use the corrected helper; old collector identity is never retargeted.
See [CreateFileW sharing rules](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew).

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

### Successor cohort isolation

The retained old Job can include a later working Host and Node: Windows detached
creation does not remove inherited Job membership. That is a real refusal of
whole-cohort retirement, not grounds to ignore the active successor or old
provider children. The previous direct controlled-launch policy in ADR-0114 is
superseded only for the managed Windows replacement invocation.

That invocation now uses a pipe-connected native Host relay. The existing
external-parent/security owner creates exactly one suspended child outside all
inherited Jobs, then assigns it to a fresh PID-named Job before Resume. A name
collision refuses before ownership is acquired; no existing Job is terminated.
The relay retains the new process and Job handles. A bounded creation reply
binds the original restart ID. The existing JS operation/release/PID/token Ready
proof supplies its Node PID; the native owner additionally proves live membership
in the exact new Job. The caller joins the committed relay before success. The
successor Host retains its own Job, while the old relay naturally leaves the old
cohort. EOF/abort terminates only this newly owned Job and waits for zero; missing
creation/commit replies and unknown cleanup never authorize another launch or
old-owner recovery. This is ephemeral control of the existing single launch,
not a receipt ledger, alternate restart or historical retirement authority.

Already running legacy code still emits the old direct invocation. Installing
new Host bytes alone cannot change that loaded caller. An ordinary first
adoption from such a runtime may therefore remain inside the retained old Job;
it is not retirement. Once the corrected JS and Host are coherently running, a
subsequent supported graceful restart uses the new invocation. All other old
children must also finish naturally before the retained witness can freshly
prove zero. The release owner controls both operational transitions and exact
guards; this source does not run them, repeat historical settlement or replace
the captured witness. The original collector/native witness source is unchanged.

Maintained isolated tests execute the real compiled Host and real JS launch
owner, retain a native handle to an anonymous old fixture Job and read its
actual accounting. They cover an independently live successor with old zero,
an additional old writer that still prevents zero, native cleanup without Ready,
a foreign Ready PID and a lost native creation reply without a second launch.
Only generated synthetic applications and disposable fixture Jobs are used;
this is not a working Hub startup or actual historical retirement claim.

Real HTTP MCP and SQLite cases compare exact parent/corrected behavior, check
same-original terminal replay, positive old downstream validation, authority/CAS
and process guards, persistence races, post-effect validation-looking UNKNOWN,
and persisted trace worker close/reopen. Native retirement production evidence
remains required at operational use; controlled runtime ports are not that proof.
The compatibility branch may be removed after all addressed old protocol-v1
malformed originals are durably terminal. Current/source composition and actual
adoption remain separately reviewed under the existing release owner.

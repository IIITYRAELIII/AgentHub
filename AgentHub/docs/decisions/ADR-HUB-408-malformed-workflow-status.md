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

### Completion persistence and execution observation

The existing completion owner previously suppressed errors from writing UNKNOWN,
then submission treated any existing receipt as a result and called all
nonterminal outcomes queued. A finished worker could leave PENDING/inactive with
no error. Preserve original and persistence errors, retain both in bounded
completionFailure metadata on the existing execution binding with exact
identity/current-owner CAS, and use the existing trace for content-free failure
identities. A failure of that diagnostic write is not another effect attempt or
terminal proof. There is no new ledger, queue, background retry or deadline.
Known terminal winners and immutable STOPPED rows are preserved.

A lifecycle failure writer previously caught its own persistence error together
with lease loss, so a successful outer UNKNOWN write could still lose that inner
exception. Keep the lease-loss fence, but propagate a persistence failure with
both error identities to the existing completion diagnostic. An additional outer
write failure retains that first pair and its own exception chain. No new ledger,
queue, retry or historical receipt repair is introduced. Original timing alone
does not establish the SQL error code of an older invocation.

The same rule covers reads used to classify completion after an unsuccessful
lifecycle BEGIN. A follow-up Task read must not mask the initial persistence
exception. A later failed classification read retains both errors through the
existing bounded diagnostic and releases the local invocation. A committed BEGIN
with a lost reply still retains its real pending transition and UNKNOWN receipt;
missing lifecycle data never proves NO_EFFECT. Explicit aware cancellation uses
its existing positive recovery-lock/process-guard path, without fabricating rows.

Readback distinguishes local active invocation, explicit durable UNKNOWN,
terminal receipt and unresolved nonterminal observation. It never infers queued
from receipt presence, or retirement from an absent local worker. A same-original
submission stays read-only. Positive committed claim/preparation/custody or exact
execution-retirement evidence is still needed for supported historical recovery;
the old pending claim cannot acquire that evidence from this new diagnostic.

### Stopped valid workflow receipts

An existing failed lifecycle transition can coexist with an immutable UNKNOWN
receipt whose execution was explicitly stopped. The ordinary failed-transition
settlement attempted to update that receipt and correctly hit the interrupted
history trigger. Preserve the trigger and every original column. The existing RM
owner instead returns a read-only stopped disposition after its normal exact
workflow identity/CAS/root checks, complete retained receipt/binding comparison,
positive bound stopped retirement metadata and existing recovery leases/process
guard. It accepts only the failed-transition case, not unresolved execution or a
committed outcome. The response distinguishes workflow failure, stopped execution
and retained_unknown effects. No receipt writer, replay route or new ledger is
added; the separate reconciliation command records its own response normally.
Same-original replay/reopen and later explicit workflow admission retain their
existing semantics. This does not create historical NO_EFFECT authority.

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

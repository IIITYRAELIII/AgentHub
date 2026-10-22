# ADR-0131 — Forward custody of an unsealed claim

Status: proposed; exact source and operational recovery require independent review.

## Problem and authority

A legacy claim may return a busy error without a pre-admission refusal seal.
That error, missing rows, a quiet executor, PID absence or current Git state
cannot establish historical NO_EFFECT. Its original receipt remains UNKNOWN.
An explicitly authorized Release Manager may instead withdraw that invocation's
FUTURE continuation and authorize one exact successor through the existing claim
owner. This is a new forward action, not reconciliation of past effects.

## Existing owners and stages

`hub_task_operation_reconcile` accepts `claim_custody.action=prepare|fence` under
its genuine Release Manager and confirmation guard. Each stage has its own exact
MCP request ID/caller/argument hash. Prepare pins the original tool/caller/hash/
creation time and actual argument shape, expected Task revision/owner, clean
managed source HEAD/tree/registered base/branch, bounded WIP inventory, explicit
authorization/handoff references and the predeclared successor claim request ID.
Existing partial results, admitted bindings or lifecycle evidence refuse this
unsealed-only route and remain available for their own review.

The existing MCP ledger owns an immutable `claim_custody_json` column. There is
no second journal or assignment writer. Stage state and its terminal receipt
commit atomically. A crash before that commit repeats only read-only checks with
the same pins/ID. A committed stage reopens from that column even if its display
result was compacted. Competing fenced intents for an original or Task revision
have one winner. The original row is never settled, rewritten or replayed.

Prepare does not transfer the Task or reserve the Workspace. The RM's independent
turn may run then. Fence requires positive retirement of the complete legacy
runtime cohort, the real Task lease/process guards, and unchanged source/WIP/
original/Task pins. Only the successor claim assigns the Task. It retains the
general previous-executor active/queued-work guard, freshly repeated inside the
canonical SQLite claim transaction. No global busy-guard exemption is added.

The successor calls ordinary `hub_task_claim` with its predeclared request ID and
`forward_custody_request_id`. The Git owner verifies and reuses the existing
workspace under its Task lease; it does not align branches, reset sparse state,
prepare dependencies or invoke the old ensure again. Its response explicitly
reports `dependencyPreparation=not-replayed`; no dependency readiness is inferred.
The same TaskBoard claim transaction validates identity/CAS, inserts the existing
turn binding and assigns the successor. A lost event/outer receipt after that
commit reconstructs the exact binding without a second prepare/assignment.
Changed Task/source/caller/hash pins refuse rather than refresh expected values.

MCP intake/startup, owned prepare-to-claim lease assertions, the SQL claim writer
BEFORE same-binding baseline backfill, receipt settlement and binding SQL triggers
all honor the forward fence. A worker from a binary lacking these fences must
have positively retired before the fence is committed. A dedicated SQL trigger
also preserves the withdrawn original row against late receipt writes.

## Native retirement boundary

The primary Node/RuntimeHost birth/image/command identities and membership in
`Local\IIITYRAELIII.AgentHub.<hostPID>` are verified natively. A job allowing
breakaway is ineligible. A process/descendant snapshot is insufficient: Windows
may remove a job's NAME when its last handle closes while a detached inherited
child remains alive. Reopening an empty job under the same name also cannot prove
object continuity. Missing/denied queries and root exit alone never grant credit.

The explicit read-only `tools/claim-custody-native-witness.mjs` operator holds a
QUERY-only handle to that EXACT job and QUERY/SYNCHRONIZE root handles from before
retirement. It self-refuses if its collector is in the old job. Its same-user
local pipe has a bounded nonce-bound query and own-collector close operation.
The MCP native port verifies manifest/source hashes, data-root/primary-lock
capture, server PID/birth/command identity and the retained capture before using
`ActiveProcesses=0` plus signalled root handles. No terminate, forced stop,
process/job assignment, scheduler or service registration is introduced.

The exact positive certificate commits with the fence. Retirement is monotonic:
closing this read-only collector after commit cannot revive the old invocation,
so successor recovery can finish after a process crash without reopening a lost
job name. Before commit, losing the collector gives UNKNOWN/no certificate;
there is no fabricated fallback. The operator must be independently launched
outside the old cohort and keep its handle until the fence commit. Ordinary
agent tool children and a tested COM launch remained in the old job in the actual
runtime; neither produced an eligible live witness. Production takeover remains
blocked until a real outside-cohort witness is acquired and separately reviewed
code is delivered through the existing S2 owner. The native disposable positive
case is evidence of capability, not that operational admission.

## Verification and retirement of compatibility

Focused tests use public MCP, real disposable SQLite and managed Git, including
late originals, one-winner intents, stale pins, every stage commit boundary,
post-claim event loss, exact reopen, preserved WIP/history, busy/queued owner and
sealed-refusal controls. Native fixtures exercise a late detached descendant,
missing/denied/recreated-name limitations, exact retained-handle retirement and a
complete public-owner takeover with zero dependency preparation calls.

The legacy-forward route may be removed after supported unsealed originals are
resolved by explicit forward dispositions or authoritative original outcomes.
Future typed sealed refusals keep their existing NO_EFFECT mechanism. Delivery,
actual original readback and managed takeover remain separate required evidence;
source approval alone is not operational completion.

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
turn may run then. The default fence requires positive retirement of the complete legacy runtime
cohort. The explicitly authorized `isolated-source-v1` alternative below instead
requires independent successor authority. Both retain real Task lease/process
guards and unchanged source/WIP/original/Task pins. Only the successor claim assigns the Task. It retains the
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
all honor the forward fence. A worker from a binary lacking JavaScript fences must either have positively
retired or be technically unable to write isolated successor authority through
its supported legacy SQL/Git paths, as specified below. A dedicated SQL trigger
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
runtime; neither produced an eligible live witness. This default retirement admission remains blocked for the captured historical
original: no eligible pre-exit witness was retained. Missing historical proof is
not repaired by a replacement runtime or a newly created same-name job. The
explicitly authorized isolation alternative does not manufacture that proof. The native disposable positive
case is evidence of capability, not that operational admission.

## Explicit independent-source admission

The RM decision of 2026-10-23 authorizes `admission=isolated-source-v1` only for
the captured S10 claim of the S2-owned direct-delivery Task at revision 24 and
its exact saved source/authorization. It changes the forward guarantee, not the
original UNKNOWN. It excludes the historical S8 claim and the separate release
preparation original. The operation still requires explicit RM authorization,
exact original caller/tool/hash, expected Task CAS/owner, source and handoff pins;
it is not automatic recovery of other legacy NULL/unknown receipts.

The same Task Git owner stages a full-object standalone repository under its
data-owned custody epoch, outside legacy task-worktree write/cleanup paths.
It fetches immutable source/base object closures without alternates, shared Git,
linked worktrees, shallow history or hardlink cloning. A retained source ref and
base ref preserve the complete original history. Bounded declared WIP is copied
and hash-checked both in the new checkout and a retained snapshot. The old root
is neither changed nor described as immutable. A late old prepare/checkout or
cleanup may still affect that old root; it cannot reach the new root/epoch refs.
No original dependency ensure is repeated. Existing immutable staging intent and
snapshot records allow exact retry after init/fetch/snapshot interruption;
foreign/nonempty/aliased roots and changed snapshots refuse.

Before the fence, the existing catalog takes a bounded Task-row inventory across
actual Task-keyed tables, including secondary checklist/absorption identities.
The fence transaction rechecks that full hash and Task revision/executor plus
original effects. A committed intervening effect refuses. Admitted lifecycle or
linked-action writers must finish/reconcile first. SQLite serializes a concurrent
writer; a legacy read transaction cannot upgrade a pre-fence stale snapshot.
The namespace and withdrawal disposition commit together in the existing MCP
ledger. No assignment occurs until ordinary successor claim under its Task lease.

Persistent SQLite BEFORE triggers fence assignment, binding/baseline, lifecycle,
result refs, Task metadata/history/checklists and secondary linked identities.
They cover INSERT/UPDATE/DELETE/UPSERT/REPLACE and preserve the withdrawn original
and custody row against late receipt writes, deletion and rekeying. These are
schema fences visible to connections/statements opened before recovery, not only
new JS epoch checks. The new canonical store captures namespace epochs before
its asynchronous mutation queue. A synchronous transaction-scoped permit grants
only the current owner statement and is removed before commit; a legacy writer
cannot interleave while the permit exists. Rollback/crash cannot publish a grant.
Historical turn callbacks and result snapshots lacking that epoch are refused.
This models supported old owner paths, not arbitrary SQL/processes with the same
OS privileges or an adversary that changes the schema.

Ordinary subsequent prepare/snapshot/Test/result-ref/Await use only the new
physical source and epoch refs while retaining the registered logical repository
and publication identity. Native Test imports immutable objects from the private
repository under the existing dev lease; canonical composition does not take
old shared Task result refs as current authority. Contour database copies retain
history but do not gain the production data-root capability. An isolated source
and its retained WIP are not implicitly retired by generic Task cleanup; artifact
retirement remains a separate, explicit owning prerequisite.

The first successor claim reuses the verified snapshot, with zero prepare/ensure.
Its SQL binding/assignment commit and exact lost-event/reply recovery remain with
the existing claim owner. Two recovery intents have one winner; stale/foreign
caller/hash/CAS/source refuse. The normal previous-executor busy guard stays in
force and requires a naturally free short handoff window. Delivery, installed
capability verification, fresh guards, actual recovery and managed takeover are
required after independent exact-source acceptance; this ADR grants none itself.

## Explicit unassigned intake continuation

The separate scoped RM decision of 2026-10-24 permits the same forward-only
mechanism for the captured unassigned functional-test Task and original S6
claim. Its old UNKNOWN is not a lock-timeout NO_EFFECT proof. There is no UUID
allowlist in production: each operation still binds explicit authorization,
original identity, nullable expected owner, exact Task revision and one genuine
successor. A null owner is accepted only with independent-source admission for
an open/new Task without accepted Git results. A missing owner pin is invalid.

The existing Git owner first reuses a pinned discovered managed source/WIP, if
one exists. Otherwise it may pin exact local main/base/tree of the actual
registered project, with the ordinary Task branch identity and empty Task WIP.
It checks for prior deterministic Task directories and Task refs under the Task
lease before and after staging. Discovered artifacts are preserved and refuse
base substitution; they require their own exact managed-source handoff. Shared
Workspace WIP is not silently treated as Task WIP. This base source is copied by
immutable object identity into the same independent full-object epoch, without
calling prepare, ensure, alignment or assignment. A late old prepare/cleanup can
reach only its old deterministic namespace. The original/base history, logical
repository and publication lineage remain intact.

The existing atomic Task-state inventory, persistent SQL/receipt fences, stage
receipts, one-winner CAS and exact reopen/claim recovery apply unchanged. A null
previous executor has no active/queued work; assigned-owner busy guards retain
their behavior. Changes before the fence refuse instead of refreshing pins.
Source acceptance still requires matching delivery, actual capability, fresh
operational guards and the genuine declared successor claim.

The declaration is resolved by its request ID in the existing MCP ledger before
any fresh receipt insert, not only through untrusted Task/forward arguments.
The indexed lookup and receipt write use one SQLite transaction. Tool, actor and
complete arguments hash must match the fenced successor; planned declarations
cannot be consumed early. Persistent INSERT/UPDATE guards protect the same
global ID against old cached insert/replace/rekey statements. A preoccupied ID
or another intent's declaration refuses preparation without changing its row.
This adds no ID registry or replay identity. Unrelated operation IDs retain their
ordinary behavior, and genuine exact retry/reopen retains one assignment.

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

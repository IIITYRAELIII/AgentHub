# Explicit interruption of Task operation execution

Status: proposed for independent review with HUB-368.

The user explicitly requested a way to interrupt blocking Task operations,
including claim, Test and Await. A provider RPC timeout cannot establish that a
worker stopped; missing PID information cannot establish historical NO_EFFECT.

## One existing receipt owner

The existing `hub_mcp_operations` ledger retains an optional
`task_execution_json` binding. New claim/workflow admission atomically binds the
actual Task, exact original arguments without the context capability, and one
in-memory execution incarnation. Interruption adds requested/stopped disposition
to that binding. It preserves the exact original receipt snapshot, error,
result, timestamps, argument hash and lifecycle/Git evidence. A known pending
execution terminalizes as failed execution only after stopped; its past effects
remain explicitly unknown. An original UNKNOWN keeps that UNKNOWN unchanged.
Terminal pending receipts also keep older startup readers from replaying them.
SQLite fences reject a late
terminal write or REPLACE of the retained original.

`hub_task_operation_cancel` requires explicit confirmation, original request ID,
argument hash and current Task revision. The genuine original Stream or a genuine
Release Manager may call it; the authenticated desktop user uses the same owner.
Caller Workspace and target Task Workspace are distinct identities, as in the
existing global Task API. Legacy arguments must independently reproduce the
original hash and Task ID. Existing forward-custody authority is not replaced.

## Actual stop, not a receipt-only dismissal

New workers inherit one execution context through the existing TaskGit leases,
interprocess-lock queue and child-tree stopper. Cancellation is durable before
the signal is aborted. Queue cancellation never enters prepare. Running commands
use the existing confirmed tree-stop behavior; unresolved process guards remain
blocking. Every subsequently dequeued SQL write checks the same durable binding,
including late inherited callbacks. Another Task's lock is never removed.

An aware worker in another service incarnation observes the same durable fence
through the existing lease heartbeat; that signal uses the same child stopper.
The recovery lease then linearizes against its old execution. This is not
legacy cohort inference: only new atomic admissions carrying this cancellation
protocol have that authority. After the original worker joins or this aware
worker is durably fenced, the existing recovery lock verifies absence of
its process guard, retains the original lifecycle transition as failed execution,
and seals the stopped disposition. Already committed outcomes are not rolled
back. A completion that wins the race remains completed. Stopped originals never
replay on restart; a new explicit action may proceed through ordinary ownership,
content, source, lease and CAS checks. Dirty files and Git state are preserved.

## Historical unsealed worker

A legacy UNKNOWN has no trusted in-memory execution binding. The existing native
RuntimeHost cohort observation/witness owner must positively certify whole-group
retirement. The existing Windows owner requires the retained native QUERY
witness before the legacy request is admitted; without it cancellation refuses
before changing the original. A cancellation request may return `requested` with
`waitingFor=previous-runtime-retirement`; this is not `stopped` and does not clear
a process guard. Retain a native QUERY witness outside the old job before its
normal retirement through the existing witness protocol. A later explicit
cancellation command addresses the same original; it never replays claim/Git.
The first cancellation command keeps its original response. Current disposition
is read from the Task operation list, independently of that transport receipt.

There is no automatic restart, uninstall, rollback or production publication.
Historical recovery that lacks positive retirement evidence remains pending.
This is a migration boundary for legacy workers only, not a new limit on future
cancellable workers. The native witness and retirement requirements may disappear
only when no legacy execution incarnation can still affect the retained Task.

## Surfaces and application

The Task card exposes `Операции задачи` and `Прервать операцию`; cancellation uses
the existing authenticated control router and bypasses the original mutation's
frontend/backend waiting lane. The same service is forwarded through the actual
composition chain. Missing original Task binding in legacy UI rows requires the
agent/operator's exact original argument family; it is never guessed by time.

The existing `task-operation-reconcile.mjs` entry accepts `--cancel-arguments`
pointing to the exact cancel-tool JSON, plus its ordinary local provider/thread/
Stream identity. It invokes the same authenticated Hub service and stores. This
does not grant publication or source-cutover authority.

For the real Nexus original, retain its UNKNOWN/error and dirty source, capture
the existing trusted native cohort evidence, apply the exact independently
reviewed correction through the Release Manager, and finish cancellation only
after confirmed old-cohort retirement. Then use ordinary claim and verify the
same source bytes. Source review and synthetic fixtures are not that live proof.

## Pending stop and authenticated Desktop admission (HUB-368 R1/R2)

A requested stop excludes new ordinary claim/workflow admission for that Task
until confirmed stopped. The same indexed durable disposition is checked in
receipt admission, before execution/next effects, and inside final Task SQL
transactions. Cancellation continuation and other Tasks remain independently
operable. A late assignment/finalization cannot overtake the requested stop.

An authenticated Desktop workflow has actorKind=authenticated-user in the same
MCP operation ledger, including an unassigned Workspace or Backlog Task. Its
Stream/provider/Thread are null, not an invented provider turn or new Stream.
Provider admissions retain their exact required caller identity. Existing rows,
indexes, triggers, custody and receipt evidence survive the atomic nullable-user
identity migration unchanged; no historical operation is reclassified or replayed.
The existing Desktop controller and cancellation owner read and stop this exact
operation before the next ordinary action, without changing Task assignment.

## General Task admission/result continuation

The user's follow-up expands this Task to reliable claim/update/Test/Await and
cleanup operation reporting. The observed original Await lasted 197726 ms;
existing trace attributes about 156890 ms to composition and about 14.5 ms to
Task/repository lock admission. Two 60-second MCP timeouts therefore described
transport waiting while the original worker subsequently succeeded. This change
does not claim to optimize the measured Git composition itself.

Reuse `#pendingMutations` and the existing durable MCP ledger. A submission
adapter releases the transport waiter only after durable admission and worker
registration; it never creates a second queue. Public MCP reads use
`hub_task_operation_get`; Desktop uses existing `board-task-read`. Local terminal
consumers keep their old Promise semantics. After lost ACK or reconnect, an exact
original read obtains pending, success, failure or truthful UNKNOWN without
replaying work. The existing CLI adds a read-only argument mode, not a new
operation-specific driver. Reads cannot reconcile history or infer retirement.

Desktop create/update/Complete/Delete additionally carry genuine user admission
through the same ledger. Atomic trigger replacement expands only its existing
permitted tool family and retains immutable original user identity. Existing
TaskGit leases, workflow CAS and cleanup owners remain responsible for effects.
The shipped client separates transport ACK from final business success, waits
through original-addressed reads using existing transport cadence, and permits
independent cancellation. No new total work timeout, cap, global lane or domain
cleanup implementation is added.

Content-free admission/result spans use the existing trace recorder. Real
transport/SQLite/Git, actual Desktop factory, shipped-browser reconnect/cancel
and existing CLI tests cover this continuation. Controlled fixtures are not
installed application: production delivery and live-agent/UI AFTER remain the
sole release owner's required separate step. Legacy callers that previously
expected a synchronous public MCP result must consume the advertised envelope
and exact read tool; internal service callers remain synchronous.

## Full-pipeline correction: context dependency and committed readback

The full pipeline exposed application imports of an infrastructure process
module, and a false owner rebind during an already committed custody claim
readback. The shared async-local execution capability lives in ports; the process
adapter retains lease decoration and reexports that same capability. No second
storage or cancellation owner exists, and the dependency matrix is unchanged.

Only a positive committed successor binding selects readback-only consumption.
Existing caller/hash/fence/Git/Task-CAS/lease validation runs again; the readback
may not enter assignment if its binding disappears. It retains prior execution
metadata byte-for-byte (or legacy absence). Ordinary bind rejects another owner
as before. Inherited cancellation and late-SQL checks still run around readback.
Two old launcher test doubles now expose their actual local ledger point reader;
no production missing-port fallback or suppressed cancellation error is added.

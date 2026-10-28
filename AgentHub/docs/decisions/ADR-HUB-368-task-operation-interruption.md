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

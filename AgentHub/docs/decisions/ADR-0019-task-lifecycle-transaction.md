# ADR-0019 — Transactional Task lifecycle and exact release closure

## Status

Accepted and consolidated by HUB-177; the original implementation was tracked by HUB-159.

## Context

Task workflow status, Git integration, stored result references and cleanup were
previously separate operations. Status could advance before a failing merge,
an empty diff could be reported as integrated, and Delete removed the database
row before destructive worktree cleanup. Release completion accepted one
optional revision and ancestry, which could not distinguish the frozen candidate
from a published commit containing unrelated changes. Synchronous SQLite busy
waits also blocked the Node event loop while these operations contended.

## Decision

Use one durable Task lifecycle transition per Task. A result-bearing workflow
transition records its expected Task row revision, prepares and integrates Git
evidence under the Task and repository leases, then atomically CAS-commits the
workflow status, exact result references and operation binding. `no_result`, Git
failure and CAS failure preserve the previous aggregate. Restart never repeats
an external lifecycle effect: it finalizes an exact durable outcome or marks an
incomplete transition `unknown`; there is no time-based blind replay.
The MCP and Desktop Dashboard adapters both invoke the same application
`TaskLifecycleService`; raw Task-store status, Complete and Delete calls are not
an alternate policy path.

Complete and Delete use a content-free preview token bound to the exact Task
revision and Git cleanup plan. Complete is available to analysis Tasks without
Git artifacts, or to workflow-Done implementation Tasks whose clean exact result
is contained in `origin/main` and the same exact revision is named by durable
publication evidence with a generation. Local `main` is never publication
authority. Confirmation and cleanup recheck bind that exact publication
generation, so replacing publication evidence at the same commit invalidates
the operation. Delete is the explicit destructive path for
unpublished work. Both serialize on the Task lease; Delete removes the database
row only after cleanup succeeds. Task base and protective result refs are
separate and are removed only by the confirmed lifecycle operation.
The client formats, but never recomputes, the server preview and displays every
available branch, worktree, HEAD, dirty/changed/untracked path, result commit,
publication revision/generation/state and exact deletion target before either
Complete or Delete. Cancelling that confirmation performs no second mutation.

Release preflight's independent clone checkpoint is the freeze authority for
each repository. Completion requires exact
`{planRevision, manifestHash, baseCommit, preReleaseHead}`, a caller-supplied
revision for every repository equal to that head, and a repeated publication
generation readback immediately before the Task closure transaction. Primary
Workspace synchronization happens afterward and reports cleanup diagnostics
without changing the successful release result.

MCP mutation receipts use atomic identity admission, compact structural success
records and explicit `unknown` reconciliation. Core Hub SQLite connections do
not busy-wait on the event loop; bounded asynchronous retries keep the original
request identity and yield to HTTP, SSE and timers. Startup inspects every
pending receipt: an exact completed lifecycle outcome finalizes success without
a second effect; incomplete lifecycle/start transitions and all other unresolved
outcomes become terminal `unknown`. An exception after mutation
dispatch also becomes `unknown` unless authoritative readback proves no effect.

Interprocess locks use an immutable token-addressed owner file, an owned file
handle, PID and process-instance identity. A contender never reclaims a lock
merely because its heartbeat or age is stale while the prior PID is still live;
automatic recovery requires proven process death, an exact identity mismatch or
an owner-written release marker. Unknown identity fails closed for operator
recovery. Renewal only verifies the current durable token and identity. Release
writes through the original owned handle and removes only its token-addressed
file, so a path swapped to a replacement owner cannot be rewritten, renamed or
deleted by the old owner. Every asynchronous ownership assertion rereads that
durable identity and every lifecycle caller must await that assertion before a
Git or database effect; synchronous fence implementations are rejected.
Heartbeat loss still aborts the old owner. A legacy mutable `owner.json` is
retired only after proven process death or exact identity mismatch by moving the
whole legacy directory to a bounded quarantine and revalidating it there. Live
or ambiguous legacy identity remains fail closed; token-file release semantics
are never applied to the legacy path. Multi-step Git
operations pass the lease AbortSignal into the process owner and recheck durable
ownership before and after each irreversible command, before protective ref
updates and before the DB commit. Before every lease-protected Git process,
the process owner atomically persists a per-Task/repository in-flight guard
containing the lease owner, command and canonical repository identity. A later
owner cannot enter prepare, snapshot, merge, cleanup, ref or DB follow-up while
that guard remains, even after the lease expires. Natural completion or a
successful bounded whole-tree stop clears it; `TASK_GIT_TREE_UNPROVEN` leaves it
durable. Only explicit operator proof that no descendants remain can recover it.
The low-level Git mutation boundary rejects a missing or non-guard-capable lease.
Public Task prepare/start/claim acquires the Task lease and then the repository
dev lease before calling private owned methods; lifecycle callers already holding
the Task lease use only those owned methods. Standalone `prepareDev` acquires its
repository lease and installs the same durable guard. No callback discards a
lease and no nested path reacquires its own Task lock.
Stale quarantine retries have a deadline, and release failures are diagnostics
that cannot replace a successful protected-operation result. Git timeout waits
for process-tree termination. Failed or hung `taskkill` does not claim tree
termination after killing only the root; unproven descendants durably block
that integration workspace for operator recovery. Startup reconciles every
registered repository's existing managed `dev` worktree, rather than waiting
for a later integration request.

Production composition creates Task and Workspace capabilities through one
executable persistence-composition factory; application services receive only
its branded owners, never either raw SQLite writer. Each owner is an immutable
asynchronous capability whose complete mutator
inventory is queued with bounded retry; callback-based `runMutation` and raw
`transaction` are not exposed. Read methods are explicitly allowlisted and every
unclassified raw member fails closed; `WorkspaceCatalogStore.load` remains a
bootstrap/migration-only writer. Release completion also requires the branded
Task owner and awaits its queued transaction before primary synchronization.
Handoff metadata, provider catalog assignment,
Spark/Terra thread binding, settings, Workspace events, journal completion,
Desktop, Telegram, MCP and Task lifecycle all cross this same enforced boundary.
Startup pending-triage recovery is also an awaited owner mutation; queue failure
rejects infrastructure startup instead of being detached as an unhandled task.
Raw synchronous stores remain limited to their bootstrap/migration owner and
tests. Task and Workspace queues never await each other while holding a SQLite
transaction, so opposite-order application sequences cannot deadlock.

## Consequences

Task status calls can now fail when their requested state has no proven result,
and Complete/Delete require a second confirmed call. Release clients must send
the exact revision for every frozen repository. These are intentional fail-closed
API changes. Failed transitions remain diagnosable without publishing partial
workflow state, and ordinary Hub traffic remains responsive during SQLite lock
contention.

# ADR-0019 — Transactional Task lifecycle and exact release closure

## Status

Accepted for implementation by HUB-159.

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
failure and CAS failure preserve the previous aggregate. Restart may resume only
the same durable operation identity; there is no time-based blind replay.

Complete and Delete use a content-free preview token bound to the exact Task
revision and Git cleanup plan. Complete is available to analysis Tasks without
Git artifacts, or to workflow-Done implementation Tasks whose clean exact result
is contained in published main. Delete is the explicit destructive path for
unpublished work. Both serialize on the Task lease; Delete removes the database
row only after cleanup succeeds. Task base and protective result refs are
separate and are removed only by the confirmed lifecycle operation.

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
request identity and yield to HTTP, SSE and timers.

Interprocess locks use token, process-instance identity and renewable lease.
Stale quarantine retries have a deadline, and release failures are diagnostics
that cannot replace a successful protected-operation result. Git timeout waits
for process-tree termination; an unrecoverable merge/index state durably blocks
that integration workspace for operator recovery.

## Consequences

Task status calls can now fail when their requested state has no proven result,
and Complete/Delete require a second confirmed call. Release clients must send
the exact revision for every frozen repository. These are intentional fail-closed
API changes. Failed transitions remain diagnosable without publishing partial
workflow state, and ordinary Hub traffic remains responsive during SQLite lock
contention.

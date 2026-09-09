# ADR-0031 — Ordinary Task workflow status without Git

## Status

Accepted. Clarifies the scope of ADR-0004 and ADR-0019.

## Context

Release preflight respected the Workspace opt-in, but the shared Task lifecycle
still acquired a Git lease and required a worktree for Test, Await and Done.
Ordinary database-only Tasks without an executor Stream or project root could
not change those statuses. A stale Git process guard could also block them.

## Decision

Only an explicit `settings.releaseWorkflowEnabled === true` enables the Git and
release portion of a Task workflow transition. False or absent policy uses the
existing Task lifecycle begin/commit operation, its row-revision CAS, durable
outcome and status event. It invokes no Git lease or external release effect and
requires no Stream or project root. Claimed-turn binding identity is preserved,
and existing Git references are retained rather than erased.

Release-enabled Tasks keep exact snapshot/integration evidence, Task and
Workspace leases, Await rebuild and rollback. Complete/Delete remain separate
artifact-aware operations; disabling policy never authorizes artifact deletion.

## Consequences

MCP and Desktop continue to share the same lifecycle owner and authorization
boundaries. Ordinary Task state is independent of development infrastructure.
Concurrent database changes still conflict rather than silently overwriting
the Task, and incomplete operations use the existing durable reconciliation.

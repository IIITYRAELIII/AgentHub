# ADR-0055 — Await follows successful PreRelease integration

Date: 2026-09-16
Status: Accepted
Contracts: REL-001, MCP-001, UI-001

## Decision

The user rejected acceptance before integration. Match Test/dev ordering:
prepare PreRelease from the Task's exact Test result first, then persist Await.
On a composition conflict the Task remains in Test. The executor fixes its branch
and retries the ordinary lifecycle. No temporary Await followed by status rollback.
Release publishes the prepared PreRelease; no second manual Task selection.

Use the existing planner with a prospective row-revision projection and the
existing candidate owner's rollback boundary. Hold the Workspace Await and Task
leases until the status CAS resolves. For several repositories, keep all candidate
boundaries open until the one CAS succeeds. A proven rejection restores Git;
a lost SQLite reply reads the exact durable lifecycle outcome; unresolved outcomes
remain unknown without speculative rollback. Reconciliation stays with the existing
operation owner and original request identity. No new background recovery owner.

Status rules become a short explanation rather than instructions to repeat Hub's
Git machinery. Exact old generated policy prefixes remain migration inputs until
supported stored rules no longer contain them; authored variants are preserved.
Previously committed legacy Await operations retain their historical evidence.

Workspaces without the release workflow retain ordinary SQLite status transitions.
Auto-review alone does not enable Git integration. Release freeze, isolated managed
checkout, exact Test result and mandatory final publication checks remain intact.

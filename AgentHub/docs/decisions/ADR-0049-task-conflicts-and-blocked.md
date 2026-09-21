# ADR-0049 — Conflict continuation and explicit Blocked Tasks

Status: revised by the user, 2026-09-15. Agent workflow accepted; HUB-235 item 4
implementation review remains open. Not deployed.

## Decision

An ordinary Git conflict is a known failed Test attempt after proven rollback,
not an unknown operation. Preserve diagnostic paths and both revisions through
the lifecycle and MCP boundaries. The failed lifecycle must be durable before
its typed error can settle the MCP receipt. Ambiguous failures remain unknown.

For conflicts between Tasks, the agent consolidates work using existing
operations. The encountering Stream notifies the other executor, confirms its
unfinished changes are saved and its work stopped, and takes over that Task.
The other Task survives: merge the current Task's requirements, checklist and
useful results into it, then merge the current branch into its managed branch.
Task-local save and merge commits for this handoff are authorized. Resolve the
conflict and validate the combined result before closing the current Task as
combined, linked to the surviving Task. Closure does not mean published Done.
Preserve source work until its transfer is verified. The surviving Task gets
a checklist with one native linked item for each absorbed, closed Task.

Before branch merging, return both old Test/Await results through the ordinary
lifecycle; handle a dependent Task first when required. Commit the merge locally,
then submit one combined result owned by the surviving Task. Use the existing
complete operation with absorbed_into_task_id to archive the source while keeping
its Git artifacts. Its confirmation binds both Tasks, exact source and target
commits and proves the absence of an independently owned source integration. This remains ordinary
development and does not authorize publication.

Blocked is for dependent work kept as separate Tasks, normally until publication
of the prerequisite. The user may explicitly authorize an exception, including
consolidation. Only the compact status badge is red. No automatic consolidation
engine or unconditional policy prohibition is required.

## Validation

The instruction change is checked through the existing rule-composition tests.
Earlier tests and draft runtime changes are evidence about individual mechanisms,
not proof of the new end-to-end consolidation workflow. Verify actual available
handoff and closure operations before claiming that a consolidation completed.

## Scope

This decision supersedes automatic dependency cascades and pinned-old-dev
resolution as the prescribed conflict workflow. The recursive cascade and pin implementation
have been removed. Known dependency refusals now terminalize their own attempt.
The existing claim and complete operations support the agreed handoff; they do
not merge branches or generate descriptions/checklists automatically.
Existing unknown receipts are not rewritten by this instruction edit. Runtime
deployment remains the later HUB-235 release.

# ADR-0057 — Review incoming main changes in a Task before publication

Date: 2026-09-16
Status: Accepted
Contracts: REL-001

## Decision

Fetch observes upstream; it never authorizes pulling origin/main into local main.
The Release Manager inspects all incoming changes, even cleanly merging ones, and
reports them to the user. Necessary integration and conflict resolution happen
in the relevant managed Task branch, with user changes preserved and appropriate
checks of the combined result. Ambiguous intent is discussed before discarding
changes. This preparation does not itself accept the result for publication.

The user approves the shown combined result before upstream adoption, PreRelease
acceptance and publication to main. The agent records exact revisions through
the existing workflow; the user need not repeat hashes. The same unchanged
approved release may continue without renewed permission. New origin/main changes
require a fresh report and approval of the updated result before publication.

This changes Release Manager instructions, not Git authority or the MCP approval API.
Existing main audit, Task adoption receipts, pre-push identity checks and guarded
post-publication synchronization remain in force. No automatic upstream acceptance
or direct primary-checkout mutation is introduced. Release-disabled Workspaces
retain their ordinary workflow. The old exact generated Release Manager prefix remains
a compatibility input until supported stored rules no longer contain it; authored
variants are not rewritten.

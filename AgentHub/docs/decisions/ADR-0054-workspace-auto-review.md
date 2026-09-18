# ADR-0054 — Workspace auto-review and direct executor feedback

Date: 2026-09-15
Status: Accepted
Contracts: REL-001, SYS-002

## Decision

Add an independent, default-off Workspace auto-review checkbox after release
workflow. Its generated instructions require executors to request independent
review directly and reviewers to reply to the executor, without a Team Lead
relay. Corrections return to the same reviewer Stream, including after Thread
rotation. The Task retains the reviewer identity and exact-result evidence.
Review findings must demonstrate unmet requirements, regressions, applicable
contract violations or unnecessary added work. Unchanged approved results do
not need another review without new evidence.

Team Lead retains a short delegation-only policy, with intervention for decisions
or reassignment. Release Manager release duties remain separate. No review scheduler,
automatic message fan-out, status gate or new review database is introduced.

## Compatibility

Existing Workspaces are not opted in. Omitted settings fields preserve the flag;
explicit false disables future instruction injection. Generated policy is kept
out of authored rules. Exact old Team Lead prefixes are replaced by the short
policy without altering authored variants; the old prefix can be removed when
supported stored rules no longer contain it. Existing conversation history is
not rewritten.

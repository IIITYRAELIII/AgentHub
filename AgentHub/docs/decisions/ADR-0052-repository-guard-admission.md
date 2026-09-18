# ADR-0052 — Repository guard admission and claim no-effect receipts

## Status

Accepted for HUB-231; transferred into HUB-235.

## Context

A `hub_task_claim` encountered the temporary repository guard of another live
Task Git owner. The old admission path inspected foreign guards before waiting
for the common repository dev lease, so ordinary contention was reported as an
unresolved orphan requiring operator proof. The claim never reached its Task
transaction, but the MCP owner lacked a source-owned no-effect classification
and persisted the result as `unknown`; exact retry then refused all dispatch.

The incident receipt was created at `20:16:33.046Z` and settled at
`20:16:33.680Z`, while the guard record reported `20:16:38.170Z`. Those clocks
are contradictory and cannot establish causal order. The synchronous owning
path proves only that the pre-lock scan observed the guard. Recovery must rely
on exact source identity and durable effect readback, never timestamp ordering
or the later absence of the guard.

## Decision

1. Every repository-scoped guarded Task Git operation acquires the common dev
   lease before it inspects foreign guards and retains that lease until its
   guarded commands have naturally completed or their bounded stop is proven.
   Normal live contention waits. An orphan guard remains fail closed.
2. The repository-guard admission error carries an owning version and exact
   canonical repository/guard identity. In a claim this point precedes base-ref,
   worktree, child-process and Task-binding effects, so the MCP owner records a
   terminal failed receipt rather than an unknown outcome.
3. Same-ID recovery of a legacy unknown claim is allowed only for the exact
   former `task-git-repository-guard-before-dev-lock-v1` error. The existing MCP
   receipt authenticates caller, tool and arguments hash; Task persistence must
   prove no binding anywhere for that operation ID; the Task Git owner validates
   the foreign Task guard path and canonical repository key. Recovery only
   changes the original receipt from unknown to failed and never replays Git work,
   deletes a guard or changes Task lifecycle state.
4. An existing/ambiguous binding, wrong request arguments, unrecognized source
   error, malformed path, same-Task guard or repository mismatch remains unknown.

## Consequences

- Two live Task owners serialize on the repository resource they actually
  share instead of converting contention into an operator incident.
- A genuinely unproven process tree retains the existing explicit recovery
  requirement.
- The one legacy classifier has a removal condition: no supported durable MCP
  journal may still contain unknown claim receipts emitted by its named version.
- Deploying this code is required before an affected historical claim can be
  settled by exact retry; source changes alone do not alter the running Hub.

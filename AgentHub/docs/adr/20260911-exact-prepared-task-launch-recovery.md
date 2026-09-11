# Exact recovery of prepared Task launches

## Status

Accepted, 2026-09-11.

## Context

Task launch deliberately persists its Task owner before creating a Stream or
dispatching provider work. The `task.starting` audit event inherited the planned
Stream ID from that Task even though the Stream did not yet exist. The catalog
correctly rejected the impossible membership, leaving the Task in `starting` and
the MCP receipt pending before any Stream, Thread or delivery effect.

The generic startup rule converts every incomplete launch receipt to terminal
`unknown`. Retaining it as a retry capability would let the obsolete request
take the Task back after an operator assigns the Task elsewhere. The receipt
does not retain raw arguments or message text, so startup cannot and must not
synthesize or replay the call.

## Decision

Record `task.starting` against the Workspace until its planned Stream exists.
Put the planned destination and request identity in the payload, deduplicate the
event by Task/request, and await its write before creating the Stream.

Keep startup behavior fail-closed: a prepared launch becomes `unknown` and is
never a replay lease. Add an Architect-only `hub_task_launch_cancel` operation.
It accepts the original receipt in `pending`, `reconciling` or `unknown` only
when the caller Workspace, Stream, provider and provider Thread match, the exact
Task revision still owns that start request, the Task remains `starting`, the
planned destination Stream is absent and no inter-Stream content hash has been
admitted. Terminalize the original receipt as a structured failed/cancelled
outcome before clearing Task launch ownership with its request and revision CAS.

The original arguments hash remains immutable receipt evidence and is returned
by cancellation diagnostics, but it is never decoded into a launch. Provider
turn identity is not a receipt field: a later turn in the same exact provider
Thread may cancel, while a rotated/different Thread cannot. An absent content
hash proves that message admission did not occur; a present hash blocks this
cancellation even if the planned Stream later disappears.

Reject ordinary Task claim while the Task remains `starting` under a launch
owner. After cancellation, normal start/claim into an existing Stream may assign
the Task; the terminal original MCP receipt prevents its request from executing
again through the supported bridge.

## Consequences

An event rejection leaves durable evidence and produces no downstream launch
effect. Deployment does not launch pending work by itself. After the corrected
runtime is ready, the originating Architect explicitly cancels the old request,
then assigns the same Task through the ordinary existing-Stream path with a new
request identity. If the process stops after terminalizing the original receipt
but before Task cleanup, the Task remains blocked for a later cancellation; the
old launch stays non-replayable. Corrupt, ambiguous, cross-Workspace or otherwise
unproven state remains blocked. No missing arguments or content are reconstructed
from logs, Task rows or ordering.

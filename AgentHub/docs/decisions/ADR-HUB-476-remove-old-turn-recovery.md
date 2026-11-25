# ADR-HUB-476 — Remove old user-turn recovery

## Decision and superseded policy

The 19 November 2026 user report confirms that published 2.1.10 still runs its
"Восстановление активных ходов" startup operation. `notLoaded` failures retain
old local admission and block queued input. ADR-HUB-470 removed reexecution but
retained recovery reads and settlement; that narrower policy did not satisfy
the user's request to remove the entire old-turn recovery mechanism.

Remove the operation and all automatic provider recovery capabilities, reconnect
and replacement calls, ordinary UNKNOWN recovery delegation and old Claude
worker reattachment. Automatic selected-Thread watchers cannot reconstruct an
external run or new local admission. Current newly launched turn observation,
explicit Stop/steer, ordinary history/context reads, terminal projection outbox,
Task/Git receipt reconciliation and installation rollback keep their own owners.

Under the existing acquired single-instance data-root lock, the runtime-state
owner durably records a previous-local-execution disposition in the existing
`provider_run_local_retirements` lifecycle store. It binds the original saved
run/provider/Thread/turn/client command/Stream, including explicit absent legacy
fields. Only local admission is released; the provider outcome is not decided.
The full old record, partial answer, command, history and queued attachments
remain retained. Historical boot dispositions retain their original validator.
Failed disposition persistence fails startup explicitly without rewriting the
snapshot as empty defaults. A current-process run has no restored provenance;
changed identities and current registry replacements cannot use old custody.
Late provider acceptance telemetry retains the full original local-custody key
in that existing disposition. Snapshot restoration binds its run/provider/Thread/
turn/command/Stream/start fields and verifies the complete key against the canonical
lifecycle row; changing telemetry dates does not replace or weaken that key.

No provider lookup, resume, interrupt, old prompt launch, native process stop or
fabricated provider terminal is needed for this local transition. Independently
live external work remains external; new input retains fresh execution guards.

## Evidence and verification boundary

Regression starts the actual full Hub shell from the published source graph
with a canonical saved run and a durable paused input/attachment. A controlled
local App Server rejects old Thread reads as notLoaded, fails them explicitly,
or never resolves them. The published graph enters that read before Ready and
fails the no-old-RPC assertion. The corrected source performs two cold starts in
each mode, reaches Ready with zero old-turn calls and releases the original
queued input through its existing public action. The same client ID and image
attachment reach the ordinary new provider launch. This is isolated source
execution, not proof of application to a customer's installation.

The combined regression retains two blocked Streams in one Hub. Both original
queues and a following explicit message in each Stream reach the provider once
with their original IDs and images. A third cold start preserves both histories
and does not reintroduce old recovery calls, warnings or admission occupancy.

Local lifecycle tests separately verify retained records, no provider terminal,
legacy/Claude/observer/pre-ACK custody, exact reopen, changed identity refusal
and a new current writer. Existing startup and original-ID admission tracing
reports local disposition, startup readiness and new input without payloads.
Readiness timing excludes no hidden old recovery stage; module-loader overhead
in the parent counterfactual is reported separately from runtime stage timing.

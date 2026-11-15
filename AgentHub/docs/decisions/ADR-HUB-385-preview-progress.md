# HUB-385: retain completed preview intake across bounded passes

Actual native retirement preview took 13.171 seconds. With authenticated
readiness observations the existing 20-second admission budget could expire
before child creation, losing all preview work on every pass.

Persist an eligible exact preview on the existing unadmitted maintenance child
and bounded parent pending list before checking that admission budget. A later
pass may consume it only for the same runtime release/candidate/approval. The
existing artifact prune must still validate fresh source, binding and resource
leases; this checkpoint is not a replacement for deletion authority. Release
drift repeats preview on the same unadmitted child. Admitted UNKNOWN effects
continue only through their original owner's reconciliation.

No new ledger, discovery route, timer, deadline or deletion sink is added.
Existing records without this metadata take the ordinary preview path. Loss
between child creation and parent save is recovered by existing activeFor scope.
SQLite reopen, drift, original identity and expired-budget no-effect controls
exercise that boundary. Production savings remain separate physical evidence.

# ADR-HUB-392 — Recheck retained accepted Codex turns without replay

## Evidence and cause

An automatically admitted release event's accepted turn disconnected during
provider retries and survived restart with no rollout terminal. Its retained
provider projection was `inProgress`, while Hub correctly displayed UNKNOWN.
The old recovery route required `interrupted`/`aborted`; ordinary managed
UNKNOWN observation never re-entered recovery. Even an eligible recovery that
first saw unknown/live activity permanently cached its resolved false promise.
None of these observations proves the historical turn completed or failed.

## Decision

Keep the original command, run, provider Thread and turn. Extend only recovery
eligibility to `inProgress` with positive normalized Hub ownership and a retained
accepted/observed provider-start for that exact turn. A fresh idle Thread is
required before entering the existing cancellation owner outside the Thread
read lane. That owner still requires uncached provider/native inactivity,
definite rejection of the original exact interrupt, an exact snapshot, a second
fresh inactivity check and unchanged registry ownership. Only canonical durable
interrupted terminal settlement releases admission and wakes queued originals.

Use the existing managed observation cadence, not a new timer, provider prompt,
reconnect loop or state owner. Concurrent recovery shares one attempt. A settled
observation requests reconciliation only; it cannot enter the existing startup
lost-approval prompt-relaunch path. A settled
precheck with no interrupt effect can be evaluated again; definite interrupt
rejection permits the same guarded check after unavailable snapshot/storage.
Accepted or ambiguous interrupts remain fenced: their acknowledgement alone
never releases the original or authorizes another interrupt. A later exact
terminal is consumed by the existing observer/finalizer and remains absorbing.

Any live provider turn in the Thread, including a newer turn owned by another
client, or unavailable native evidence blocks automatic recovery. Retained
`inProgress` without exact acceptance/Hub ownership is not eligible. No elapsed
deadline, network error, empty response, service-event text or missing activity
establishes a terminal. No old prompt, release operation or user input is replayed.

Recovery activity-before, exact interrupt and activity-after use the existing
bounded best-effort command tracer with the original command/run/Thread/turn
identity. Started and completed spans distinguish a held read/effect from a
negative decision. They contain no message/attachment content or raw errors;
trace sink failures cannot change recovery authority. Existing terminal commit,
queue admission and client projection measurements retain their separate owners.

## Mailbox and operational boundary

Authenticated snapshot/history reads and the existing deferred-input cancel
action remain the supported operator path. Read/cancel is not provider Stop,
terminal confirmation or message delivery. Preserve any required attachment
copy before explicit cancellation; an in-flight cancellation refusal is real,
and retrying its command ID returns that same receipt. This change adds no inbox
API, no snapshot-cap increase and no deletion path. The running Thread is never
stopped to acknowledge messages. Actual original recovery and installed/served
verification belong to the runtime owner after reviewed delivery.

## Validation

Owning tests reproduce all three missing transitions against unchanged source,
then cover positive exact recovery, still-live/unknown/external/mismatched
identity refusal, ambiguous/accepted interrupt fences and persistence failure.
The cross-owner test reopens SQLite queue state, holds the actual terminal write,
and proves terminal-before-release and one original-ID dispatch with unchanged
input/annotation/attachment bytes. Recovery trace stages survive worker reopen.
Controlled ports are not a claim that a production interruption or speedup ran.

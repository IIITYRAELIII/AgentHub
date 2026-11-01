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
fresh inactivity check and unchanged registry ownership. This provider-settlement
path releases admission only after canonical durable interrupted terminal settlement.

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
client, or unavailable native evidence blocks automatic provider settlement. Retained
`inProgress` without exact acceptance/Hub ownership is not eligible. No elapsed
deadline, network error, empty response, service-event text or missing activity
establishes a terminal. No old prompt, release operation or user input is replayed.

Recovery activity-before, exact interrupt and activity-after use the existing
bounded best-effort command tracer with the original command/run/Thread/turn
identity. Started and completed spans distinguish a held read/effect from a
negative decision. They contain no message/attachment content or raw errors;
trace sink failures cannot change recovery authority. Existing terminal commit,
queue admission and client projection measurements retain their separate owners.

## Actual installed followthrough: avoid full-history gating

The installed observation path entered recovery but requested up to 200 full
turns while holding the existing hydration lane. Actual thread/turns/list reads
timed out before any inactivity checks; concurrent hydration was then refused.
The exact original's canonical acceptance and rollout snapshot do not require
that unrelated history. For this positive Hub-owned exact identity only, read
fresh Thread metadata and the existing exact rollout snapshot. An exact UNKNOWN
snapshot is eligibility, not terminal authority; retain all cancellation owner's
fresh inactivity, definite exact interrupt rejection, second-check, registry and
durable terminal fences. Legacy/unconfirmed/foreign/observer recovery retains
its existing history route. Never stop a newer live external turn in the Thread.

Record recovery-provider-read start/outcome through the existing bounded
best-effort command tracer, with original command/run/Thread/turn and a bounded
metadata-only flag. No content, timeout-to-terminal inference or new timer is
introduced. A trace sink failure must not alter the decision.

An actual deferred-input cancel can be refused while its controller is
processing even before provider dispatch. That refusal is not delivery or
permanent cancellation failure. Existing traces distinguish the retained
original's later queued/blocked state from dispatch. The existing cancel owner
remains authoritative; do not replay the refused command or bypass its fence.

## Explicit post-reboot local-execution disposition

RM decision arch-392-approve-canonical-local-retirement-preserving-providerunknown-20261101-v1
authorizes a narrow change to the former terminal-only LOCAL admission invariant.
Real reboot proves loss of the old local runtime, but does not prove provider
completion; a new desktop writer may legitimately be active in the same Thread.
Calling markCompleted or deleting a registry row would conflate those facts.

Use ManagedRunLifecycleService and its existing ProviderRunTerminalStore/mutation
owner. The latter stores an exact administrative local-retirement record, not a
provider terminal, final payload, outbox, second ledger service or reconciler.
Before any provider/history read, ordinary Codex recovery asks that lifecycle owner.
It requires an original restored from the canonical persisted runtime snapshot,
positive explicit normalized Hub ownership, exact canonical accepted providerStart,
matching command/run/Stream/Thread/turn and consistent captured admission/request/
acceptance timestamps before the existing trusted Win32 boot witness. Restoration
must be after that boot and every identity/current registry check repeats after
the asynchronous proof and disposition commit. A fresh locally created run has
no restored provenance. Legacy records missing the exact captured fields refuse;
no TaskGit guard, timeout, PID absence/reuse or external Thread activity repairs them.

Persist that disposition first. Then release only the old admission index while
keeping exact run/turn lookup and providerStart/providerUNKNOWN/raw history/
accepted inputs and annotations/attachments. Runtime snapshots retain these old
originals independently of active execution listing. Reopen reads the exact
lifecycle record before deciding whether that saved run owns admission; a lost
post-disposition snapshot write cannot revive it. An identity conflict fails
closed. No fake completion, command cancellation, Stop/interrupt or after-turn
maintenance occurs. A late real provider event still resolves its exact old run.

Concurrent attempts share one original; durable record replay is idempotent.
Same boot, missing/ambiguous provenance, foreign or changed identity, replacement
registry and failed write retain the fence. Successful release wakes the existing
queue owner, whose ordinary fresh external/current checks still block new
start/steer while a newer desktop writer is active or unknown. The existing
best-effort command tracer records bounded proof and persistence stages without
content, including failed writes and worker reopen. This is not a RAM/speed claim
or proof that the production ghost, queued message or old lifecycle operation
has been settled; actual delivery and original recovery remain RM-owned.

Late lifecycle callbacks remain separate from local retirement. Generic complete/
markCompleted without a matching durable provider terminal leaves the retained
UNKNOWN intact. The existing terminal store must confirm exact provider/Thread/
turn, original payload runId, supported status and committed revision after the
read, with unchanged registry/identity. A real late final can then finish its old
entity without reserving or cancelling post-turn maintenance for the current
writer, re-acquiring admission or repeating retirement wake. In-flight Promise
coordination never enters persisted run snapshots; restored inert flags cannot
become completion authority. No local-retirement record is provider-terminal proof.

## Mailbox and operational boundary (unchanged)

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

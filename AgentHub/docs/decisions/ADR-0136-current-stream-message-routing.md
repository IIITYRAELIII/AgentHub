# ADR-0136 — Ordinary messages address the current Stream

Date: 2026-10-23

## Decision and explicit policy change

The user's instruction is: «ты в какойто монент нахуято высрал привязку к
конкретному ходу или типа того. а сообщение просто должно лететь в ход, в любой
текущий. если хода нет, просто в очередь.. ну, как обычное сообщение».

This supersedes the policy that a Stream-bound ordinary steer must demand a
manual decision whenever its original Run/Turn ends. Ordinary composer send,
Enter, quote send and inter-Stream `mode=steer` address the destination Stream.
An explicit after-turn queue action retains its separate meaning. Direct exact
Run/Turn service operations keep their expected-target guards.

Current 2.1.0 compatibility retains the existing personal shortcut preference.
An explicitly saved queue action passes the existing `followUpMode=queue`
through the same composer submit owner. The already-owned `configured` marker
distinguishes that action from the unconfigured legacy Enter default, which now
uses ordinary current-Stream routing. No new preference, public flag or writer is
introduced. Button, ordinary Enter, quote and explicit steer still share the
current-or-queue route; an explicit saved queue does not become a steer.

## Owner and attempt boundary

The existing durable message command, DeferredInputController and RunCoordinator
remain the only intake, scheduling and provider-effect owners. Before dispatch,
the current catalog Thread binding is resolved for that same Stream. A suitable
active managed turn receives the message; without one the same command follows
normal FIFO launch and its existing activity, repository and maintenance fences.
Admission which already observes an idle Stream retains that routing policy,
so a new active turn winning before dispatch can still receive the message.

The 2026-10-31 production original exposed a deferred-only gap: its durable
commit preceded first recorded eligibility by 91.083 seconds while the same
active provider turn was internally compacting. The persisted automatic,
non-dedicated compaction completed 1.399 seconds before dispatch eligibility.
The deferred route incorrectly reused the general launch barrier; desktop
composition also omitted the existing managed-maintenance port. Both now retain
the existing distinction: exact active Hub-owned steer may cross provider-internal
compaction, while explicit Hub maintenance and actual stopping still block.
Missing/unbound/foreign active identity, idle launch and explicit queue receive
no relaxation. A provider refusal or unknown result keeps its existing normal
rejection/readback semantics. No new provider request, writer or retry owner is
introduced. Payload-free wake scheduled/fired records and the early barrier span
use the existing trace; monotonic timer lateness distinguishes callback delay
from guard execution. This correction is not a claim that production compaction
itself became faster or that a later production AFTER has already occurred.

An initially idle command retains `message-intake` and its existing submitted
`followUpMode=steer`; an active-turn command uses `message-steer`. This preserves
the ordinary idle conversation projection while retaining current-or-queue intent
through later occupancy changes.

`clientUserMessageId`, original intake/receipt identity, origin, payload,
attachments and queue order never change. A bounded `deliveryTarget` captures
the provider/Thread target of one attempt in the existing durable item. The
current Run/Turn supplies its API concurrency guard. There is no new table,
writer, retry service, alternate provider route or acceptance flag.

The existing ledger occupancy rekey also moves an exact binding when its stored
ordinary-message intent names the same Stream and item/client identity, its
captured next delivery target matches, and no acceptance, uncertain attempt,
terminal state or manual pause exists. It compares the prior occupancy key,
state and revision in the existing update. Serialized start and steer both bind
before the provider effect; canonical settlement, current catalog and pause are
checked after that awaited boundary. The intake receipt, fingerprint and FIFO
order stay unchanged. Legacy exact-target commands retain their one-time binding.
Ordinary commands not yet attempted compare FIFO against the current Thread,
including older commands admitted before a rebind. Active-turn delivery orders
ordinary messages without consuming an explicitly after-turn queue entry.

A definite stale-target rejection clears that attempt only after the ordinary
queued transition is durable. A rejected still-active Run/Turn is not repeatedly
steered: normal occupancy wake/backoff waits for a different active turn or idle
FIFO launch. The dispatcher never spins. The current binding is rechecked before
the provider call. A timeout, transport ambiguity or explicit unknown outcome
cannot be classified as a definitive stale-target refusal by its message text.

## Unknown, late receipt and recovery

An uncertain attempt keeps its exact captured target across reload, rotation
and restart and uses the existing provider/receipt readback. Absence or elapsed
time alone never permits another effect. The existing bounded foreground
reconciliation can become visible unknown; later ordinary wakes may read back
that same attempt without dispatching. Canonical accepted/cancelled receipts are
checked again inside serialized provider dispatch, and before/after managed
admission for a queued launch. A late accepted receipt retires the projection;
it cannot authorize a resend in a different turn.

Startup and normal wake may migrate an old held human message only when its
allowlisted error proves known non-delivery, it has no in-flight attempt,
belongs to the same Stream, and is not explicitly paused. Existing canonical
cancellation/expiry always wins. Legacy held inter-Stream/service instructions
are not revived automatically; their old intent can be stale. Their exact
accepted/cancelled receipts may still retire a ghost. Remove this compatibility
case when no pre-decision held entries remain; do not infer migration eligibility
from text, age or a missing active run.

A second legacy case lost `followUpMode` when an MCP steer was admitted while
idle, before a new managed turn appeared. Only an already queued, never-attempted
message-intake may restore that intent. The original succeeded MCP receipt must
bind the same request, caller origin, item/client ID and destination; authenticated
body/content hash and the complete canonical argument hash must prove exactly
`mode=steer`. Matching explicit queue, omitted mode, transformed/missing body,
unknown/foreign receipt or missing content evidence cannot grant this policy.
The existing controller persists only the recovered mode before the normal
current-or-queue path. It does not replay the MCP operation, revive held service
instructions or infer provider non-delivery from age. Remove this compatibility
case after queued pre-decision intake rows have drained.

Queue presentation uses actual state: queued intake is waiting, while only
dispatching/steering counts as starting. Public diagnostics fall back past empty
attempt timestamps to the original createdAt. Admission refusal records a bounded
wait reason through the same item/receipt owner, persisted when that reason changes.
Existing eligibility traces retain their monotonic span and add only blocked,
bounded reason and queue age; successful evaluation is not dispatch acceptance.
An unknown managed activity guard stays occupied; no timeout or UI label releases it.

The wait reason only overrides unresolved intake optimism. A matching canonical
provider-accepted or terminal receipt wins over a stale queued intake row before
history catches up, including receipt-first refresh and reload. Receipt lookup
rejects explicit provider, Thread or Stream conflicts while preserving legacy
omitted identity fields and the same client message ID. Existing manual-pause,
unknown and attention guards remain; this projection change never dispatches.

## Evidence and limits

Behavioral checks cover public Desktop intake, the common inter-Stream boundary,
real SQLite persistence/reopen, current/ended/rotated turns, definite rejection,
lost ACK, late receipt, pause/cancel and attachment identity. Shipped browser
checks cover actual Enter/button request generation. Provider ports in isolated
fixtures do not prove production provider behavior, installed source inclusion
or the identity/cause of a screenshot that has no message/Stream binding.

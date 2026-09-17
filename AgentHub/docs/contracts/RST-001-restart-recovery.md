# RST-001 — Restart and maintenance recovery

## Identity and owner

Restart and compaction are persisted operations with `operationId`, kind, exact
Stream and Thread, optional provider turn identity, status and revision. They are
not user turns.

The client may show an explicit compaction boundary with before/after context
as a system maintenance marker. Codex uses its preliminary provider estimate,
labelled as approximate; missing evidence remains unknown. Context maintenance
does not generate measurement turns, including after rotation. Former marker
text has no special classification or suppression rule.

Test Contour refresh is a separate persisted infrastructure operation governed
by REL-001 and ADR-0015. It binds contour root/marker/port and source/release
identity instead of Stream, Thread or provider turn identity. It is likewise not
a user turn and does not alter the restart/compaction operation schema.

A manual Test Contour test session is a foreground owner of the same canonical
per-root operation lease. It binds an exact already-ready contour identity, an
idempotent acquisition receipt and one exact active Agent Hub provider/thread/
turn. Normal release, handled helper cancellation and the turn's committed
provider-run terminal record leave through the lease owner, including completed,
failed and aborted Codex and Claude turns whose helper process remains alive.
The owning completion boundary writes this minimal record separately from
message delivery; Codex's existing committed terminal remains valid evidence.
Missing active-run state without exact terminal evidence is unknown and does
not release. Abrupt helper death is recovered only after
confirmed process death. Time or a missed heartbeat alone never releases a live
or identity-unknown session.
Provider recovery read, reconnect or reattach failure is likewise unknown: a
generic recovery exception and a local `interrupted` bookkeeping decision do
not create provider terminal evidence or release the manual session. Only the
provider/process completion owner may commit the exact terminal outcome.

## Invariants

- Timeout is ambiguous until reconciliation; it does not authorize duplicate
  non-idempotent starts.
- Publication readiness binds the expected current release to both the ready
  instance lock and the responding control snapshot's release and PID. A new
  endpoint serving an old release is not successful cutover. A publication may
  cold-start the verified installed launcher only after process absence is
  confirmed; a failed or timed-out restart RPC never authorizes that fallback.
- Compaction lifecycle writes and context-estimate classification/observation use
  the same Thread-scoped asynchronous mutation queue. Concurrent provider event
  handlers cannot deliver the estimate before its queued compaction boundary;
  boundary timestamps are captured at event admission, before persistence waits.
  SQLite contention retries only persistence under the same operation identity,
  never the provider RPC. Completion/failure cancels its watchdog only after the
  durable transition succeeds. A successful enclosing user turn cannot become
  evidence of compaction failure: its exact compaction item confirms success,
  while absent evidence remains unknown and accepts a later exact completion.
- Hub-requested dedicated compaction turns retain an explicit persisted marker.
  Terminal reconciliation accounts their usage without emitting a user response
  or changing the last message. Inline compaction inside an ordinary turn and
  legacy operations lacking that marker do not authorize suppressing its final.
- Ordinary and new-turn admission is blocked by an exact active maintenance
  operation. An explicit steer targeting an exact active managed turn may be
  admitted during provider-internal compaction, but its provider dispatch waits
  durably for that compaction to settle. Hub-owned compaction and rotation
  reservations remain admission barriers.
- A restart requested with no selected Stream and Thread is persisted under the
  explicit runtime scope; a target naming only one of them is rejected.
- Restart is a barrier over durable finals, command receipts, delivery outbox and
  maintenance reconciliation.
- Once a restart operation is persisted, new durable commands remain queued in
  their exact lanes. The old runtime cannot admit them after the run that the
  restart is draining reaches terminal state.
- A replacement runtime finalizes the persisted restart and marks its instance
  ready before it starts deferred-input timers. Queued commands are then
  admitted once under their original `clientUserMessageId`.
- When replacement fails and the previous runtime restores ownership and its
  services, recovery settles that exact persisted restart as failed before
  clearing its request and publishing readiness. The restored runtime marks
  itself ready before resuming timers. Deferred cutover uses the same settlement
  even when it did not run through the initial request scheduler.
- A runtime whose startup fails exits after best-effort shutdown even when
  partially created handles would keep the process alive, so a half-started
  process never keeps holding its instance lock. The previous runtime waits
  for the exact replacement identity captured at lock ownership: when that
  process exits before readiness the wait ends at once and recovery proceeds
  without the readiness timeout. A different or stale lock owner does not end
  that wait.
- In a recording Test Contour a persisted global selection that the canonical
  Thread binding rejects as a containing-project reference does not abort
  startup. Only that selected Thread is cleared with a warning; the project,
  canonical binding, history, queues and per-client selections stay unchanged,
  and the containing project still has no execution authority. Other mapping
  and startup failures remain fatal.
- Runtime startup wakes the queue owner, which reconciles recoverable persisted
  `task-running` and `activity-unknown` lane heads against current occupancy
  before FIFO dispatch. A stale external-observation reservation therefore
  cannot survive startup as authority after exact external-process absence is
  confirmed; unavailable process evidence remains unknown and blocks safely.
  Concurrent Thread checks share one bounded process snapshot per runtime
  cadence. Queue retries use capped exponential backoff with jitter; an exact
  completion or wake cancels that delay and rechecks the lane head immediately.
- Process death does not preserve local `running` as fact. Recovery reconciles
  provider state or records an honest terminal timeout/unknown result.
- Before provider discovery finishes, the initial catalog resolves retained
  Threads against existing visible Workspace/Stream bindings read-only. It does
  not expose an unbound historical Thread as a synthetic Stream. Discovery
  failure preserves unknown activity without promoting it to running; exact
  managed runs remain independently authoritative for activity and admission.
- Startup performs one bounded read-model reprojection for recent terminal
  turns whose retained payload identities are all confirmed by exact terminal
  command-ledger bindings. The reprojection is idempotent, preserves terminal
  state and never dispatches a provider effect; ambiguous evidence is skipped.
  Candidate discovery uses terminal-store-owned persisted payload-byte metadata
  and deterministic covering-index order; the read-model owner never scans or
  sorts terminal JSON to discover candidates.
- Restart UI appears only for a real persisted restart phase and cannot hide a
  final response.
  A disconnected health request alone never asserts a restart. While waiting
  for connection or replacement, the screen shows no stage progress inherited
  from the previous health sample and does not claim readiness. It shows the
  measured time since the wait began and says the previous process still
  answers only after a successful health response. A snapshot served after a
  failed restart carries its recent persisted reason, shown once per operation,
  until a later restart settles successfully; that reason is part of the
  snapshot source revision, so neither a failure, a later success nor the end
  of its notice window can be hidden by a cached unchanged snapshot. Known failed
  startup details remain available during ordinary connection loss. Fresh
  health and the canonical connection state remain the reconnect authority.
- The startup screen retains failed-stage details and exposes authenticated
  retry and restart actions. Retry is fenced by the exact runtime startup
  generation, coalesces concurrent requests, and runs only failed recoverable
  stages plus their skipped dependencies after initial startup settles.
  Completed stages and command dispatch are never replayed by a retry.
  An unavailable control plane requires the installed local launcher; a browser
  cannot start a process on an offline host.

## Isolated recording recovery

An explicitly prepared recording contour uses the same command, receipt, queue,
terminal and delivery identities as its captured cohort (ADR-0038). Its raw
capture is immutable evidence. Only declared operational paths are mapped into
owned directories; canonical journal text and command identities are not
rewritten. SQLite read pins plus unchanged sidecars establish the documented
capture window, not a cross-store business transaction.

Historical read models may retain a containing project directory different from
the exact Thread execution directory. Recording read projections preserve those
canonical fields and validate Thread/Stream membership; they do not grant command
authority. Admission still requires the exact captured execution binding.

The profile must verify cohort ownership and configuration before starting the
Hub. Providers are literal local recording adapters in isolated homes. Captured
external processes, rollout files, Git repositories and media jobs are not
execution authority. Excluded operations retain their evidence and explicitly
report exclusion; they must not report successful remote work. Recording
delivery receipts retain their original idempotency identity across restart.

Recovery checks must separately report queue/terminal/delivery behavior, source
immutability, exact replacement identity and excluded effects. Synthetic shell
recovery alone does not prove production-data parity or installed RuntimeHost
replacement. The legacy destructive clone path cannot refresh a prepared cohort.

Explicit adoption into the canonical Test Contour root retains the old data and
profile under the existing contour operation lease. Staging and exact candidate
preparation precede stop. The root identity and lock remain stable. Interrupted
component replacement recovers without deleting either cohort; an already-ready
exact candidate is finalized without discarding its writes. Unknown postlaunch
readiness fails closed and cannot authorize an automatic rollback.
Recovery may stop or roll back only the still-current adoption operation with
its exact root/contour target; a newer independent operation remains untouched.

## Optional startup enrichment

A ready replacement may resume the exact pending publication completion
described in REL-001. This background continuation starts after readiness and
uses the canonical publication lock, without inheriting the previous publisher's
lock-bypass session. It does not build, deploy, push Git or request another
restart. Installed release, ready instance and control snapshot must agree
before completion; a mismatch remains pending/failed evidence, never success.
An explicit `awaiting_finalization` result schedules the same background owner
again after a bounded delay and within one bounded attempt budget. Canonical
completion or budget exhaustion with an explicit diagnostic stops that cycle.
Duplicate readiness notifications do not create another owner or repeat
completed publication stages.
The publication journal and Task finalization store retain their own existing
authority; this hook creates no second restart operation.

Full provider catalog/pricing enrichment is background work after the mandatory
startup and readiness barrier. It is measured and retryable, but does not reopen
the startup barrier or hide the ready interface. Recovery of active ownership,
durable terminals and the persisted restart remains mandatory before dispatch.
Background enrichment reuses one existing owner, yields between bounded units,
and stops admitting more units during shutdown. See ADR-0030.

## Squash-transfer recovery

An exact squash transfer is a versioned workflow transition reserving the
survivor and source Task together. Restart/unknown reconciliation acquires both
Task recovery locks and the existing repository lock. It accepts only the
persisted transfer hash and exact `(old dev, new result, accepted tree)`
integration. If dev is still exactly old dev, it may resume that same transfer;
if the exact integration is present it first proves or completes its
non-destructive managed worktree/index materialization, then commits the pending
two-row outcome. Ref-only application, local tracked/untracked bytes or any other
dev head remain unknown without deleting those bytes. A normally completed Git
command creates no process guard, so this exact squash recovery does not require
a fictitious guard ID. A real unresolved guard remains fail-closed until its
existing exact recovery proof succeeds. Generic recovery/read errors do not
create transfer or terminal evidence. All cutpoints converge on the existing
lifecycle outcome; there is no second recovery registry.
The hash distinguishes the previous accepted survivor result from the reviewed
clean-before commit, so recovery cannot widen the owner delta or remove foreign
dev residue after a restart.

The local Progress-to-Test squash bootstrap persists its cutover proof in that
same transition. Recovery recognizes exact pre-stage, fully staged-before-ref,
survivor-ref-applied, dev-CAS and pending-materialization states. The reviewed
commit is already present from preview, and the immutable preserved ref proves
the approved pre-cutover tracked/untracked tree. Recovery may advance only the
next exact CAS or materialization step; a partial or changed worktree, late
ordinary bytes, changed main/dev, missing preserved evidence or mixed cutover
hash remains unknown without cleanup. The final SQLite commit still waits for
the ordinary squash Git proof and records both hashes in the existing lifecycle
outcome. No bootstrap-specific registry or direct database/ref recovery path is
introduced.

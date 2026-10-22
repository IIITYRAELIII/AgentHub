# RST-001 — Restart and maintenance recovery

Installed sync-endpoint migration (ADR-0329) belongs to the existing runtime
installation owner before stable-file/pointer publication. It does not launch
or restart Hub, enroll a device or write journal/credential/cursor files. A
retained new config key is backward-compatible with the old runtime after a
failed cutover; retry must preserve it. Original release identities and unknown
effects remain under their original owners.

## Background storage policy (ADR-0126)

Normal installed startup schedules versioned storage maintenance after actual
ready, then periodically; update installation itself does not launch the runtime.
Test/recording/acceptance isolation and development do not construct production
cleanup owners. Active user work defers admission. Storage maintenance reuses the
existing maintenance-operation store in its own runtime scope; it is neither a
user turn, a dispatch reservation nor a restart UI marker.

Bounded owner discovery and previews precede durable artifact admission. A lost
reply remains with the SAME original child and is reconciled, never replayed as a
new delete. Unknown resources do not starve every other owner. Shutdown stops new
admission and drains the actual effect before closing stores or releasing the
instance lock; a timeout does not prove the child stopped. Policy v1 owns
redundant completed/published native merge transports. Policy v2 adds only
explicitly retired runtime bodies with exact current-pointer custody, fresh
current/rollback/running/prepared/source pins and original child identity. The
reviewed owner-list append preserves v1 pending intents. Partial batches remain
attached to the same admitted child; unknown outcomes are not replayed as new
deletion. An older or unknown registry/version defers without clearing state.
Policy v3 appends only redundant release-generation bundle transports after the
original release owner proves its exact current generation completed, all approved
publication targets applied and hash-bound validation/finalization receipts applied.
The release filesystem owner rechecks original capture/clone/object connectivity
under its existing per-generation lease and native single-file deletion custody.
Known v1/v2 registries preserve pending children when appending this owner; unknown
registries and rollback remain fail-closed. No replay/publication/Task transition,
recursive generation deletion or age-based legacy adoption follows from this policy.
Other persistent artifacts
remain under their existing cleanup contracts and are preserved until those
owners supply their own verified eligibility/effect adapters.

Catalog reads during startup must not indirectly launch optional historical
pricing backfill. Its existing post-readiness coordinator remains the owner;
mandatory terminal projection recovery and its durable ACK fences still finish
before readiness, with the existing replacement deadline unchanged.

## Identity and owner

At actual cutover the existing transfer service fences new background preparation
and GC, stops its timer and drains already admitted filesystem work before the
instance lock can be released. Its SQLite remains open until successful replacement
finalization. Failed-cutover recovery resumes that same service and its original
GC cadence; it does not recreate requests or close/reopen the store. A pending
restart alone does not invoke this fence or block ordinary user communication.

Restart and compaction are persisted operations with `operationId`, kind, exact
Stream and Thread, optional provider turn identity, status and revision. They are
not user turns.

The client may show an explicit compaction boundary with before/after context
as a system maintenance marker. Codex uses its preliminary provider estimate,
labelled as approximate; missing evidence remains unknown. Context maintenance
does not generate measurement turns, including after rotation. Former marker
text has no special classification or suppression rule. The retired generated
probe `client_id` remains an exact historical identity guard (ADR-0073).

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
The narrowly scoped ADR-0125 recovery interruption uses that same cancellation
and terminal owner after fresh provider/native inactivity and exact interrupt
rejection; a startup/read exception or idle status alone still cannot release.

## Invariants

- File transfer shutdown fences new preparation/GC admission and drains the
  admitted intake, background copy and complete GC filesystem/SQLite settlement
  before closing its store. A completed close cannot reopen SQLite through a
  delayed collection. Explicit GC failures retain their own outcome.
- A preserved direct gateway with changed generated configuration is handed off
  by its existing controller only after the former parent process is absent.
  Exact executable, command line, PID/creation identity and unchanged regular
  executable/config bytes are required before terminating that managed gateway;
  the same open process handle fences PID reuse. A live or unknown parent and
  any identity/file drift refuse the effect. No competing listener is launched.
  Gateway shutdown also drains a pending observation/handoff before returning.

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
- Ordinary and new-turn admission is blocked by an exact active Stream context-maintenance
  operation. An explicit steer targeting an exact active managed turn may be
  admitted during provider-internal compaction, but its provider dispatch waits
  durably for that compaction to settle. Hub-owned compaction and rotation
  reservations remain admission barriers.
- A restart requested with no selected Stream and Thread is persisted under the
  explicit runtime scope; a target naming only one of them is rejected.
- Restart waits for durable finals, command receipts, delivery outbox and
  maintenance reconciliation. A pending/scheduled request does not block intake,
  ordinary starts, steering or queued dispatch, and never causes automatic Stop
  or pause. User Stop/pause retains its authority (ADR-0127).
- One durable restart launches one owned RuntimeHost tree. Windows restart never
  submits an escaping WMI start, retries an ownership timeout or adds a fallback
  launch. The controlled path uses a direct detached host and retains exact
  cleanup ownership until lock/ready proof. Cold `--spawn-independent` uses
  synchronous native process creation with explicit job breakaway; denied
  breakaway fails visibly, with no WMI fallback or delayed launch. Cold start
  cannot carry a managed restart operation identity.
  The expected release is persisted before launch; exact operation/release/PID/
  instance evidence fences readiness. The old owner recovers only after confirmed
  cleanup of its owned replacement. See ADR-0114.
- Only the synchronous transition into actual stopping closes provider admission.
  Its readiness check includes existing pending admission/steer ownership, active
  blocking runs, background jobs and maintenance, with no asynchronous gap before
  the stopping fence. An admission already underway protects its run through
  registration/launch; a later input remains durable in its exact lane and original
  identity without a provider-start claim. Every real input/queued dispatch factory
  receives that stopping fence. Ordinary terminal completion still wakes the queue
  while a restart is pending; the restart rechecks safety rather than starving it.
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
- Retained uncertain run ownership is projected as unknown while preserving the
  exact Stop target and replay fence. Only an exact fresh active snapshot clears
  that uncertainty; no terminal is manufactured from reconnect failure.
- Process death does not preserve local `running` as fact. Recovery reconciles
  provider state or records an honest terminal timeout/unknown result.
- An exact Codex turn whose rollout has only `task_started` remains unknown
  across reconnect and restart, even after the promptless grace period or an
  App Server `interrupted` projection. The original run and queue lane remain
  owned; no terminal, interruption or new provider effect is fabricated.
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
- Startup also drains the existing durable terminal projection outbox before
  readiness whether Telegram is enabled or disabled. Only that startup barrier
  may return abandoned `projecting` rows to their exact pending identities;
  same-runtime periodic recovery claims pending rows only and cannot steal an
  active projection. The projection drain has no provider, command or Telegram
  side effects and is disposed with the runtime timers.
- Restart UI appears only for a real persisted restart phase and cannot hide a
  final response.
  A disconnected health request alone never asserts a restart. While waiting
  for connection or replacement, the screen shows no stage progress inherited
  from the previous health sample and does not claim readiness. It shows the
  measured time since the wait began and says the previous process still
  answers only after a successful health response. A snapshot served after a
  failed restart carries its recent persisted reason, shown once per operation,
  until a later restart settles successfully; elapsed time is not delivery and
  cannot expire this terminal reason. It is part of the snapshot source revision,
  so neither a failure nor a later success can be hidden by an unchanged cache. Known failed
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

The literal Codex recording adapter recovers a turn from its own isolated
SQLite command and turn rows. A read-only projection checks the seeded Thread,
exact command fingerprint and mapped execution identity before supplying that
turn to the ordinary snapshot and terminal owner. This profile never consumes
captured production rollout status. Outside the explicit recording profile,
Codex recovery still requires the exact native rollout terminal event.

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

The frontend startup overlay follows authoritative health readiness. A ready
runtime with a failed optional capability remains usable and exposes that
failure separately with the existing targeted retry. Failed or delayed health
reads do not turn an already-ready runtime into an asserted startup/restart;
connection diagnostics remain owned by the ordinary banner. A fresh unready
health response still blocks, including before startup stages are available.
Queued restart intent is waiting, not evidence that replacement started.
Telegram transport failures retain bounded allowlisted cause codes in their
existing error/health diagnostic; messages, credential-bearing URLs, tokens and
request bodies never contribute to that summary. An old generic fetch failure
without retained cause codes cannot be retrospectively diagnosed by a later
successful request.

A preserved direct gateway awaiting the existing owner's verified configuration
handoff may report `DIRECT_GATEWAY_CONFIG_HANDOFF_REQUIRED`. This exact refusal
does not prevent independently configured Worker or quick-tunnel startup. The
existing Mini App lifecycle starts those services once in the same generation;
only their actual publication callbacks may select a fallback menu URL. Other
gateway failures keep their existing failure behavior. The original handoff
error still rejects the cached transport-startup promise after independent work,
so main readiness or Worker availability never becomes full gateway readiness.
Gateway health recovery does not replay Worker startup or settle that promise.
Shutdown/generation changes fence late publication and menu callbacks. No new
retry loop, gateway writer, process authority or restart is introduced.

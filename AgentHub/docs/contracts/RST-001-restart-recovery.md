# RST-001 — Restart and maintenance recovery

## Explicit package next attempt (ADR-HUB-398)

Package preparation and the actual controller preflight apply the existing
installer version/build eligibility to the inspected, digest-bound public
manifest and exact current manifest before stopping. The installer keeps its
own stopped checks; early acceptance does not permit a downgrade or cutover.

After a positively joined nonzero installer exit, the same native owner may
restore only the unchanged admitted current: physical roots, current pointer,
manifest bytes, complete payload, stable Host and native retirement must still
verify. It persists one recovery launch intent and uses the existing one-use
Host admission and exact original/release/PID Ready proof. The update settles
FAILED, retaining installer error, backup, native and attempt history even when
the previous runtime is Ready again. No install or launch is replayed. Signal,
timeout, lost reply, changed/partial current or unknown ownership remains
reconciling; this is not permission to roll back or reset an original.

A definitively failed package original remains readback-only under ordinary
intake/bootstrap and generic terminal transitions. Only an explicit existing
maintenance-owner `resume-package` may admit its next attempt: exact immutable
business input, failed revision/binding, fresh current release/PID/pointer/
manifest/instance, identical public assets/selection and physical roots are
required. Positive controller-owned pre-stopping backup-preflight failure
evidence, or the bounded protocol-v1 revision proof below, is required;
historical error text or absent effects is insufficient.
UNKNOWN, prior native/backup/launch admission, an undrained old invocation,
stopping and a competing active restart refuse. No old receipt is rewritten.

Every prior failed attempt/result/binding is retained in the same original's
history. A fresh attempt still uses ordinary work waiting, stopping, native
retirement, strict stopped backup, installer and one-launch/Ready guards.
The retained exact continuation request is idempotent before preparation and
after process reopen; a lost response never grants a second install/spawn.
Changed input/CAS/current/assets/ownership refuses. No new update identity,
terminal reset, effect replay, separate ledger or inferred pre-stop authority.

Protocol-v1 compatibility admits only a first untyped failed terminal at revision
2, with schema1 exact package binding and no earlier attempt/recovery/history or
native/bootstrap/backup/launch admission. Creation is revision1; every native
package dispatch first awaits a committed nonterminal package intent, and a later
failure consumes another revision. This positive topology cannot describe a
failed revision2 after such dispatch. It establishes eligibility before package
intent, never retroactive global NO_EFFECT or a fabricated typed pre-stop proof.
Unknown schema, later revisions or partial/UNKNOWN outcomes retain readback-only
history. The complete old row and its binding are copied unchanged to attempt
history; new recovery metadata records the distinct compatibility authority.
Remove this compatibility route once untyped first-attempt records have received
their addressed disposition. It has no automatic scheduling or adoption path.

All production entry points, including direct Telegram polling, consult the
actual controller's in-flight join before continuation preparation and again
at the existing mutation/CAS boundary. Recovery must finish before that join
clears. Readback of an already admitted identical request stays idempotent.

An isolated whole-update check uses actual application and native owners with
separate data, secrets, IPC, ports, current/releases and owned processes. A
hash-bound root-contained acceptance import may control only external peers
and deterministic I/O scheduling. Ordinary production and recording startup
do not inherit that import or ambient NODE_OPTIONS. Local transport and fake
external providers do not establish public TLS or account acceptance.

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
public source-free manifest is a valid installed pin only when its complete raw
manifest hash and physical release-root binding match the installer's existing
current/rollback custody. Explicit invalid sourceRoot values, changed bindings
and unselected/prepared source-free bodies remain unknown and block retirement.
No whole-body rehash is added before each batch; installed custody, bounded
manifest reads and the existing native per-batch content guards remain owners.
See ADR-HUB-363-source-free-runtime-pins. The reviewed owner-list append
preserves v1 pending intents. Partial batches remain
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

An allocation evidence read may open the existing maintenance store read-only,
without schema initialization, migration or a writer reservation. It verifies
the original admitted partial retirement, but cannot settle, replay or continue
it. Its existing resource owner and scheduler retain all effect authority; see
ADR-HUB-363-partial-retirement-allocation and REL-001.

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
ADR-HUB-392 extends its eligibility to an exact retained `inProgress` original
only when its accepted/observed provider-start and positive Hub ownership agree.
Ordinary UNKNOWN observation retries that owner's prechecks without a new timer;
live/unknown evidence does not permanently suppress a later authoritative check.
An accepted or uncertain interrupt is not repeated, and no ACK releases admission.
A live external/current turn in the same Thread still blocks recovery.

## Invariants

- Runtime packaging includes each declared non-JavaScript companion whenever its
  owning module is included. The Codex executable custody module requires its C#
  companion in the same installed directory and exact runtime manifest. A missing
  required companion refuses preparation before current-pointer publication;
  older sources without the owning module do not require it. This does not grant
  authority to rewrite an already installed immutable runtime manifest.

- Native candidate membership and immutable module reads include the same six
  declared release-progress viewer assets as runtime preparation. Their shared
  declaration includes the identity, reader and server modules; unrelated files
  in that directory cannot satisfy a shipped import or enter the package.

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
- Admission that would launch a new turn is blocked by an exact active Stream
  context-maintenance operation. An ordinary Stream-addressed steer with an
  exact active Hub-owned turn may be admitted and dispatched during that turn's
  provider-internal compaction, without waiting for compaction to settle.
  Its expected-turn guard and unknown-acceptance readback remain unchanged.
  Hub-managed compaction and rotation reservations and actual runtime stopping
  remain admission barriers. Idle, missing/unbound or foreign turn identity,
  explicit after-turn queue and direct exact-target service operations do not
  gain this ordinary-steer exception (MSG-001, ADR-0136).
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
  synchronous native process creation with the pinned actual desktop shell as
  explicit parent. A suspended child must be outside every Job, have that exact
  parent and the same effective security context before Resume. Missing or
  changed shell/token/job proof fails visibly, with no flags-only or WMI fallback
  or delayed launch. This observation does not prohibit later foreign Job
  assignment. Cold start
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

## Fixed Windows lock-publication capability

Event-loop quiescence (`beforeExit`) is not terminal process shutdown. A source
consumer remains usable when a caller schedules more work after idle. Explicit
shutdown still permanently fences that instance and joins admitted native work;
it never resurrects a closed consumer or retries publication. Actual process
exit may synchronously retire only an idle exact-identity owned bootstrap body.
An active unresolved call or changed/replaced root retains its bootstrap body.
Unknown canonical lock effects remain with the existing interprocess owner;
bootstrap cleanup never removes those ready/canonical lock bytes or grants retry.
The exit hook performs no asynchronous launch, global scavenging or foreign cleanup.

The existing RuntimeHost has one fixed directory-publication mode. Its paths are
stdin data and its no-replace operation cannot enter Hub startup, lifetime logs,
restart, acceptance, provider or publication workflows. Source execution prepares
its hash-bound native consumer through the existing builder before lock admission,
without requiring that lock or an already installed Host. The same four declared
Host source inputs are retained by the ordinary runtime producer and source
membership selector. Prepared consumers verify their complete manifest, own Host
and source/binary hashes; missing or changed inputs refuse without compilation
or installed-launcher fallback. Source bootstrap coalesces only within its
process. Normal shutdown fences calls, joins native work and retires only its
exact owned temporary body; forced termination may retain an orphan, with no
global cache or scavenger. This capability does not itself recover an unknown
lock or start any runtime.

## Exact public-package restart (ADR-HUB-376)

### Update backup retention (ADR-HUB-383)

The existing after-ready StorageRetentionService automatically converges to at
most five confirmed update backups across their original scratch roots. Discovery
uses bounded read-only pages of canonical restart originals, never a disk scan.
Only exact packageHandoff binding and packageBackup inventory authorize a copy;
update originals themselves remain immutable. Failed, active, UNKNOWN, missing,
changed, linked or otherwise unproven copies retain their recovery evidence.
Protected copies consume the five slots; if they prevent convergence, cached
health reports the actual known count, protected/unverified count and limitMet=false.
Unregistered legacy/offline directories are outside this inventory and never adopted.

New successful backup checkpoints also bind generated copied-database WAL/SHM
files for retention; this is not raw copying of the source WAL. Historical
inventories acquire no new files or digest. Whole file/hash and directory equality
is required before admission, including rejection of extra empty directories.
Only the admitted backup tree may be traversed. Runtime data, WIP, packages,
source checkouts and sibling scratch files are never cleanup candidates.

Policy v4 adds the update-backup owner first while preserving the exact prior
v1/v2/v3 owner identities and pending children. Existing readiness, busy, stopping,
lease, timer and cooperative batch limits remain. One canonical retention child
stores proof, cursor and per-entry intent before each native handle-bound delete.
Ancestor identities are checked separately from that final-entry primitive.
Unknown deletion is never repeated: same-child absence readback under unchanged
parents may advance; an existing/replaced entry remains UNKNOWN. Partial batches
continue only their not-yet-admitted entries. Errors never imply a successful cap,
and neither ancestry checks nor hashing claim an atomic filesystem snapshot.


`restart-package` is an authenticated local action on the existing restart
request service and maintenance-operation original. Exact tag, canonical
publisher asset URLs/digests/lengths, whole runtime manifest, source/version,
physical runtime/data roots and current old instance are captured before actual
stopping. A pending request keeps ordinary work/admission running. Only the
existing synchronous stopping fence admits the capable-runtime cutover.

DesktopControl passes the exact package business input to that owner: original
`operationId`, `tag`, `archive`, `descriptor` and `installer`. The router does not
inject response-budget or snapshot fields into this action. It does not strip
caller-supplied extra fields either: the same strict package-input owner rejects
every unknown key. Authentication, local privilege, command fingerprint/replay,
package preparation, persistence-before-scheduling and active-work/stopping
fences retain their existing owners. Other actions keep their response policies.
The package command fingerprint includes every supplied field; the ordinary
tracing-field exemption cannot turn a changed package request into cached success.
A historical failed or UNKNOWN receipt is not retried or rewritten by this
correction; retained originals still require supported canonical disposition.
See ADR-HUB-396-desktop-package-input.

Package-only closure drains and closes normally preserved resources and
finalizes all writer stores BEFORE instance release. A native continuation
holds original process/Job handles and the root gate; old lock release alone is
never retirement. After original exits, owned Process references are disposed
before observing same-Job ActiveProcesses zero. Every backup/install/launch
boundary obtains a fresh reply from that holding native parent. Unknown,
foreign or changed evidence refuses without killing or replaying work.

Recipient transport recovery (ADR-HUB-387) is strictly before lifecycle dispatch.
A new exact physical/original/public-asset-bound preparation may continue only
on explicit repetition, with fresh authoritative canonical-row absence and no
saved request/dispatch intent. Partial historical/unbound transport is never
adopted. An exclusive flushed dispatch fence precedes the native subprocess;
absent SQL after that fence is UNKNOWN, not permission to spawn again. Preparation
is not a second restart ledger and does not relax modern lost-response refusal,
legacy manual stop, original Job proof or any stopped-data/launch boundary.

Backup uses the single `runtime-durable-state-v1` scope policy (ADR-HUB-380):
config and all top-level regular data files, plus recursive durable outboxes,
background jobs, failed updates, Claude run state, locks, diff indexes and custody
metadata. Custody epoch intent/snapshot must be regular nonlinked files, never
same-named directories; they and other scalar metadata are copied.
`repository` and `retained-wip` remain in place. Every direct ordinary directory
outside that durable scope is explicitly recorded as retained, not backed up,
with its physical identity. Known Git/WIP/dependency/payload trees are not traversed;
unclassified directories are labelled `unclassified-not-backed-up`, never claimed
as a complete backup. The unchanged installer does not modify those data trees.
Selected links/special entries and linked retained roots refuse; links inside
untraversed retained bodies neither grant authority nor enter the snapshot.
Read-only support inspection precedes modern/legacy admission and is repeated
before the modern synchronous stopping fence; work admission is rechecked after
that inspection. A fresh stopped inventory supplies backup, never the old preflight.
Live support inspection may exclude only exact ephemeral directories observed
from this process's existing interprocess lock producer. Physical identity and
confirmed same-producer publication/removal, not a filename or generic ENOENT,
authorize exclusion. Replaced, foreign/unobserved and durable entries still refuse
drift. This read-only call-scoped observation does not acquire a lock or mutate
state. Stopped inventory never consumes it and retains strict equality. See
ADR-HUB-398-live-backup-lock-observation. Ordinary intake/bootstrap keeps terminal
failed originals readback-only. Only the explicit next-attempt boundary above
can admit a fresh attempt; historical failed rows remain unchanged in history.
An awaited producer transition requires a fresh path read before excluding
confirmed absence; a replacement cannot inherit its predecessor's removal proof.
Observation promise rejection stays joined to the existing release error owner;
an I/O failure is neither confirmed removal nor an uncaught bookkeeping failure.
SQLite headers discover databases throughout the selected scope regardless of
filename suffix. All discovered writer reservations are held together through
SQLite backup/integrity and regular-file before/after hashes. WAL/SHM companions
are omitted only with their discovered database; orphan companions refuse.
Ephemeral bot.lock is not copied. Original config, auth, cursors and UNKNOWN outcomes remain in place;
backup never restores or replays them. The stopped-only installer retains its
own guards. A durable one-use launch intent binds the replacement Host, original,
release, instance and control readiness. Ambiguous install/start is reconciling,
not permission for another launch or automatic rollback. A cold launch cannot
consume an unresolved original; read-only `--check` cannot consume its admission.
An exclusive backup destination outside the runtime may be on another Windows
volume; normal TEMP and runtime roots need not share a drive. Same-root and child
destinations still refuse, and existing output is never overwritten.

The incoming public package provides the legacy entry when installed public
2.0.4 lacks this protocol. The user explicitly finishes work and manually stops
the reported exact old cohort AFTER arming from outside its Job. This is a
one-time manual maintenance window, not an old graceful port or an automatic
forced kill. Old admission cannot be fenced by new source: no new work/starts
may be introduced during that window. Manual termination may be crash-consistent;
the native old-Job zero proof and existing foreign process/SQLite checks are
still required. A lost modern request never falls back to legacy stop. Remove
this compatibility branch when non-protocol public versions cease to be
supported update sources. Runtime-root/data layout and an interactive same-user
security context are explicit v1 bounds; other layouts/authority refuse.

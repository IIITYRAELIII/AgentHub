# MCP-001 — Bounded Agent Hub tool bridge

RM-only `hub_task_complete` supports explicit `manual_delivery` with exact
revision/release/manifest hash and the configured installation root. Existing
authenticated mutation, original receipt, preview token and Task CAS remain
owners. It closes a verified Done card while preserving its artifacts; WIP
cleanup and publication history remain separate (ADR-HUB-466).
Exact `retained_repositories` pins preserve unrepresented historical worktrees
without claiming them delivered. RM Done may accept the same `manual_delivery`
proof plus exact Task/status CAS for owned source without a Test reference.
The original Test history is unchanged. `manual_preview_arguments` on existing
reconciliation binds the exact old read-only manual Complete preview hash;
only that form may be classified without a lifecycle mutation. A confirmed
Complete cannot use preview classification or an absence-only inference.

Release-only tools and their HTTP/CLI adapters are removed by ADR-HUB-463.
No `hub_release_*` request is admitted. Historical receipts are preserved; no
release worker resumes them. The Task and generic original-receipt invariants
below remain applicable. See REL-001 for the retained Task-only integration.

## Bounded Task intake before a durable receipt

Task submission retains the existing catalog queue and its unchanged contention
bound. Only an actual SQLite contention failure at `beginMcpOperation`'s initial
`BEGIN IMMEDIATE`, before this invocation enters its transaction, can produce a
typed `admission.status=not_admitted` response. It has `taskOperation=null`,
`result=null`, `scope=this_invocation`, `canonicalOutcome=null` and exact
request/tool/arguments/caller identity. The authenticated submission owner first
checks for an existing receipt; that receipt and its ordinary authority/hash
checks always take precedence. Transaction-body, commit, reply or business
failures cannot receive this classification. This response is not a persisted
FAILED/UNKNOWN/NO_EFFECT receipt and grants no historical no-effect or replay
authority. No delayed automatic admission is scheduled after refusal.

An authenticated exact receipt point-read with no row returns
`lookup.status=not_found`, `taskOperation=null`, `canonicalOutcome=null`. This is
only a current lookup observation, not proof of historical non-admission, empty
effects or permission to replay. Existing rows retain all actor/Task/hash guards,
including UNKNOWN and cancellation state. SQLite read failures still propagate.
The existing in-transaction declared-successor namespace and interruption guards
are never bypassed by an early successful admission path. Explicit later intake
keeps the same original request and immutable arguments and rechecks current
Task CAS; no second ledger, timeout increase, reconciliation route or retry
identity is introduced. Desktop/UI callers distinguish these results from a
completed Task and never resubmit mutations merely because readback is missing.
See ADR-HUB-407.

## Workflow enum validation and original settlement

The MCP status owner validates the workflow enum synchronously before calling
the lifecycle owner. Its private input error terminalizes the existing admitted
receipt as failed; identical replay returns that failure without dispatch.
A downstream error with similar text/name remains potentially partial/unknown.

The existing RM reconciliation owner has a finite protocol-v1 compatibility
boundary for an ordinary malformed status original: exactly request/Task/status
and both original CAS fields, with an invalid nonempty enum and no special
cutover, selected, squash or review arguments. The stored execution binding and
arguments hash, original actor, configured root and unchanged Task CAS must all
match. Missing transition/outcome rows are necessary but never sufficient.
Under existing Task/repository/Await leases the owner also requires no process
guard and either a joined local execution or the existing trusted exact native
retirement witness for a previous runtime. It never stops a worker itself.

The existing receipt failure transaction rechecks exact identity, Task CAS and
lifecycle absence before settlement. This records workflow_input_validation,
preserves original arguments/execution binding and previous diagnostic, and
creates no lifecycle outcome, cancellation, global NO_EFFECT proof or replay
permission. Changed/missing/foreign/undrained evidence stays unknown. Receipt
persistence failure stays ambiguous. Remove this historical branch only after
all addressed protocol-v1 malformed originals are terminal and migrated.
The existing local operation-reconcile CLI accepts --reconcile-arguments for
the same authenticated RM tool; it grants no separate writer authority.
See ADR-HUB-408-malformed-workflow-status.md.

The existing retained native witness may read a primary lock while the instance
keeps its write handle. This observer has read access only and permits existing
read/write/delete sharing; it does not unlock or replace the owner's file. The
bounded complete hash and stable volume/file/creation/size/write identity must
match the original snapshot, with same-handle and fresh named-path checks and
no reparse following. Drift, oversized or nonregular input refuses before the
witness manifest is published; every read handle closes. Existing exact native
Host/Node/job continuity, current-user pipe, nonce and source hash checks remain.

`hub_stream_message_send` with ordinary `mode=steer` addresses the destination
Stream. The common durable message owner resolves its current active managed
turn or retains that same command in the normal queue. A definitively ended
attempt does not require a manual retry/after-turn decision. Unknown provider
acceptance still reconciles the original attempt before any resend; accepted
messages are never repeated. Explicit `mode=queue`, immutable request/origin/body
binding and direct exact-target service guards retain their contracts. See
MSG-001 and ADR-0136. This changes routing policy, not MCP mutation ownership.

## Explicit Task operation interruption

`hub_task_operation_cancel` is an explicit audited mutation of future execution,
not reconciliation of past effects. Exact original ID/hash/Task arguments and
current Task CAS are required. The original Stream, a genuine RM, or the
authenticated desktop user uses the same existing receipt owner. Caller scope
and target Task scope remain distinct. Cancellation commands retain their own
receipt; current original execution disposition is read independently.

An exact repeated UNKNOWN `hub_task_operation_cancel` may re-enter only its
existing interruption owner through normal public admission when that same
service has no active worker for the cancel ID. Workspace/Stream/provider/audit
Thread/actor kind, tool and canonical argument hash must still match the original
cancel receipt. The owner rechecks original Task identity/CAS, execution fence,
retirement evidence and recovery lease before any effect. A live same-ID worker
is only read; all other UNKNOWN submissions remain read-only. This continues the
cancel command, never the interrupted claim/Test/Await. Requested is not stopped;
past effects and the interrupted UNKNOWN remain retained. No new ID, direct
internal invocation or timeout-derived no-effect authority is introduced.

The existing MCP ledger retains the exact original receipt snapshot, result,
error and timestamps with separate requested/stopped execution metadata.
UNKNOWN stays UNKNOWN; a known pending execution becomes failed execution only
after stopped, with prior effects still unknown. Requested is not stopped. A new
worker must join and release its exact child/lease before stopped is sealed;
late queued callbacks cannot write. A legacy UNKNOWN requires positive retirement
of its whole prior runtime cohort through the existing native witness owner.
PID absence, error text and elapsed time do not suffice. No original claim/Git
replay, dirty-source removal or NO_EFFECT inference is authorized.

For an exact UNKNOWN/STOPPED workflow with a failed lifecycle transition, the
existing RM reconciliation owner reports a read-only stopped disposition under
the existing Task/repository/Await leases and process guard. It rechecks original
arguments/CAS/root, the whole retained receipt snapshot and bound stopped
retirement metadata. The original receipt, error, result, timestamps and stop
history remain immutable; failed lifecycle does not make its effects known.
The separate reconciliation command can succeed with outcome stopped and
effects retained_unknown. A later explicit workflow uses normal fresh guards;
neither this response nor replay executes the stopped original again.

The existing operation-reconcile CLI exposes the same cancel command via
`--cancel-arguments <json>` with local provider/thread/Stream identity. A first
request waiting for legacy retirement is not silently restarted or published.
See [Task operation interruption](../decisions/ADR-HUB-368-task-operation-interruption.md).

## Archive the service card of an abandoned attempt

Release Manager-only `hub_task_complete completion_mode=abandoned_release_service`
requires `abandoned_release` with the exact original operation ID, revision and
generation. Its preview reads retained facts and binds the same actor, Task,
custody and original selection for a separate confirmation. It archives the
service card with its existing workflow status. Original release outcomes,
member Tasks and any retained source are preserved. Confirmed reconciliation
requires the same admitted original and lifecycle evidence; unproven historical
outcomes remain unknown.

## Historical direct publication cleanup

Release Manager-only `hub_task_complete completion_mode=published_delivery`
uses the existing cleanup preview/confirm. Its `published_delivery` binds the
original runtime journal SHA-256, prepared artifact SHA-256, source base/result
and immediate publication parent. The owner verifies terminal published Task
membership, artifact identity and the exact Git change projection before
classifying clean managed artifacts as published. It creates no Task/Test ref.
The preview token binds Task revision, original evidence and the deletion plan.
Confirmation removes only those clean managed artifacts through the existing
Git cleanup owner and archives the card without changing workflow status.

Optional `publicationJournalPath` addresses a retained original journal after
the current pointer has advanced; its raw hash, original runtimeRoot, artifact,
Task membership and terminal identity are still checked, without path search or
fallback. `publicationBaseCommit` may be the original run's exact `from` for a
combined delivery. The owner proves that complete first-parent chain to the
original terminal and every own Task change's unique ordered before/from and
after/terminal context, path and mode. Added/deleted, binary, non-UTF8 or
unterminated-file content needs whole before/after identity. Other tasks' edits
outside those contexts remain. Arbitrary intermediate ranges or partial Task
survival refuse. The previous exact-last-port input retains its behavior.
Unique snippets alone cannot prove an original removal/replacement. For the
combined route, every complete own edit must map inside one actual zero-context
Git edit of the original from-to-terminal delta, including its removed and added
line ranges. Retained context lines must map unchanged to their exact after
positions. This is read-only; source objects, refs and index remain unchanged.

Partial deletion retains its exact admitted lifecycle intent. Existing RM
`hub_task_operation_reconcile`, addressed to the original Complete request,
may finish its remaining pinned cleanup or settle its canonical outcome.
It cannot retrofit an unsealed historical UNKNOWN, replace the source pin,
discard ignored/dirty data or infer publication from a generic failure.
Ordinary completion and the existing preserve-only absorption modes retain
their previous contracts. See ADR-HUB-369-direct-published-cleanup.

For an explicitly completed non-product operation, RM may select
`completion_mode=operational` without a delivery envelope. This attests the
operational outcome, not product publication. The same owner proves no result,
adoption or squash evidence, HEAD exactly equal to the immutable Task base,
and that base in durable published/tracked history. Existing ignored-data
retirement and clean-source requirements still apply. The same preview,
confirmed deletion and original cleanup reconciliation apply; no Test or
workflow Done is manufactured for an operational card.
An already closed release service may reference its canonical closure via
`completed_operation_request_id` when its historical repository is absent from
today's publication. The owner binds that exact Task's existing release-service
outcome, preserved source HEAD and published revision; it does not reconstruct
or insert a publication. The archived card and completion time stay unchanged.

For an already admitted failed/partial Delete, the existing RM reconciliation
accepts `cleanup_preview_request_id` and optional `cleanup_preserved_files`.
The original successful preview must have the same actor/Task and reproduce
the confirmed original's complete arguments hash. The existing Delete
transition, prior/current Task revision, workflow, executor and results must
match. Ignored artifacts must be retired first. Every remaining dirty or
untracked file needs an exact hash-verified existing retained copy outside the
deleted sources. This includes index-vs-HEAD bytes and every distinct unpublished
working version; multiple entries for one path must have distinct SHA-256 hashes.
A working copy does not prove preservation of different staged bytes. Both
checks run before admission and immediately before removal. Changed source,
retained bytes, Task or preview refuses.
The same original transition records its prior failure and forward evidence
before native cleanup. Partial deletion and lost replies retain that identity;
terminal readback settles only that original. No no-effect claim, new Delete
ID, raw receipt replacement or transfer of a separate claim's UNKNOWN occurs.

## Native Git Task integration (ADR-HUB-463)

The public Task claim/Test/Await/conflict/return/cleanup and original-operation
readback remain. Their Task-only owners retain current selected content, native
Git history, source/custody/actor/revision bindings and CAS. Await prepares the
prospective PreRelease before committing acceptance. A failed or partial
composition cannot advance the Task or replace the last accepted candidate.
No release operation, release API, worker or automatic finalization is present.
See REL-001 for exact Task integration and historical read-only proof boundaries.

## Failed validation receipt reconciliation

An explicit Task ancestry refusal is terminal only after the lifecycle owner
confirms its durable failed transition under its lease. Replaying the same
request returns that failure without repeating Git. Reconciliation of an
ordinary already failed operation tolerates later metadata revisions only
while Task identity, executor, workflow and Git references match the recorded
prior state. It settles the original receipt without mutating Task or Git.
Pending operations, successful outcomes, squash and cutover retain strict CAS;
unproved effects remain unknown. See [ADR-0081](../decisions/ADR-0081-task-git-terminal-refusals.md).

## Confirmed Task conflicts

The existing mutation receipt owner stores `failed` for a typed Task integration
conflict only after the lifecycle owner proves dev restoration and reads back
its durable failed transition. The diagnostic includes conflicting paths, exact
Task/dev commits and the Task checkout. A snapshot may already exist: this is a
known failed integration, not a claim of zero Git effects. Exact request retries
return the same failure without replay. Changed work is a new Test attempt.
Other Git/persistence failures retain the ordinary unknown/reconciliation path;
message matching alone cannot terminalize them. Workflow schemas accept
`blocked`; Task readbacks retain the persisted `blockedBy` prerequisite.
The typed publication-wait admission refusal is also a known terminal failure:
its owning gate runs before Task Git effects. It must not create another unknown
receipt merely because a user tries to resume a still-blocked Task.

A dependency that prevents withdrawal is detected before the Git owner writes
a withdrawal intent or changes dev. The lifecycle owner records and reads back
its own failed attempt, then returns TASK_WITHDRAWAL_DEPENDENCY naming the Task
to handle first. It never starts a recursive return or changes another Task.
A rejected lifecycle begin is terminal only after its transaction rolls back;
an existing foreign transition remains untouched.

TASK_WITHDRAWAL_BUSY is terminal only after the lifecycle reads back its own
failed transition; the foreign withdrawal is untouched. Release generations do
not produce RELEASE_CANDIDATE_FROZEN admission refusals. Their immutable bytes
coexist with later Task work and Await acceptance.

TASK_AWAIT_INTEGRATION_FAILED is a terminal refusal only after the existing
lifecycle owner reads back its own failed transition. PreRelease composition
precedes the Await status CAS; a composition or proven SQLite rejection leaves
the previous Task status and restores the prior candidate. A lost SQLite reply
must be resolved from the original lifecycle outcome before rollback. Ambiguous
commit or rollback outcomes remain unknown/pending and use the existing exact
operation reconciliation, not a new request or a second recovery owner. Ordinary
Workspaces without the release workflow keep database-only status transitions.

Combined closure uses the existing hub_task_complete with optional
absorbed_into_task_id. Preview and confirmation bind the source, surviving Task
revision and Git evidence. It preserves Git artifacts and workflow status while
archiving the source; its lifecycle receipt records absorbedInto. It does not
publish or run an automatic merge. hub_task_claim dependency_override_reason is
an explicit, audited user exception to a prerequisite release wait, never an
automatic consequence of starting a turn. Claim/launch preserve Test/Await/Blocked
workflow status.

`hub_task_complete` additionally accepts the exact enum
`absorption_mode=published_duplicate` only with `absorbed_into_task_id` and only
from a Release Manager Stream. This mode is for an open Task whose own managed
checkout is exactly current durable published main while the named survivor is
already Done with an exact published result. It does not infer delivery from an
ancestor relation, a clean checkout, response text or manual history. The
preview/confirmation token binds source and survivor revisions, repository Git
identities, publication generation and a preserve-only cleanup plan. Ordinary
callers cannot select the mode, unknown modes are rejected, and omission retains
the existing open/tested-survivor contract.

The published-duplicate result records durable `absorbedInto` evidence without
creating a Git result, squash receipt or publication claim for the duplicate.
No Git artifact is deleted. A post-admission failure leaves the same lifecycle
operation in cleanup phase for exact retry from its stored admission evidence;
a later publication does not strand that admitted operation. A committed
outcome is returned by readback instead of replaying closure. Task/Git/publication drift before
admission is a refusal and requires a fresh preview.

For release-enabled Workspaces, combined closure also binds canonical selected
composition validation (plan, approved base and tree) into that same preview and
receipt. Validation precedes source closure and never accepts the survivor or
promotes the live PreRelease. Changed evidence requires a new preview. Await
acceptance rejects incomplete latest-result integration evidence through its
existing failed-transition/readback path; no new replay or recovery owner is
introduced. See REL-001 and ADR-0068.
TASK_ABSORPTION_COMPOSITION_FAILED is a typed terminal refusal only from the
composition proof before the source lifecycle transition begins. Exact request
retry returns that refusal. Errors after closure admission retain the existing
unknown-outcome semantics; they are never classified by message text.

## Task attachment readback

Task list, exact Task reads and attachment-add results project the same persisted
attachment membership from Task source metadata. Attachment reads authorize the
exact requested Task/attachment pair against that membership. A successful add
requires both the copied file and confirmed Task linkage, and an exact request
retry cannot copy or attach it again. A post-write failure may not delete the
file if Task linkage committed or cannot be read back. Previously persisted
attachments become visible through the corrected projection without rewriting
Task rows or copying their files again.

## Deadline ownership

The internal Task composition planner reads Git evidence only for open Await Tasks (including
the one prospective acceptance when invoked by that lifecycle owner). Archived,
draft and done-audit metadata cannot trigger Git scans. Its dev projection is an
observation of the existing ref/worktree, not preparation, repair, adoption or
integration evidence; a missing dev is reported without creating it or waiting
for a mutation lease. Task integration validation remains with its existing owner.

The Codex MCP client owns a finite `agent_hub` tool deadline outside
`HubMcpServer`. It is longer than the server dispatch deadline, so ordinary
server timeouts keep their authoritative error, while a request stalled before
HTTP admission still terminates in bounded time. The deadline applies only to
`agent_hub`; unrelated long-running tools retain their own policy.

## Recovery and retry

Closing and restarting the same MCP server owner preserves its first successfully
advertised loopback port and capability URL. A surviving App Server can therefore
reconnect using its existing launch configuration. If another listener occupies
that port, recovery refuses instead of silently selecting a different endpoint;
direct HTTP success on a new port is not proof that an agent's tool catalog has
recovered. This retains the same context authorization and operation receipts.

A failed dynamic `functions.exec` call that contains an `agent_hub` MCP call
reloads the Codex MCP transport before a later attempt and wakes durable input
lanes. Read-only calls are safe to retry after that rebind.

Recovery presentation distinguishes transport state from aggregate replay
policy. A successful rebind may report that the transport recovered. A failed
rebind reports deferred transport recovery, wakes the durable lane once and
retains the same aggregate replay policy, but never reports the transport as
recovered.

Explicit successful/completed App Server items are terminal success before any
payload inspection. Ordinary result, output and content text never becomes a
transport failure merely because it contains words such as `timeout`, `socket`
or `reset`; only the item's structural success, failure and error markers own
that classification.

Mutations are never inferred from text and never retried with a new identity.
They require the exact `request_id` and authoritative `hub_mcp_operations`
readback:

- no operation means pre-dispatch and permits a retry with the same id;
- `succeeded` or `failed` is terminal evidence and forbids another effect;
- `pending` permits only operation-specific durable reconciliation with the same
  id; it is never a generic replay lease;
- `unknown` is an explicit terminal receipt state when authoritative readback is
  unavailable or an effect completed but its receipt could not be committed.

Release Manager workflow reconciliation reconstructs the exact original
`hub_task_status_update` argument family before inspecting terminal state:
plain status, ordinary status with either or both optional Task revision/current
workflow CAS fields, or a complete cutover identity. An ordinary CAS is checked
again against the lifecycle transition or outcome's immutable prior Task. It is
not treated as cutover evidence. Missing, added or changed CAS fields therefore
change the arguments hash and fail closed. An already failed transition or
authoritative outcome settles only the original receipt without Git replay;
pending Git work still requires its existing process-tree guard and owner.

Ordinary workflow CAS refusal on a fresh MCP intake seals a bounded `NO_EFFECT`
outcome in the existing Task lifecycle owner before throwing. It binds the exact
request/arguments hash, Workspace/Stream/provider/Thread intake identity, target,
expected and observed CAS, and repository (nullable for database-only workflows).
Only a current owned pre-admission boundary may issue it: an existing transition
or outcome, replayed intake, lost lease or prior preparation excludes issuance.
The terminal outcome fences any later begin using that operation ID. A refusal
at BEGIN's CAS is sealed only after rollback and only when no preparation/effects
preceded BEGIN. Typed errors alone are not a substitute for this owner evidence.

The MCP receipt records `failed` with structural `NO_EFFECT` evidence. A crash
after outcome commit but before receipt settlement is recovered by pending-startup
readback or canonical original-ID reconciliation of an unknown receipt, without
Git/status replay. Reconciliation retains the exact optional CAS argument shape
and original identity. Its own identity/confirmation/active-worker refusal before
effects terminalizes only its own receipt; the ambiguous original remains unknown.
An exact immutable admission refusal settles through the existing SQLite receipt
CAS only, before release/Git reconciliation locks: database-only workspaces are
supported with release workflow disabled. `project_root` may be omitted only when
that owner proof records a null root; a supplied locator in that case grants no
Git authority. A recorded non-null root still requires an exact locator. Ordinary
Git recovery still requires its configured root, enabled workflow and owner locks.
Failures once recovery/settlement begins retain ordinary unknown semantics.
Legacy missing-admission cases without positive durable owner evidence remain
unsupported/unknown: absent transitions, error text, timings or current refs are
not certificates. No operator proof register or new historical recovery API is
introduced. See ADR-0085.

A claim refused because its previous executor has active or queued work seals
`task-claim-executor-busy-v1` in that original MCP receipt before Git preparation
or Task assignment. The existing catalog SQLite transaction binds the fresh
intake identity, full claim argument shape, observed Task revision/executor and
the active/queued reason; it rejects prior assignment or lifecycle admission.
The receipt then becomes terminal `failed` with structural `NO_EFFECT` and
`TASK_CLAIM_EXECUTOR_BUSY`. Task claim writes are fenced by that same durable
refusal. Queued input without a Stream ID uses its exact existing Thread binding.
No context capability or message/file payload is retained in this evidence.

A fresh ordinary claim whose first repository-dev-lock acquisition expires
before the preparation callback enters may seal `task-claim-lock-admission-v1`
through that same catalog transaction. The live Git owner binds its actual
acquisition failure, exact operation/Task/repository key and physical lock path
while the Task lease still holds. The original receipt binds the complete caller
and argument identity and observed Task CAS, then becomes terminal `failed` with
`NO_EFFECT` and `TASK_CLAIM_LOCK_ADMISSION_TIMEOUT`. Task-lock timeouts, dependency
work, failures after callback entry, forged typed errors and legacy error text
do not acquire this proof. No shorter timeout, retry or lock removal is added.

A fresh claim refused during read-only source identity discovery may likewise
seal `task-claim-source-admission-v1`, with `TASK_CLAIM_SOURCE_ADMISSION_FAILED`.
The live Task Git owner binds the selected project locator and exact invocation
before any repository preparation callback, dependency work or Task assignment;
the Task lease and existing catalog CAS must still hold. The original locator,
even when it is not a Git repository, owns subsequent sealed-refusal readback.
Correcting routing does not retry that refused ID: a separately requested new
ordinary claim may proceed, preserving existing managed dirty bytes. Generic
fatal text, forged typed errors, lost ownership, post-prepare failures and old
unsealed originals remain insufficient. Existing UNKNOWN/forward-custody rules
are unchanged. See ADR-HUB-367-source-discovery-refusal.

The existing RM `hub_task_operation_reconcile` can read or settle this sealed
claim refusal using the original operation ID and exact recorded repository
locator, without workflow/Git recovery or new assignment. Active original workers,
foreign identities and admitted claims refuse. Same-ID retry and startup readback
recover a lost terminal write from the same seal. An unsealed historical timeout
is not retroactively proved by this future refusal type or a currently empty Task.

Startup readback and exact same-ID retry recover a lost terminal receipt write
from the sealed proof, without preparing Git or assigning the Task again. The
same ID remains refused even after the former executor becomes idle. A typed
error alone, legacy error text, current executor state, a prior assignment or a
partial preparation cannot acquire this proof; ambiguous cases remain UNKNOWN.
No new table, receipt owner, public reconciliation tool or legacy settlement
permission is introduced. See ADR-0124.

An ordinary original native Test whose merge is already exactly applied may
finish after a metadata-only Task revision advance. Its original argument hash
must match its original explicit CAS and optional authenticated single native
review exactly; cutover, absorption and initial-source families stay excluded.
The original revision identifies admission, never the current metadata revision.
Review custody must belong to the original RM actor; the existing native
composition verifier repeats receipt authentication and full Git binding checks.
Recovery
compares the unchanged Task/Workspace/executor/status/workflow/result state,
the original native intent, ordered merge parents, source and dev trees and
clean indexes under their existing leases. A retained process guard refuses.
Immediately before the owning terminal transaction it repeats that readback
and CASes the current row revision, preserving current metadata. It commits the
original outcome/references/status and settles the same receipt; it never
prepares, snapshots or merges again. Concurrent metadata edits fail the CAS;
other state or Git drift remains unknown. An already settled matching original
is a read-only result. Only title/description presentation fields may differ;
other semantic state and unknown evidence refuse. A later dev head is preserved
only through a chain of committed canonical Test outcomes, matching successful
original receipts and exact native intents/compositions. Ancestry alone is not
acceptance; this proof grants no release selection or new Git effects. See [ADR-0113](../decisions/ADR-0113-native-test-metadata-terminal.md)
and [ADR-HUB-389](../decisions/ADR-HUB-389-reviewed-native-terminal.md).

The local Await cutover uses the same canonical `hub_task_status_update` receipt.
When its projector source is a separate Task, the receipt includes that source
Task's exact ID, Test revision, result commit and projector hash. Both Task locks
are held while the source authority is rechecked and the target transition
begins. Current source/target Task, Workspace/Stream, repository and source-result
identity are fenced atomically by the transition transaction. A later pending reconciliation
preserves the transition's immutable source evidence in its outcome; terminal
reconciliation reproduces those durable arguments and does not consult a newer
source Task state or replay the target lifecycle. The transition records the
accepted result. An ordinary Await transition composes that result into the
prospective `PreRelease` first and commits only after the composition succeeded;
a conflict leaves the Task in Test with the last good candidate intact.

Receipt creation is atomic `INSERT OR IGNORE` under the exact identity. Success
stores a bounded structural result projection rather than arbitrary response
content, so a result larger than 1 MiB cannot turn an already-applied effect into
`failed`. Concurrent callers with the same identity share one in-process effect;
after restart an owned reconciliation worker first marks each receipt
`reconciling`. A transactionally persisted lifecycle outcome finalizes the
receipt from authoritative readback without repeating the effect. An incomplete
transition, prepared launch or missing outcome becomes terminal `unknown`; it is
never externally replayed.

Startup scans every pending receipt, not only receipts reached by a retry. A
mutation exception after dispatch is treated as a possibly partial effect and
therefore becomes `unknown` unless an authoritative readback disproves it.
Task create/update field validation has an explicit synchronous boundary before
the Task owner is called. Rejection at that boundary proves no Task effect and
terminalizes the original receipt as `failed` with the validation message. The
same request identity returns that terminal failure without dispatch; corrected
arguments are a new submission. The MCP schema and validator retain the
160-character title limit. Task description and combined creation text have no
independent character limit; complete-request transport bounds still apply.
Creation, editing and imported Task text preserve the complete normalized
description without silent clipping (ADR-0050). Errors from
the Task owner or receipt persistence remain potentially ambiguous; neither
error text nor a general validation-looking exception proves absence of effects.

`hub_task_claim` accepts `dependency_mode=skip|ensure|verify` with default `skip`.
Git preparation and the exact turn binding remain part of claim in every mode;
`ensure` requests on-demand dependencies and `verify` requests full installed
validation under the Task owner, as defined in REL-001.

Task return reconciliation keeps the original status request identity. Exact
withdrawal outcomes require matching prior/result Task references, withdrawn
result and old/new dev evidence. Any remaining Git intent is finalized before
settling the original receipt; failed finalization leaves it unknown. Pending
withdrawal without a process guard may resume only from the proven original
Test/Await state. An existing process guard keeps its ordinary proof requirement.

Production composition cannot access raw Task/Workspace transactions or the
callback-based queue primitive. Its immutable asynchronous owners queue the
complete mutator inventory, including Desktop ingest/reassignment/events,
bug-report and Telegram capture, MCP receipts/attachments/startup reconciliation,
handoff metadata, provider catalog/backfill and Spark/Terra binding, settings,
journal completion, thread binding and Task lifecycle.
Bounded contention retry surrounds the real transaction, preserves the original
identity and yields to HTTP, SSE and timers instead of increasing `busy_timeout`.
The owners expose explicit read, short-mutation and internally managed-effect
allowlists only; an unclassified raw member is not bound into application code.
The existing checklist `link` operation additionally accepts `release_reference`
with the exact accepted Task revision and full canonical Git references
(ADR-HUB-415). This is a Release Manager-only reference in the same release-enabled
Workspace, rechecked inside the queued Task transaction. It preserves the unique
decomposition owner and all archived rows. The existing request hash includes
this binding only when supplied; old receipt identities remain unchanged.
No alternate CLI, historical UNKNOWN replay, publication or absorption credit is
introduced. Desktop checklist mutations cannot author or change this RM relation.

Checklist event delivery is an internally managed effect (ADR-0029): its
single-flight durable outbox drain invokes delivery outside SQL retry and queues
only quarantine/acknowledgment writes with the original event ID. A busy
acknowledgment cannot replay that invocation. An interrupted drain remains
recoverable through the existing idempotent event identity.
Release finalization uses the same Task owner and the operation's exact generation
receipt. It retries only finalize after publication is confirmed, records delivery
for the published result and closes only a Task still naming that result. The
retired Desktop completion adapter rejects new writes with
`RELEASE_OPERATION_REQUIRED`; it is not a recovery owner.
`hub_task_claim` enters Git through public Task admission. Repository admission
first holds the shared dev lease and then checks foreign process-tree guards;
the guarded child runs before that lease is released. A concurrent live owner
therefore makes the claim wait, while a guard that outlives its owner remains an
operator-recovery blocker. The guard is created before the first child process.
Finding an orphan at this boundary is a structured failed-before-effects claim:
no Git mutation or Task binding has occurred, so the exact receipt is failed
rather than left unknown. Same-ID retry may also terminalize the recognized
legacy pre-lock variant only when exact receipt identity, canonical guard path
and repository key match and the Task store proves no binding for its operation
ID. It performs no Git replay or guard removal; any ambiguity remains unknown.

The underlying interprocess lease is represented by an immutable
token-addressed owner file held by its creator. Stale time alone never permits
replacement while the recorded PID is live. Every Git fence rereads the exact
durable token/process identity; recovery requires proven death, exact identity
mismatch, an owner-written release marker or trusted operator action. Renewal
does not rewrite the shared pathname, and release removes only its own token
file, so an old owner cannot retire a replacement swapped into the lock path.
Task lifecycle fencing is a uniformly asynchronous contract: callers await each
durable assertion before workflow, cleanup, failure or deletion persistence and
reject synchronous implementations. Proven-dead or exact-mismatch legacy
`owner.json` locks are retired only by bounded whole-directory quarantine plus
post-move identity validation; live or ambiguous legacy owners remain blocked.
Pending-triage startup recovery awaits its branded Task-owner mutation, and a
queue failure rejects startup recovery without an unhandled rejection or a
false successful outcome.

Composed `functions.exec` calls bind each mutation to the `request_id` in that
specific nested call's argument object. Missing, duplicate-property and
cross-call duplicate identities fail closed: recovery may rebind the transport,
but it performs no authoritative operation lookup and authorizes no replay.
One ambiguous mutation blocks replay of the entire failed composed call, even
when another nested mutation has a valid id and a successful null readback.

Only a successful authoritative readback that returns no operation proves
pre-dispatch. A thrown, timed-out or otherwise unavailable audit read is a
separate reconciliation-unavailable outcome and blocks replay until readback
succeeds; it is never converted to a null operation.

Logs contain tool and operation identity, status and recovery outcome, but not
the context capability or tool arguments.

For `hub_stream_message_send`, `hub_task_start` and `hub_task_reassign`, the
pending operation is bound before provider delivery to one immutable SHA-256 of
the exact stable inter-Stream origin and body assembled by message intake. A
successful operation without that bound content is invalid. Read-side legacy
origin recovery requires the successful tool, exact `mcp:<request_id>`, stored
arguments hash and stored content hash; absent pre-migration content hashes fail
closed and are not reconstructed from message text or ordering.

`hub_task_launch_cancel` is a Release Manager-only terminal reconciliation, not a
replay lease. It may change an original start receipt from `pending`,
`reconciling` or `unknown` to a structured failed/cancelled result only when the
same caller Workspace, Stream, provider and provider Thread presents the exact
Task/start-request owner and Task revision, the Task is still `starting`, the
planned destination Stream is absent and no inter-Stream content hash was ever
admitted. The original receipt is terminalized before Task launch ownership is
cleared. Before either write, cancellation must win the Task-row
`prepared -> cancelling` CAS against the launcher's
`prepared -> admitted(attemptId)` effect admission. A successful fence prevents
that runner and concurrent retries from entering Stream/thread/delivery effects;
an already admitted runner makes cancellation fail without changing the original
receipt. The fence is per Task/request, durable across database connections and
processes, and has no timeout lease. A crash between receipt terminalization and
Task cleanup can leave the Task blocked but cannot make
the original launch replayable; another exact cancellation request may finish
the cleanup. A different caller, Task state, revision, destination effect,
admitted content or successful/failed launch is not cancellable.

Before the planned destination Stream exists, `task.starting` is an idempotent
Workspace event whose payload names that Stream; the event write is awaited
before the durable effect-admission CAS and Stream/thread/delivery effects. Its
rejection leaves the durable prepare
blocked for explicit cancellation and is not silently converted to success.

## Queue diagnostics

Empty diagnostic attempt timestamps fall back to the original intake createdAt;
they cannot hide the age of a queued command. A queued wait and its guard reason
are not an in-flight attempt or provider acceptance.

## Exact squash transfer

`hub_task_status_update` exposes the Release Manager-only Test-to-Test squash
transfer through `squash_*` fields. All identity fields are supplied together.
The first request omits `expected_squash_transfer_hash` and returns a read-only
preview. A later request uses a new request ID and the exact returned hash to
authorize the bounded Git and two-Task lifecycle effect. Confirmation also
supplies `squash_proof_request_id`, the exact request ID of that preview. The
preview identity is part of the content-addressed proof; the new confirmation
request ID owns only its own MCP receipt. Reusing the preview request ID with
different confirmation arguments remains forbidden by the ordinary immutable
arguments hash. The survivor Task revision is mandatory; the source Task
revision is always explicit.
`squash_baseline_result_commit` is the reviewed clean-before commit and must be
an ancestor of the requested new clean result. The durable proof separately
captures the survivor's current accepted Test result, so a stale card cannot be
hidden by supplying a different clean baseline.

The installed public squash contract remains Test-to-Test. A bounded local
one-shot entrypoint may additionally bootstrap one reviewed replacement when
the survivor is currently Progress but still owns its exact prior Test result,
and the source is still Test. That entrypoint binds the reviewed checkout
commit/tree, projector hash, clean-package ZIP/bundle/manifest/inventory hashes,
expected main/dev commits, preserved survivor tree, both Task revisions, normal
transfer hash and a second cutover hash into the canonical
`hub_task_status_update` receipt. Preview and confirmation have different
request IDs; `squash_proof_request_id` remains the stable preview identity. The
entrypoint re-verifies its clean checkout and artifact bytes while both Task,
repository and Await locks are held. It does not manufacture a prior Test,
write SQLite or refs directly, or create another receipt/reconciliation owner.

A lost confirmed response is reconciled only through
`hub_task_operation_reconcile` with the original confirmation arguments and
hash. A squash transition whose Git commands ended normally has no process-tree
guard to invent; exact Git and worktree/index readback owns its recovery. If an
unresolved process guard actually exists, ordinary exact guard proof remains
mandatory. Reconciliation first reads the exact dev parent/tree/result effect
and complete clean materialization. It reuses the same lifecycle transition and
Task/Git locks, never invents a new owner or infers success from ancestry, equal
trees, a ref-only effect or an unavailable read.

A changed confirmation hash, stale Task revision or non-Test participant is a
typed pre-transition rejection. Because no lifecycle intent or Git effect has
started, the public MCP receipt is terminal `failed` and exact same-request
replay returns that failure. Errors after intent remain unknown until canonical
readback. Materialization also treats ignored local files and directories as
user bytes: native checkout collision protection must refuse rather than replace
them, and a ref-only effect cannot complete the receipt. If the accepted target
is already present in the worktree while the real index still equals the exact
old tree, reconciliation may finish the old-to-new index merge without repeating
the worktree update. The merge still refuses any independently changed index
entry, and final exact worktree/index readback remains mandatory.

For the local bootstrap, the final two-Task SQLite transaction is also the only
operation that changes the survivor from Progress to Test. It is admitted only
after exact survivor staging, branch CAS, ordinary squash dev CAS and complete
Git materialization readback. Unknown-operation reconciliation reproduces every
cutover argument and both hashes from the original receipt; missing or mixed
artifact, source, Task, main/dev or preserved-tree identity performs no replay.

## Historical reviewed selected-composition originals (recovery only)

The following protocol describes captured pre-cutover originals. New admission
is closed with TASK_NATIVE_GIT_REQUIRED; current Test uses native Git. Retain
this protocol only to reconcile the exact supported historical original IDs,
including their explicit v1/v2 record interpretation. It grants no new preview
or confirmation capability after HUB-303 cutover.

The same selected argument family and no-effect preview/exact confirmation
support a bounded ordinary own-only conflict proof (ADR-0093). No new writer,
authority registry or public replay entrypoint is introduced. The Git owner
classifies immutable ancestry, rather than trusting a caller-supplied mode.
An ordinary result keeps its Task base; all existing caller, bundle, Task CAS,
publication/remote, materialization and original-ID receipt rules apply.
Preview refusals and legacy UNKNOWN settlement retain their existing owners;
this classification does not itself prove that an old operation had no effect.

For exact saved/stopped Progress absorption (REL-001, ADR-0105), the same tools
accept optional `selected_absorption_handoff: {requestId,text}`. The text is
the exact JSON body of a successful authenticated source-executor
`hub_stream_message_send` receipt targeted to the survivor executor:
`version=1`, `kind=task-absorption-handoff-v1`, `workspaceId`,
`sourceTaskId`, `sourceTaskRevision`, `survivorTaskId`, `baseCommit`,
`sourceCommit`, `sourceTree`, `survivorParentCommit`, `absorptionCommit`,
`saved=true`, `stopped=true`. Unknown fields are refused. The receipt's
original ID includes any actual `mcp:` prefix; no inferred/stripped identity
is accepted. Its durable author/origin/content hash is verified against the
exact body, current Task/transfer/source state and bounded ordered Git histories.
No new ledger, handoff writer, composer or completion interface is introduced.
Both Tasks are reserved through the existing lifecycle intent and recovery
locks; the same proof is persisted and compared at terminal CAS.

For a Task based on accepted local main that diverges from an already published
repository history, the Release Manager may use the `selected_*` argument family
of `hub_task_status_update` with status `testing`, exact Task revision and
expected status `in_progress`. The caller supplies one reviewed Git bundle path,
its SHA-256 and the exact ordered-parent proof commit. A request without
`expected_selected_preview_hash` returns a no-effect preview. Confirmation is
a new request with the same bundle/proof, the original
`selected_preview_request_id` and the returned hash. Preview and confirmation
are separately content-addressed; mixing them with squash fields or a local
cutover is invalid. The normal explicit-upstream-adoption interface is not
relaxed by this mode.

Preview checks current Task/dev, publication generation/revision and live remote
in a disposable object store; no live ref, index, worktree or Task status is
changed. Confirmation admits one durable lifecycle intent before the expected-
old dev CAS, bounded no-overwrite materialization, exact Task result ref and
Test status CAS. `hub_task_operation_reconcile` reproduces the original
confirmation arguments, including the preview request/hash, and resumes that
same pending operation. An absent or post-CAS-ambiguous effect never receives a
synthetic success; a proved pre-CAS refusal may terminalize without changing
dev. The completed receipt must still match the clean exact dev and Task result
on readback. Release preparation requires its independently verified selected
projection and must not replay unrelated rolling-dev bytes.

For the ordinary and verified absorbed OWN routes, optional `selected_published_resolution` carries
the version-1 `ordinary-published-resolution-v1` envelope: `taskId`,
`repositoryKey`, `taskBaseCommit`, `acceptedLocalMainCommit`, `taskCommit`,
`devCommit`, `proofCommit`, `publishedCommit`, `publicationGeneration`,
`remoteCommit`, application `bundleSha256`, `resolutionCommit`,
`resolutionBundlePath`, `resolutionBundleSha256` and exact conflict
`resolutions` entries (`path`, `mode=100644`, `blob`). Unknown fields,
including reviewer-approval flags, confer no authority and are refused. The
existing Git owner verifies the full published OWN projection in its private
preview store; confirmation rechecks fresh fences and retains both bundles
under the original operation before its dev CAS. This does not mutate published
refs or grant permission to install, Await or publish.

Public `hub_task_operation_reconcile` forwards the selected fields independently
of squash and requires the original envelope, preview request/hash and original
confirmation identity. Changed or omitted published proof cannot settle that
operation. The existing `task-operation-reconcile.mjs` CLI accepts the selected
bundle/proof/preview flags and `--selected-published-resolution <json-file>`;
it forwards the parsed envelope through the same owner. See ADR-0095.
Absorbed reconciliation also requires the original
`selected_absorption_handoff`; the CLI accepts
`--selected-absorption-handoff <json-file>` containing that exact two-field
input. Missing or altered handoff cannot settle an absorbed original. Reopen,
readback and downstream projection retain the complete authenticated binding.

Intent, materialization and completion JSON is published only after complete
synced bytes exist. Incomplete pre-CAS private staging can be rebuilt under
the original ID without interpreting it as a Git effect; an incomplete
completion temp is not a receipt, and post-CAS replay requires exact ref,
journal, worktree and result readback before terminal success.

`hub_active_runs_list` and `hub_parallel_streams_list` expose bounded,
payload-free deferred-input summaries separately from live runs. The summary
includes exact Stream/provider/Thread and command identity, queue state, wait
reason, state age and a stalled marker after sixty seconds in `dispatching` or
`reconciling`. A deferred command never
becomes a synthetic live run merely to make blocked admission observable.

Original native Await recovery (ADR-0116) uses the existing RM reconciliation
operation/CLI and the exact original arguments hash and workflow CAS. It adds no
public approval flag, second receipt or replay identity. An owning proof of the
bounded already-published-notes archive can substitute for a nonexistent process
guard; every real guard still refuses. Drift remains UNKNOWN. The same durable
workflow outcome settles the same receipt; repeated terminal reconciliation
performs a read without re-composing or re-archiving.


## Explicit forward custody of an unsealed claim

An explicitly authorized RM may use the existing `hub_task_operation_reconcile`
with `claim_custody` to prepare and then fence one exact unsealed claim. This is
withdrawal of future continuation, never historical NO_EFFECT. The old receipt,
error, argument identity and UNKNOWN remain unchanged. Dedicated immutable stage
state and terminal receipts commit in the existing MCP ledger, not a new journal.
Original/caller/hash/Task/source/WIP/authorization and exact successor ID are
pinned; changed or partially admitted evidence refuses without guessing effects.

Fence requires positive complete legacy-cohort retirement through an exact
externally retained native QUERY handle; missing job names or root PIDs do not
prove it. Ordinary tools cannot acquire a valid witness from inside that job.
The native port verifies the actual witness process/capture/source and local
nonce-bound pipe, not caller-supplied retirement flags. A lost witness before the
fence commit refuses; the committed positive certificate survives later collector
exit. There is no forced stop or automatic independent launch mechanism.

An explicitly scoped RM authorization may instead select
`claim_custody.admission=isolated-source-v1` in the prepare envelope. The existing
Task Git owner stages full independent Git objects and hash-verified WIP under a
new custody epoch outside legacy source/ref/cleanup paths. The existing catalog
atomically checks the complete Task-keyed SQL inventory and commits the fence;
persistent data triggers protect current Task/binding/lifecycle/result/receipt
writers, including old open connections, cached statements and replace/delete
paths. Only the new canonical store can use a synchronous transaction-scoped
epoch permit, cleared before commit. Effects before the fence cause refusal;
late supported legacy writes are rejected or confined to the old checkout.
The historical UNKNOWN is unchanged. This is the exact authorized historical
claim scope in ADR-0131, not a default substitute for missing retirement proof.

Only ordinary successor `hub_task_claim` with the declared ID and
`forward_custody_request_id` assigns the Task. It retains the current executor's
active/queued-work guard through the SQL commit and uses the existing managed
Git owner for read-only source reuse. Original dependency preparation is not
replayed, and its response says so. Late originals are fenced before any binding
or baseline update, including receipt writes; exact post-commit retry reuses the
same binding and assignment. See [ADR-0131](../decisions/ADR-0131-claim-forward-custody.md).

If the pinned current executor is already the successor Stream, only the exact
current claimant run is excluded from that busy check. Its nonempty run ID,
Workspace, Stream, provider, Thread and turn must match the genuine active run;
object and identity are rechecked before the SQL assignment commit. Other runs,
ambiguous/old runs and queued inputs remain blocking, including in that Stream.
The first fenced binding advances the Task revision once even when its assigned
Stream is unchanged; exact committed readback does not advance it again.
The active-run authority comes from the running Hub's RunCoordinator through
its existing MCP composition. A source release runtime/caller token alone has
no active-run authority. Correct owners must be delivered to that runtime before
the genuine actor resumes the same addressed UNKNOWN successor through live MCP.
The existing receipt-first MCP submit owner permits this exact fenced UNKNOWN
continuation after unchanged actor/tool/argument-hash validation, then invokes
the existing custody owner. Generic UNKNOWN operations remain read-only; an
already active local invocation is joined/read, never dispatched a second time.

An independently authorized unassigned original may explicitly pin
`expected_owner_stream_id=null` only with `isolated-source-v1`. Missing/empty
owner pins remain invalid. The Task must remain open/new without accepted Git
results. The same owner preserves discovered managed source/WIP, or pins the
actual registered local-main base only when no prior Task root/refs exist.
Independent full history/refs and the existing SQL/receipt fences protect the
one declared successor. Base pinning never repeats prepare/ensure, discards
discovered Task artifacts or changes the historical UNKNOWN. An unassigned Task
has no previous-executor busy lane; all assigned-owner guards remain unchanged.

The existing MCP ledger reserves the declared successor by request ID across
its entire mutating-tool namespace, independently of caller-supplied Task or
forward fields. Intake checks the exact tool/caller/arguments hash inside the
existing receipt transaction; a planned successor cannot be consumed before
its matching fence. Persistent SQL guards also reject old cached receipt
insert/replace/rekey paths. An occupied ID refuses custody preparation rather
than replacing a receipt or selecting another ID. Exact genuine replay remains
readback of that same assignment and receipt.

An existing clean managed source may explicitly declare `source.wipPaths: []`
with SHA-256 of the JSON empty inventory. The same filesystem owner must prove
absence of WIP throughout the bounded source directory inventory, including
case variants on Windows. Known Git/dependency namespaces remain separate;
other aliases cannot establish absence. Missing declaration is invalid.
The existing repeated prepare/stage/fence/initial-successor reads must all
observe the declared inventory. These are bounded observations, not a freeze
of the legacy source or a historical NO_EFFECT claim. Nonempty WIP keeps its
existing declared-path copy/hash safeguards and budget.

## Pending stop and authenticated Desktop admission (HUB-368 R1/R2)

A requested stop excludes new ordinary claim/workflow admission for that Task
until confirmed stopped. The same indexed durable disposition is checked in
receipt admission, before execution/next effects, and inside final Task SQL
transactions. Cancellation continuation and other Tasks remain independently
operable. A late assignment/finalization cannot overtake the requested stop.

An authenticated Desktop workflow has actorKind=authenticated-user in the same
MCP operation ledger, including an unassigned Workspace or Backlog Task. Its
Stream/provider/Thread are null, not an invented provider turn or new Stream.
Provider admissions retain their exact required caller identity. Existing rows,
indexes, triggers, custody and receipt evidence survive the atomic nullable-user
identity migration unchanged; no historical operation is reclassified or replayed.
The existing Desktop controller and cancellation owner read and stop this exact
operation before the next ordinary action, without changing Task assignment.

## Task admission and original result readback

An ordinary Await original with its canonical execution binding and exact five
business arguments may fail before lifecycle admission. A genuine low-level
Await-lock admission refusal is recorded by the existing lifecycle/outcome owner
only when its callback was not entered; an error code or message is not proof.
For an already UNKNOWN original without lifecycle state, explicit RM reconciliation
uses the existing Await/Task/repository leases and process guard. In one existing
Task-store transaction it rechecks the canonical MCP identity, complete arguments,
current Task CAS and absence of a transition/outcome, then records its terminal
admission refusal. The existing lifecycle BEGIN checks that outcome before Git:
a concurrent BEGIN either won first and reconciliation refuses, or cannot start
after the refusal. This atomic fence, not unchanged Task fields or a missing PID,
establishes the unadmitted disposition. The complete previous UNKNOWN receipt is
retained in the outcome. Existing admitted/partial/guarded/STOPPED or foreign
originals do not gain this authority. No Git action or original mutation is replayed.

The external source API host exposes the existing `hub_task_operation_reconcile`
through the same capability and addressed-worker close/join. The external CLI
`task-reconcile` reads its own control receipt by exact request/arguments identity;
the addressed old Await and the reconciliation command have separate outcomes.

If that ordinary reconciliation control itself is UNKNOWN, an explicit SAME
control invocation with its unchanged actor, arguments hash and ordinary Await
identity re-enters only the existing reconciliation owner. It does not resubmit
the Await. The owner repeats its normal leases and exact original validation;
an already settled admission refusal is read only from its matching durable
outcome and canonical failure receipt. The control retains its previous UNKNOWN
receipt when completed. A refusal during this continuation leaves that earlier
UNKNOWN intact; it cannot disprove effects of the previous invocation. A fresh
control that never entered the recovery lease callback fails before effects
instead of creating another ambiguous original. Other reconciliation families
retain their existing continuation rules.

A local live invocation is reported as active, an explicit UNKNOWN receipt as
unknown, and a nonterminal receipt without observed local execution as unresolved.
Receipt presence and a missing worker never prove queue membership or completion;
the submission result trace must not label every nonterminal response queued.
This observation does not replace the canonical receipt status or effect authority.

If writing a failure/UNKNOWN receipt fails, the completion owner preserves both
bounded errors as diagnostic metadata in the existing execution binding, under
the exact receipt/actor/hash/current-owner CAS. No new ledger or work queue is
created. STOPPED history and terminal winners cannot be changed. This finite
diagnostic write neither reruns effects nor certifies NO_EFFECT. Reopen and exact
same-ID submission return the retained diagnostics without another worker.
Original-ID trace spans contain only error codes/hashes and persistence outcome,
never arbitrary error text. If diagnostic persistence also fails, those existing
best-effort trace records are the fallback observation; an unavailable trace or
diagnostic write cannot be represented as durable success. Historical pending
claims without positive execution/preparation/custody evidence remain unresolved.

The same diagnostic preserves a failure of lifecycle failure persistence inside
the admitted operation, even if the outer UNKNOWN receipt is written successfully.
The original operation error and that inner persistence exception retain their
identities through the existing exception chain. If outer persistence also fails,
it does not replace the first failure pair. Lease loss still prevents lifecycle
writes; these diagnostics confer no terminal outcome or replay authority.

A failed lifecycle BEGIN also retains its original exception if a follow-up
Task read is unavailable. Completion classification reads use the same bounded
failure diagnostic as completion writes: a second failed read preserves both
errors without inventing a lifecycle row, terminal receipt or NO_EFFECT result.
Same-original reopen remains read-only. An explicit supported cancellation may
fence an aware execution with no lifecycle row under its existing recovery lease
and process guard; only its positive STOPPED result establishes that disposition.

Public MCP Task mutations return a `taskOperation` admission/readback envelope
from the existing MCP ledger once the same worker is registered. Admission is
not successful business completion. `hub_task_operation_get` reads that exact
original ID, canonical argument hash, actual live-worker observation, lifecycle
phase, cancellation, error and terminal result. Same original caller or genuine
RM authority is required; supplied original arguments/hash must match. Reading
never resumes or settles an operation. Same-ID mutation submissions read the
existing receipt without starting another worker; changed arguments refuse.
The sole UNKNOWN-cancel continuation exception above uses the existing canonical
interruption owner and its unchanged guards, not general mutation replay.

Long valid work has no transport-derived terminal deadline. A disconnected
caller reads the original ID instead of submitting another mutation. A real
UNKNOWN stays UNKNOWN; absence of a worker in the reader process is not proof of
failure or retirement. Existing internal/ordinary CLI consumers may still await
the same worker's terminal Promise. The existing reconciliation CLI exposes
`--read-arguments` with ordinary local provider/thread/Stream authentication.
No alternate writer, work queue, cancellation policy or recovery authority is
introduced. See ADR-HUB-368.

Authenticated Desktop create/update/workflow/Complete/Delete use the same
ledger and real user identity, including null provider/Stream/Thread. Preview
and confirmation retain their distinct original commands and exact token. The
original identity and tool cannot be rewritten. A durable outer control receipt
may acknowledge this admission envelope; only the inner canonical Task receipt
establishes business completion. Existing domain, source, actor, CAS, Task/repo
lease, cleanup and publication guards remain mandatory.

## Durable cleanup confirmation capsules (ADR-HUB-434)

Successful complete/delete preview compaction preserves action, token, exact
Task identity/revision and the complete preview digest/length within 64 KiB.
Combined-closure capsules also retain the survivor identity/revision, including
when their full Git/composition plan is omitted.
Editorial text is omitted first. A larger plan has explicit previewOmitted;
that capsule is not full forward-delete preservation evidence. Confirmation
still revalidates the full live plan through the existing lifecycle owner.

An exact protocol-v1 ordinary original preview with an already compacted token
may explicitly re-enter the same tool/arguments to obtain a fresh current
preview. The existing Task lease and receipt/Task CAS preserve the old receipt
inside previewRecovery and keep its original completion timestamp. Original get
remains read-only; changed or foreign authority still refuses.

The same explicit recovery supports only the ordinary combined-closure preview
family with its immutable absorbed_into_task_id. The existing combined owner
acquires Workspace Await, both Task and repository leases once, recomputes the
complete composition/Git preview and holds that scope through the receipt CAS.
Source and survivor revisions and lifecycle absence are rechecked inside that
transaction. A changed target, special mode or unproved original refuses. This
recovers a fresh preview under the same original; it never closes either Task.

An owning typed token mismatch before admission is failed validation. An exact
ordinary UNKNOWN original whose immutable args omitted the token may settle
through that same validation owner after Task-lease, original/hash/actor,
canonical lifecycle absence and in-transaction Task/receipt checks. The prior
UNKNOWN/history/execution binding remain retained. This performs no cleanup,
new lifecycle admission or effect replay and supplies no general NO_EFFECT.
Special UNKNOWN confirmations, admitted, changed, foreign or unproven originals stay refused.
Downstream message/code lookalikes retain ordinary UNKNOWN semantics. Public
submission waits for this addressed recovery's result rather than returning the
old compacted success as if the recovery had finished. See ADR-HUB-434.

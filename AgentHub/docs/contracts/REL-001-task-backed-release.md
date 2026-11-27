# REL-001 — Task Git integration

## Connected GitHub account (ADR-HUB-254)

The Hub owns one optional GitHub connection for its managed Git work. Protected
local control verifies the account before saving its credential under current-user
Windows DPAPI and the existing private-directory ACL. No credential enters a Task,
command receipt, agent instruction, provider environment or ordinary diagnostic.
The shared public profile contains only name/email and a generation-bound credential
helper locator. GitHub permissions remain those of the user's access token.
Browser OAuth uses the shared registered application. Only explicit local sign-in
starts it. The GitHub callback marks its bounded attempt at the isolated OAuth Worker.
The initiating Hub polls over HTTPS and proves its possession of the PKCE verifier.
The exchange uses the Worker's secret, redeems only once, and sends the token only to
that caller without storing it at the Worker. The existing account owner verifies
the final token before atomic selection. The OAuth
request matches the existing Git and GitHub CLI scope set
`gist read:org repo workflow`. Actual permissions are the intersection of the grant,
account rights, and organization policies. No separate private email scope is
requested; the authenticated account's numeric noreply address is the fallback.
The shared Git/gh/API credential owner enforces expiry and renews an expired
access token on demand when the connection has a valid refresh grant. Authenticated
sign-in can return both tokens to a compatible Hub. Both tokens are protected by
DPAPI and rotated atomically under the same Git profile identity. The refresh
operation uses the Worker's existing durable owner. It retains a short-lived
encrypted result so a lost response can be read back using the same attempt.
An uncertain GitHub exchange cannot trigger another exchange of the same grant.
The account stays selected on temporary failures. A legacy connection without
a refresh grant, an expired or rejected grant, or an unrecoverable exchange
requires explicit sign-in. Application registration and real grants belong to
the deployment owner.
Cancellation/replacement invalidate pending authorization immediately, but replies
join the existing credential writer through publication/readback and cleanup.
Pre-publication cancellation preserves the original selection; a publication that
wins is reported as the actual selected account. A completed reply cannot report
an old account and then be followed by that cancelled attempt's publication.
Quiesced snapshots join the same section; ordinary live reads stay independent.

Internal commit/merge/commit-tree writers and both provider launch paths consume
that same profile for new work. A persistent provider reads the latest atomic profile
on each Git invocation; reconnect does not restart a turn. GitHub HTTPS credentials
go only to Git's credential pipe; the gh launcher supplies its token only to its own
GitHub CLI child and redacts accidental token output. Foreign hosts receive no Hub
credential. HTTP 401 and Git rejection apply only to the exact credential used.
An earlier credential cannot reject a newer pair. Authenticated requests are
never repeated after a permission refusal.

Global Git configuration, existing keys, original commit objects/authors/hashes,
Task ownership/CAS and native content/history guards are unchanged. New synthetic
archive anchors bind their Git identity once to the original archive receipt, so
retry cannot change an already-created anchor after account reconnection. With no
connection the previous Git defaults remain; this is not a server-side authorship
enforcement or signature policy. Offline historical source projection is not a new
interactive writer and must not re-attribute historical work to the current account.

## Exact retained insertion (ADR-HUB-460)

The existing literal replay proof may also verify one pure insertion independently
of Git's ambiguous hunk alignment. For unchanged regular-file mode and nonbinary
UTF-8 bytes, the exact inserted block must already occur in the candidate and its
reinsertion must reproduce the entire replay byte for byte. No removal,
replacement, semantic or cyclic equivalence gains this credit. Native graph,
selection, identity, replay boundaries and the other content proofs remain intact.

## Task card archive (ADR-HUB-466)

Ordinary card archive does not attest delivery. It can clean exact, clean,
Task-owned branches and worktrees using the existing published-result proof
independently of which runtime is currently installed. Unverified repositories,
later or foreign branches, and dirty or ignored data are preserved. Confirmation
binds current Task revision, the exact cleanup preview and any retained
artifacts. Partial cleanup leaves its originally admitted plan for readback,
and an addressed continuation observes the remaining artifacts without
repeating the deletion. Closure with unapproved leftovers requires a fresh
explicit confirmation.

## Verified manual delivery (ADR-HUB-466)

Task Complete can explicitly verify a real manual installation instead of
consulting an old publication generation. Exact runtime/manifest/source,
main/origin and Task-result containment are mandatory. Workflow Done precedes
closing. Ready requires the existing authenticated live desktop control owner,
matching PID/release and a stable endpoint, not a retained Ready lock alone.
Manual main-to-dev synchronization verifies the installed bytes in one proof
per invocation. Before checkout, ref promotion and terminal readback it checks the
same manifest, installation, runtime endpoint, published authority and verified
files' identities and change metadata. A change invalidates the invocation's proof.
Immediately before each effect and terminal settlement it checks current dev state
and physical ownership. Partial effects keep the original recovery identity.
See ADR-HUB-569 for the one-proof boundary.
Preview/confirmation uses existing Task CAS. Complete removes only the listed
clean managed branches/worktrees after exact published result/current HEAD
verification, then archives the card. Every present worktree must independently
pass current Task ownership before planning and again when consuming cleanup,
including repositories with canonical Git refs and historical source pins.
A published HEAD alone grants no ref ownership.
An absent historical workspace can supply an artifact-only branch only when its
name matches the existing Task UUID/repository branch or current numbered Task
branch. This check also applies on consumption/reopen; old evidence is not a waiver.
Ignored WIP/dependency receipts and dirty or unpublished/later work block cleanup
and remain intact. Their artifact owner retires them separately.
A partial cleanup retains its admitted original intent;
addressed reconciliation checks the remaining subset and finishes that original.
An already closed archive can receive a fresh read-only cleanup preview and
confirmation without rewriting its status, workflow or completion time. An old
canonical manual Complete can pin its source via completed_operation_request_id;
missing receipts require the full fresh delivery proof, never archive status or
ancestry alone. Preserve-only old confirmations retain their original meaning.
If physical cleanup already removed the exact owned Task/repository-key path,
its still-registered Git worktree can be listed separately in the same preview.
Positive path absence, unchanged branch/head and the exact non-reparse managed
Task parent are checked again before targeted native worktree removal and branch
CAS. Existing/replaced/foreign paths refuse. No global worktree prune is used.
When the registered primary remains behind an already published main, the
configured Hub-owned standalone clone is the read-only delivery authority.
Its existing marker must bind this primary/common directory and managed layout;
its clean main/HEAD/origin and actual origin main must match the installed
revision. A foreign remote/root, stale tracking, or changing identity refuses.
Proof and confirmation retain that binding while primary HEAD/index/tree stay
unchanged. Without an existing clone, the retained primary-only proof remains.
The explicit main-to-dev service may bind the same proof to its existing
isolated native sync journal and expected dev revision. Normal conflict
resolution and fresh delivery fences precede dev CAS. Historical publication
and UNKNOWN receipts retain their meaning; no release generation is made.
Distinct dev and published object closures are combined by the existing owned
object store and invocation-only math view, not by fetching into primary or
altering its refs. The normal isolated journal still owns resolution and dev CAS.
When the issued manual merge needs additional Task compatibility beyond its
automatic/conflict composition, the same service can receive a separate exact
`nativeResolutionReview` (`requestId`, original `text`). Its existing
`native-merge-review-v1` envelope must be backed by a successful authenticated
inter-Stream receipt bound to the Task Workspace and exact review context.
Agent rules govern reviewer selection. Ordinary conflict-only merges do not
require a compatibility review receipt.
The bound operation/delivery/identity, all bases, original journal and issued
stages, canonical automatic inventory, exact candidate/tree and complete
before/after changes are recomputed. The full selected-content consumer accepts
only that exact reviewed delta. Foreign/stale/changed/unaccepted input refuses.
The same native journal retains this input before normal continuation; reopen
cannot lose it by omitting an optional argument. Its real receipt is rechecked
through full validation and delivery fences. Business identity and original
manualSync arguments remain unchanged. No release worker, new approval ledger,
path allowlist or fake publication evidence is introduced (ADR-HUB-466).
The native sync math binds every best merge base for both retained publication
and verified manual policies, including criss-cross histories. It rejects a
changed set rather than selecting one convenient base.
Delivered managed source may prove manual workflow Done without a Test ref;
the existing status owner requires exact Task/status CAS and records the
actual installation/managed-head evidence without manufacturing a Test result.
An unrepresented historical repository may only be explicitly retained with
its exact managed path/head pin. Its contents are preserved, not certified
published. Canonical referenced repositories and managed source still require
the full delivery proof; retention cannot exclude them from it. A cleanup preview
identifies this retained repository as an obstacle instead of deleting it.

## Scope after removal of the release mechanism (ADR-HUB-463)

The application has no release operation, generation, freeze, publication worker,
release recovery, automatic finalization or release-only MCP/HTTP/CLI surface.
`hub_release_*`, `release-api.mjs`, `release.mjs`, `recipe.mjs`, `publish-all.mjs`
and `publish-changed.mjs` are removed. Historical ADRs describe their former
behavior; they are not executable continuation instructions. No replacement
release orchestrator is introduced.

Tasks retain their existing CRUD, comments/history, requirements, checklists,
ownership, managed Git branches, Test, Await, conflict continuation, return,
cleanup and absorption. User-authored rules, persisted receipts and historical
SQLite data are not rewritten or deleted by this change.

## Authority and original identity

Task mutations require their genuine authenticated Workspace/Stream/Thread
actor, original request ID, complete arguments and exact argument hash. Card
revision/CAS and accepted Git result are distinct identities. Metadata changes
do not invent a new accepted result. Reconnect, lost ACK and UNKNOWN reuse the
same original; elapsed time or a CLI exit is not evidence of a settled effect.
Existing task-operation reads, supported stop and retained-unknown semantics
remain authoritative. No new global queue or lock serializes unrelated Tasks.

The persisted settings keys `releaseWorkflowEnabled` and `releaseManager` keep
their Task branch opt-in and acceptance/cleanup authority. The visible labels are
"Релизный процесс" and "Релиз-менеджер". Their built-in instructions describe the
user-agreed manual process, not an API or worker capability (ADR-HUB-463-policy).
Literal true enables each corresponding policy independently; Auto-review and
Team Lead composition retain their own settings. Generated blocks precede raw
rules and are never persisted back into authored Workspace/Stream content.
Stored authored copies remain ordinary user content and are never recognized,
rewritten or deleted. Thread rotation and catalog reopen preserve this boundary.

The historical Task title rule (36 characters unless meaning requires more),
claim/dependency ensure/verify, native integration/absorption guards, resource
locks, primary protection and explicit user exceptions remain intact. Before
creating a Task, inspect all Workspace Tasks and their results; continue matching
unfinished work, account for completed work, clarify contradictions, and link
related results and differences for a new Task.

Manual delivery pins the checked PreRelease composition without stopping
executors: prepare version/common notes, build an installer, install FROM it,
verify actual Ready/source/affected behavior, and correct failures directly in
PreRelease before a new build/install. Only failed/affected checks repeat without
another concrete reason. After success: exact checked main push, main-to-dev
sync, GitHub Release only if Workspace rules require it, verification of all
Workspace-required delivery stages, and Task Done/Complete. Cleanup and
backup retention are separate. Post-publication corrections belong to a later
release; published source, assets and original outcomes are preserved.

## Git effects of interrupted Test (HUB-524)

The Windows Job proves retirement of the physical Git tree. For the exact
original Test intent, the cancellation owner separately reads dev and the Task
result ref under the repository lease. The original lifecycle receipt retains
its interruption and actual Git evidence without another ref mutation. The
next Test requires ordinary ownership and admission. See ADR-HUB-524.

## Managed claim, Test and Await

Claim returns the canonical managed checkout with its claim/custody binding.
An ordinary Test for a Task outside Await admits under its Task owner. Its
repository dev owner protects the Git effect through exact terminal readback and
the durable Task result. A Test whose Task joined Await while it was queued
releases the Task owner before entering the Workspace Await lock order. Await
membership changes, absorption and the specialized recovery paths retain their
existing admission and authority fences.

A fresh ordinary native Test checks out its exact inputs under the repository
owner, records the original Test intent, then prepares its detached merge under
Task and object-pool ownership. Recovery uses the recorded Task snapshot. Only
an original without an admitted target may prepare that snapshot on newer dev.
The repository owner recomputes the input identity before recording a conflict
or applying a result. If dev or that identity changed, preparation restarts from
current pins. A detached stage cannot supply a stale conflict or advance dev.

Task Git still validates exact main/publication baseline, registered repository
identity, branch, commit, selected content and worktree state. It does not adopt
rolling dev, another checkout or a broader operational aggregate as Task source.
Dependency ensure, explicit reviewed custody recovery, empty-WIP fencing and
committed claim readback retain their existing checks and receipts. A historical
forward fence does not reserve the working copy against ordinary claims. Task
Git uses the established Task checkout and its existing locks. The withdrawn
request remains fenced from assignment and result writes. A new ordinary binding
also supersedes an unconsumed declared successor.

Dependency ensure reuses the existing installed set by exact dependency
compatibility under the shared input owner. That source remains stable across
updates of a regular checkout's `node_modules`. Each Task keeps a local
`node_modules` directory and its own cache. A warm attachment publishes
package directory references once without rehashing or linking individual
package payload files. Explicit verify still validates the installed source.
When the shared input is absent, a compatible installation already in the
registered main checkout seeds it once without running npm. The shared input
owns its own bytes so an update of main cannot change a running Task's
packages. Replaced per-file attachments retain their local files and cache. A
project with task-local install inputs keeps its local npm path.

Test integrates the addressed Task result into dev through the existing native
Git owner. A conflict issues a bound native checkout; a normal resolution commit
must match the captured parents/stages, preserve automatic clean context and
retain all earlier and new owned content. Test failure/unknown does not imply
acceptance. Required Task test-contour operation remains separate and binds the
exact dev runtime/readiness identity. The removed release-candidate contour
mode is not a Task dev contour.

Await uses `TaskIntegrationService`, `TaskCompositionPlanService` and
`TaskIntegrationGitService`. It reads the current selected Task set, canonical
accepted results, full native history and live Git authority. It prepares and
validates an isolated candidate, rereads authority at the existing promotion
boundaries, and commits the Task transition by its existing final CAS. A late
change refuses/rolls back through the existing owner; a partial prospective
composition is not an accepted PreRelease. Primary and unrelated checkouts,
prepared/checkpoint state and prior accepted results remain protected.

Original-ID reconciliation can continue an ordinary prepared promotion using
the exact pending Task transition, current publication and ordered selection,
original prepared journal, and the physical standalone clone. The prepared
target must already be checked out and match the entire index and worktree.
The old PreRelease ref and checkpoint must match the journal's saved state.
The owner verifies the retained native graph and selected content and
reconstructs the original manifest digest before promoting the ref by CAS.
No second checkout, merge or original Await is issued. A journal addressed
to the original also permits readback of the promotion's own later ref and
checkpoint writes. Foreign or missing evidence leaves the original unknown.
Unaddressed v1 journals are compatible only at the detached, pre-ref boundary
with exact manifest reproduction. New ordinary Await preparations record their
original operation ID. This compatibility read is needed only while a v1
preparation admitted by an earlier version remains unresolved. See
[ADR-HUB-530](../decisions/ADR-HUB-530-interrupted-await.md).

The planner computes the baseline and prospective plans from one fresh live Git
pass per acceptance boundary. After Git evidence it rereads canonical Task rows
and durable selected composition authority on that invocation. Each boundary
still checks its original revisions, current Git evidence and existing native
base, history and content proofs before promotion or final CAS. Evidence is
never reused across boundaries or operations. The broader multiple-base and
publication policy from canceled work remains outside this mechanism. See
[ADR-HUB-461](../decisions/ADR-HUB-461-fresh-acceptance-plan-pair.md).

## Native content and conflict preservation

Task composition includes only the exact selected results and their supported
dependency/absorption authority. Foreign/unselected merge sides remain refused.
An ordinary Task merge into dev or PreRelease keeps the destination tree's
root `CHANGELOG.md`. The selected source commit and its parents stay intact;
the root changelog contributes no Task content or conflict. Release preparation
and synchronization from published main keep their existing authority over it.
See [ADR-HUB-562](../decisions/ADR-HUB-562-release-changelog-ownership.md).
Native absorption may retain a two-parent source merge when it is the exact
returned source Test and its second parent is the published commit captured
by that original Test. This commit must still be an ancestor of the currently
verified publication. When the exact handoff binds a preserved
source HEAD, the same Git owner verifies the selected source on that HEAD's
first-parent history at Test and combined closure. Late commits remain in
the source branch and worktree. See ADR-HUB-448 on the published parent of a
returned Test.

Successive native Tests may absorb different sources into the same survivor.
Each adds one authenticated handoff and retains the previous exact Test
outcome. Await and release preparation verify every recorded merge and its
ordered parents. Combined closure verifies the handoff for the requested
source against the survivor's latest exact Test. A foreign merge side or a
competing handoff for the same source fails verification. See
[ADR-HUB-571](../decisions/ADR-HUB-571-multiple-native-absorptions.md).
Every actual ordered merge parent, automatic tree, resolution binding and
selected result is checked. Normal issued resolution continuation stays within
the original native owner namespace and finite lock ownership; unresolved
checkouts remain available for their supported continuation.

The existing independently verified automatic absence, contained publication
replay, ordered later automatic/resolution proof and exact literal duplicate
insertion guards remain unchanged. They do not grant whole-path, ancestry,
semantic-equivalence or once-accepted credit. Earlier/new loss, changed parents,
foreign/stale selection or publication, mode/type/binary loss, automatic-context
loss and changed authority still fail their owning proof. No live branch,
journal, reference, receipt or source result is repaired by a proof read.

Absorption keeps genuine original actor/source/survivor, revision/result/claim,
Test/return/full-content bindings, real prospective composition and CAS. A
successful fresh preview yields the exact cleanup token; confirmation is a
separate supported action. Old UNKNOWN history is retained. No source deletion,
implicit closure or second return is inferred from ancestry or a summary.

## Historical publication facts

Task Git may need a previously published base/selected composition to validate
existing branches. `task-publication-history.mjs` reads the old indexed SQLite
facts read-only, with unchanged original authorization/generation/receipt/hash
validation. Its pure legacy decoder is not a store, writer, state machine,
worker or new publication authority. Missing, ambiguous, foreign or tampered
facts refuse; reads never create a database or settle historical outcomes.
Legacy database tables, archived artifacts and retained runtime records remain.

The existing Complete command can preview and confirm an archive-only closure for the
service card of an explicitly abandoned attempt. The historical owner checks
the exact original revision, idle FAILED state, immutable generation, actor and
original selection against the service checklist. The confirmation binds the
same Task revision and custody. The archive keeps the card's workflow status,
member Tasks, all source custody and the original failure and effects as
recorded. It does not produce a release result or delete a worktree. The Task
lifecycle owns the archive receipt, and the legacy decoder is read-only.

## Build, installation and manual delivery

Standalone build/package tools consume the explicitly pinned external tool
package and exact source. Runtime maintenance retains status, verify, install,
package-install, config-validate and maintenance-read. RuntimeHost, restart,
drain, backup/rollback, Ready/readback, immutable runtime identities and their
installation mutex/native companions remain. A runtime `releaseId`,
`releases/` directory or installation publication lock is an installation
identity/primitive; it does not start a release workflow.

Manual delivery finishes the code in PreRelease, builds an installer from that
source, installs and verifies it, corrects failures if needed, then manually
merges the verified result into main and pushes. This is a human-directed Git
and packaging sequence, not a new application service. Task Await does not mean
installed/Done, and installation does not automatically finalize selected Tasks.

## Observable checks

The removal is checked by real Task CRUD/checklist/claim/Test/Await against
disposable Git/SQLite, original receipt and history checks, DOM-level Task-role
behavior, application import/startup wiring and independent package/maintenance
checks. No old release full suite or old live release original is run to deliver
the removal. Exact checks and any unsupported environment checks accompany the
reviewed Git result. Historical failed/unknown runs keep their attribution.

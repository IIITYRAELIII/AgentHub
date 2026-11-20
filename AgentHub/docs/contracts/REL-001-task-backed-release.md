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
Persisted expiry is enforced at the shared Git/gh/API credential owner and requires
sign-in again. Application registration and real grants are owner actions, not tests.
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
credential. HTTP 401/rejected credentials require reconnect; permission refusals are
not retried publicly or treated as successful authentication.

Global Git configuration, existing keys, original commit objects/authors/hashes,
Task ownership/CAS and native content/history guards are unchanged. New synthetic
archive anchors bind their Git identity once to the original archive receipt, so
retry cannot change an already-created anchor after account reconnection. With no
connection the previous Git defaults remain; this is not a server-side authorship
enforcement or signature policy. Offline historical source projection is not a new
interactive writer and must not re-attribute historical work to the current account.

## Verified manual delivery (ADR-HUB-466)

RM Task Complete may explicitly verify a real manual installation instead of
consulting an old publication generation. Exact runtime/manifest/source,
main/origin and Task-result containment are mandatory. Workflow Done precedes
closing. Ready requires the existing authenticated live desktop control owner,
matching PID/release and a stable endpoint, not a retained Ready lock alone.
Preview/confirmation uses existing Task CAS. All Task Git artifacts,
ignored WIP and dependency receipts are preserved. Cleanup is separate.
The explicit main-to-dev service may bind the same proof to its existing
isolated native sync journal and expected dev revision. Normal conflict
resolution and fresh delivery fences precede dev CAS. Historical publication
and UNKNOWN receipts retain their meaning; no release generation is made.
The native sync math binds every best merge base for both retained publication
and verified manual policies, including criss-cross histories. It rejects a
changed set rather than selecting one convenient base.
Delivered managed source may prove manual workflow Done without a Test ref;
the existing RM status owner requires exact Task/status CAS and records the
actual installation/managed-head evidence without manufacturing a Test result.
An unrepresented historical repository may only be explicitly retained with
its exact managed path/head pin. Its contents are preserved, not certified
published. Canonical referenced repositories and managed source still require
the full delivery proof; retention cannot exclude them from it.

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

## Managed claim, Test and Await

Claim returns the canonical managed checkout with its claim/custody binding.
Task Git still validates exact main/publication baseline, registered repository
identity, branch, commit, selected content and worktree state. It does not adopt
rolling dev, another checkout or a broader operational aggregate as Task source.
Dependency ensure, explicit reviewed custody recovery, empty-WIP fencing and
committed claim readback retain their existing checks and receipts.

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

The planner baseline/prospective reads, ordered history and selected-content
proof are preserved. No cross-boundary evidence cache, scan-skipping or broader
multiple-base/publication policy from canceled work is included.

## Native content and conflict preservation

Task composition includes only the exact selected results and their supported
dependency/absorption authority. Foreign/unselected merge sides remain refused.
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

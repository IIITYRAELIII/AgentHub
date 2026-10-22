# REL-001 — Task-backed Workspace release

## Original stale-main recovery

ADR-0128 defines one narrow exception to generic terminal refusal. Existing RM
continuation may bind separately verified current main pins to the original
failed compose operation, after exact revision CAS, current selected/prepared
source verification and original publication not-applied proof. Original
authorization, terminal attempt, immutable generations and all receipts remain
history; `reviewedMain` and the recovery event are appended by the same store.
UNKNOWN/partial/applied/live/source-owned effects refuse. No work executes inside
rebinding; ordinary composition and publication guards still own the next attempt.
New publication freezes persist both the public semantic version and the
canonical next runtime artifact version in their existing immutable manifest and
freeze intent. This observation reserves nothing. The original generation runner
passes the exact operation/generation/commit/artifact version to the existing
artifact owner, whose installation lease compares that expectation before any
preparation or allocation. A competing allocation refuses rather than retargeting
the frozen input. Freeze retry and lost-reply artifact reuse retain the original
version. Historical generations lacking this field keep their original executor
identity; they are not rewritten or granted a new packaging receipt.

## Semantic public version and original build (ADR-HUB-334)

New installer publications migrate recognized calendar versions to public
`2.0.0`. Later compatible corrections use patch, compatible features minor,
and changes to supported interfaces/update compatibility major. The existing
freeze accepts `releaseType` (`patch` by default, `minor` or `major`) only for
new intent; an admitted freeze always reuses its saved version. A selected
prerelease can stabilize without changing its core. Stable public discovery
continues to refuse prereleases; this does not introduce a beta update channel.

Full publication uses that same freeze owner and passes its original expected
version into committed-metadata validation. Validation/retry never selects a
next patch; absent original expectation refuses without writing metadata. Core
and build numbers use the same ASCII-only grammar in producer and recipient.
Full publication also binds the same immutable artifact version and source head
before stages. Android consumes that artifact as its code/name input; runtime
deploy passes its original expected version and source to the existing lease
owner. Neither stage allocates an independent semantic build.

Public version, internal releaseId and artifact version are distinct. The new
artifact is `<publicVersion>+build.N`; manifest and package descriptors also bind
`versionScheme: semver-build-v1`, `publicVersion` and integer `buildNumber`.
The UI displays `<publicVersion> · сборка N`. Public tags use the public version
(first stable installer `2.0.0`), not the artifact identity containing `+`.
The existing exact four-field runtimePublication and nine-field PREPARED receipt
keep `version` as the complete artifact identity. No receipt is enriched or
rewritten and no second allocation ledger is introduced.

The existing retained-manifest allocator observes all recognized builds and
verified retained Android codes, with the existing epoch-minute floor on a new
freeze. Its next N is at most 2,100,000,000. Freeze is an observation, not a
reservation. Under the same installation lease, preparation compares again
against retained allocations using original N minus one as its frozen floor,
so elapsed wall time cannot allocate a new build. A competing allocation,
unknown/foreign manifest or partial retained allocation refuses and preserves
evidence. Original artifact reuse happens before new preparation. Android takes
versionName from the same public version and versionCode from the same frozen N;
its builder does not allocate another semantic build.

The recipient verifies current and candidate manifests before ordinary update:
recognized calendar identity may migrate to semantic major 2 or later; semantic
precedence may not decrease and build must increase. SemVer build metadata alone
has no precedence. Exact byte-identical reinstall is idempotent; explicit
verified previous-runtime rollback retains its separate existing owner. Unknown
metadata does not authorize downgrade. Config/data/enrollment, signer/package
identity and stopped-writer checks remain mandatory. Old calendar receipt
read/retry remains supported at its original checkpoint; it is not authority
for a new calendar downgrade after migration. The release publisher must refuse
overwriting a previously published public tag with another build.

## Frozen standalone artifact preparation

The existing publication artifact checkpoint may bind an explicit original
operation/generation/source and runtime artifact version. Canonical preparation
checks that version against its next suffix under the same installation lease
before copying, compiling Host or installing locked dependencies. A different
result refuses instead of changing the frozen version or manifest. Publication
version remains distinct from the runtime artifact version.

The packager's PREPARED receipt is derived from that same hash-pinned artifact
and verified runtime, not from a second allocation or acceptance owner. Reuse
validates the original source/version/manifest and complete payload before any
new preparation. A lost preparation reply may reuse its verified completed body;
a partial body without a manifest or changed inputs remains preserved/refused.
This receipt grants no Git, installation, restart or remote publication authority.

## Native transport retirement (ADR-0126)

New native merge transport contains exact selected base/result ancestry through
private advertised bundle tips, including dangling accepted inputs, without
copying all unrelated source refs or mutating source configuration/refs. Git
streams its complete pack into an already-owned output descriptor; no bare pool
or recursive temporary-directory deletion is used. A failed/partial output and
any plain/reparse replacement are preserved. The consuming clone has no
alternates and remains independent.

New permanent release-generation transport likewise streams only exact local
main, approved base and selected result ancestry. Its advertised main alias is
bound to an included exact input so the existing main clone contract survives.
Ordinary initial release clones and workspace refresh fetch main only; missing
selected base/result commits still use the existing exact-object fetch path.
Existing generation transports are reused unchanged, including older broad packs;
partial/unknown outputs require original-owner recovery, not replacement. This
does not change composition selection, provenance, candidate fetch/freeze or
publication guards. Disposable composition validation uses the same selected
main/base/result transport and still returns only a read-only composition proof;
its existing invocation-local temporary cleanup and acceptance refusal remain.

After an update's normal runtime start, policy v1 may retire only the redundant
task-native-merge transport from a completed, durably published Task. The existing
Task Git lease/process guard and fresh cleanup preview remain authoritative. The
full clean independent capture must contain connected advertised object roots;
advertised names/OIDs remain in the existing durable cleanup intent. Its refs,
repository, merge journal, resolution evidence and Task results are preserved.
Unknown, incomplete, dirty, unpublished or changed artifacts remain pinned. File
retirement is handle-bound, exact-identity/hash checked and refuses extra streams,
hardlinks and substituted physical ancestors; no recursive deletion is implied.

Task worktree cleanup separately refuses ignored local files/directories even
when Git status is clean or dirty removal was requested. Their artifact owner
must prove retirement first. This includes useful WIP and dependencies without
an accepted retirement proof. Current/running/rollback/prepared runtime/source
roots, release generations, legacy archives and persistent evidence receive no
new deletion authority from the storage scheduler.

The runtime installation owner separately supplies policy v2 exact retirement
custody in its existing current.json pointer. Installation preserves unrelated
prepared bodies and defers deletion. Only known selected custody that leaves
current/rollback may retire; legacy versions are not adopted by name or age.
The same physical-root installation lease covers prepare/install/rollback and
retirement. Current, rollback, running and prepared-source dependencies remain
pinned before each native batch. The existing maintenance child is recorded in
that retired binding before effects, and known partial work resumes only that
original operation/root/manifest. Unknown data or custody stays retained; no
recursive directory-removal fallback or Task-publication effect is granted.

Policy v3 may retire only a redundant generation source.bundle after the original
ReleaseOperation proves its exact current generation done, applied validate/finalize
inputs and published outcomes for every approved target. The marked full independent
clone, frozen checkpoint/manifest and advertised locally connected object roots,
anchored in retained refs/HEAD against later ordinary GC, must
match that generation. Shallow/partial/alternate-backed, dirty, incomplete, failed,
waiting, superseded or UNKNOWN captures remain pinned. Prepare, discard and bundle
retirement share the existing generation lease. The same native exact-file transport
custody applies; the repository, refs, generation body, evidence and all ignored WIP
remain. This is not a new release, Task cleanup, recursive deletion or age policy.

## Current corrected candidates and historical release facts (2026-10-14)

A new candidate is admitted from the exact CURRENT normally accepted results.
Historical `selectedResults`, terminal predecessor state, reserved startup
selection or generation number do not authorize or veto the new selection.
The ordinary preparation/compose/reservation owners bind the current exact set,
version, entry and candidate. A later accepted correction uses that same normal
lifecycle. Terminal attempts remain immutable history; a normal next operation
needs reconciled actual effects and one publisher, not another manual release GO.

An observed OWN published commit is a historical fact: the immutable original
Workspace/authorization, validated generation, descriptor and exact observed
commit prove it independently of the operation's later state or selected result.
This read grants no acquisition, readiness or target-effect credit. Actual
publication readback precedes a new attempt; UNKNOWN or live custody cannot be
reclassified as no effect. Foreign origin commits still require explicit review.
The previous version and consolidated entry may be retained from archived freeze
evidence; the new artifact has its own immutable identity and current acceptance.
Special predecessor-selection equality and stopped/startup successor admission
routes in ADR-0108–0110 do not govern new ordinary attempts after this correction.
Their old immutable records/receipts remain supported historical readback only.

A denied native/execution acquisition stops that worker; temporary owned refusal
uses a bounded timer and normal wake. SQL writer fences remain in force. Exact
published/healthy Task delivery is persisted before optional dev synchronization;
unpublished foreign dev is preserved. Pending sync/cleanup remains explicit and
prevents the release service operation from being called fully complete.

Optional malformed/missing archive entries are diagnosed per entry, including the
startup Git-reconciliation read before legacy import. Their evidence is preserved
and never credited as readiness. Unrelated database/admission errors propagate.
Installed Task Test capability is not publication authority and cannot veto an
independently accepted source publication owner. Current authorization, runtime
identity, candidate and exclusive publication lease still determine execution.

The user explicitly authorized immediate direct production hotfix of these
confirmed defects outside the broken release lifecycle. This exception permits
normal install/start and restart for the exact independently reviewed hotfix;
it does not falsify old receipts or claim the main logical release complete.


When a current native generation has already advanced origin during partial
publication, the unchanged retained selected Test descriptor may be reused for
ordinary correction acceptance only if the read-only release owner proves that
same descriptor in both its immutable generation selection and candidate manifest,
with exact authorized membership, current generation, native composition policy,
published base, applied validation receipt and origin equal to that candidate.
An unrelated origin, replaced descriptor, stale generation or ordinary operation
does not satisfy this exception. The old Test receipt, publication baseline,
operation, generations and partial effects remain unchanged. This is historical
proof reuse, not runtime readiness, effect reconciliation or permission to adopt
a new main base. Current explicit main/preflight and publication gates remain.

The same read-only descriptor witness also recognizes terminal failed native
startup-correction history when its independently reviewed immutable record
proves the exact prior OWN publication and an unpublished reserved successor.
Original authority, recovery and correction binding hashes, prior candidate and
validation, applied PARTIAL startup readback, successor composition and selected
set must agree; successor publication/finalization effects refuse this boundary.
The terminal operation is never resumed or changed. This interpretation exists
only while these retained historical Test descriptors require normal correction
acceptance; remove it when those originals no longer participate in release.

Native cutover after completed historical freeze abandonment verifies its
existing recovery outcome, immutable evidence/hash and exact restored prepared
ref. It retains frozen-original and recovery bytes in the new manifest; changed
proof or unrecognized ref movement refuses before promotion. Ordinary native
preparation keeps exact agreed local main. Historical adoption remains evidence
for its bounded recovery only.

The existing full-test runner prepares its checkout's tracked npm lock through
the existing dependency owner before starting validation suites. Frozen Git
generation clones contain no dependency tree. Preparation uses the same bounded
lock/physical-tree validation and matching-marker reuse as managed Task
dependencies, includes locked development dependencies and runs npm under its
dependency lease with publication capabilities removed. A preparation failure
fails the full-test stage before artifact or publication effects. This does not
change the prescribed pipeline, stage contract, frozen tracked content, version
or original operation; subsequent validation still runs every required suite.

## Installed local source baseline (ADR-0115)

Publication keeps the composition source base separate from the remote CAS base.
The existing sealed manifest/checkpoint provenance supplies the exact approved
origin (or the retained published baseline when no incoming was adopted).
Readback and the frozen Git publisher use that same remote pin. Before push,
both the source base and remote pin must be ancestors of the candidate; the
exact remote lease still fences fetch/push drift. Provenance mismatch refuses.
Publication validation children do not inherit a parent's replacement-startup
operation or launcher identity; startup guards remain unchanged.

The user's authorization of a local repair and its release includes a one-time
transparent migration of already installed local source. It does not authorize
new external origin code. `installed-local-source-v1` retains agreed local main
and the durable OWN publication as separate identities; it never moves primary.
The exact source base/tree/binary patch, current installed release/manifest,
plan revision and selected Task IDs/revisions/registered bases/results are pinned.
Origin must equal that OWN publication unless the exact selected Task has a
current ordinary upstream-adoption receipt for the separately pinned approved
origin (ADR-0117), or the envelope binds origin to the exact already agreed main
with an actual empty adoption array (ADR-0121). The latter requires current main
and origin equal that pin, OWN publication ancestor of it, agreed main ancestor
of retained installed source, and the same complete installed/source proof.
No equal-main adoption receipt is created. Missing origin fields retain the
original publication pin; foreign origin, non-array or substituted empty
authority refuses. A sealed envelope never switches modes after drift.
OWN publication remains an ancestor of the local source base.
Missing, substituted or changed pins refuse before promotion.

The existing RM-only `hub_release_prepare` repository envelope may carry
`localSourceBaseline` and `nativeResolutionReview`. Both participate in its
original argument hash, source closure and existing terminal receipt. The
former has exactly schemaVersion=1, kind=installed-local-source-v1,
publishedBaseCommit, agreedMainCommit, sourceBaseCommit, sourceBaseTree,
sourcePatchSha256, installedReleaseId, installedManifestSha256, planRevision,
selectionHash. The latter has only requestId/text and uses the existing exact
authenticated native merge review verifier; it supplies no caller approval flag.
Ordinary Await still accepts the exact reviewed Task through its existing owner.
When selected ordinary adoption receipts coexist with installed local source,
the existing Task owner returns their exact historical pins and the candidate
owner derives the same full installed-source proof before composition. Await
passes that sealed provenance through its existing base and terminal CAS checks;
it does not depend on a later preparation that requires Tasks already in Await.
The same ordinary derivation runs without new receipts when agreed main differs
from publication, preserving the already-agreed-origin mode through Test and
Await. Without an installed runtime the no-adoption route returns no migration
envelope; selected incoming receipts still require their installed proof.
The candidate's internal authority closure reaches the lifecycle's final
persistence callback and runs immediately before the owning Task commit, after
awaited persistence admission. That closure rechecks source/adoption/origin,
followed by the existing process guard and lease assertions. Ordinary derived
proof receives this boundary as well as original Await recovery; it is not a
public caller flag. Failure preserves the original rollback/unknown semantics.
For empty already-agreed-origin authority, the existing owner repeats the exact
primary main/origin pin AFTER awaited native history/composition validation,
including promotion, prepared reuse and Test/Task terminal fences. Earlier
installed physical verification does not replace this final origin check.
Historical pins do not authorize promotion after origin drift. Explicit
preparation and generation reuse retain their existing bound-envelope rules.

When approved incoming and installed local source coexist, the same envelope
additionally binds both `approvedOriginMainCommit` and `adoptions`. Each adoption
has the existing exact taskId/resultCommit/recordRef/recordHash/adoptedCommit/
acceptedLocalMainCommit fields. All receipts name selected exact snapshots and
the same approved origin. The normal adoption owner remains the only writer;
read-side verification proves current main, Task base/branch, canonical blob,
bounded first-parent merge proof and trees. Origin, receipt, source and installed
pins are repeated after awaited caller validation, before promotion/Task CAS,
prepared reuse and freeze. This does not adopt future origin or move primary.

Native metadata validation distinguishes inherited metadata from Task edits.
CHANGELOG entries must equal a complete Git mode/blob entry at the registered
Task base, verified installed source or that Task's explicitly adopted commit.
An explicitly verified installed-source base may incorporate later agreed main
metadata. Its existing owner also retains the installed manifest's exact source
revision as a metadata base: the hash-pinned manifest, unchanged clean source
HEAD and ancestry into the verified new base must all agree. This grants no
arbitrary historical revision or caller-supplied authority. Ordinary exact
path/mode/blob and package-version rules still apply; merge-side authority,
selection and Task acceptance remain unchanged (ADR-HUB-321).
Metadata paths use raw NUL records and literal pathspecs; quoted presentation
names, malformed or ambiguous tree lookups grant no inherited identity.
Existing package versions must match one of those same sources. Arbitrary Task
notes/version changes and unknown merge sides still refuse. Only exact verified
installed/adopted ancestry is excluded from bounded Task history. Test may also
recognize its already managed dev ancestry for preview integration; publication
never consumes that dev context and independently checks the selected set.
Test persists its proof in its existing native intent and repeats it through
terminal/recovery checks; no new ledger, authority flag or recovery loop exists.

Affected regression: `node --test tests/infrastructure/filesystem/native-installed-adoption.test.mjs`.

The candidate owner verifies changed runtime paths against actual immutable
installed bytes and Git source, allowing only built-in CRLF/LF text serialization
and exact Git LFS object identities. Documentation/tests are non-runtime source.
Compiled Host provenance applies only to its four exact supported build inputs
and verifies both retained originals and the physical bounded regular Host
executable against its required manifest record. Other RuntimeHost paths refuse.
Uninstalled executable changes, absent provenance or compiled artifact, foreign component changes,
unsupported deletions or missing retained Host inputs refuse this bounded route.
If the retained source inherits repository files outside `AgentHub/` that differ
from the older OWN publication, its COMPLETE outside path/mode/object set must
equal the exact agreed local main. Bounded raw NUL Git inventories compare literal
bytes, including non-ASCII names; missing, additional, substituted, duplicate or
malformed entries refuse. Those unchanged repository files are not runtime carry
and are never read or executed as installed source. This does not grant upstream
adoption: the existing exact selected adoption/origin checks remain mandatory.
See ADR-0120.
The bound is 512 changed paths, a 4 MiB binary patch and bounded regular files.
No installed-file overlay, selected Task expansion or rolling-dev import occurs.

Native selected merges, complete tree checks, existing locks/CAS and rollback
remain authoritative. An unresolved native conflict in the preparation owner's
private checkout is a
definite pre-promotion refusal, retaining its issued root and paths for exact
reviewed resolution. It does not change the prior candidate/checkpoint or turn
an uncertain post-effect failure into rejection. The baseline is rechecked at
preparation precommit and
inside freeze before ref CAS. Generation capture retains the complete provenance
without replacing it; changed plan/selection rejects reuse. Preflight verifies
the sealed native manifest, whose registered Task bases are not present in the
plan's display projection. Unknown outcomes remain on their original receipts.
No extra writer, recovery registry, Task transition or publication is introduced.
The migration is unnecessary after verified publication/main synchronization
contains that source; it grants no authority to future selections or origin code.

## Explicit preparation-only recovery (ADR-0104)

`hub_release_prepare` is an authenticated Release Manager-only preparation
command through the existing durable MCP receipt owner. It accepts exactly
`{context_token, request_id, preparation}`; it cannot select Tasks, transition
their status, replay an original Await, run release validation or publish/install.
Its distinct original request binds the following strict versioned envelope:

| Field | Required identity |
| --- | --- |
| schemaVersion | 1 |
| planRevision | Exact current accepted plan revision |
| publicationHash | SHA-256 of canonical complete publication state, including generation |
| sourceCommit, sourceTree | Reviewed source provenance, verified by the frozen loading packet |
| sourceClosureHash | SHA-256 of canonical sorted fixed-root source inventory |
| tasks | Every accepted Task: taskId, rowRevision, taskRevision, baseCommit, resultCommit, projectRoot |
| repositories | Every selected repository: projectRoot, approvedBaseCommit, publishedRevision, primaryMainCommit, originMainCommit, checkpointHash, manifestHash, preReleaseHead, tree, approvedTree |

Commits/trees use 40 lowercase hexadecimal characters; digests use 64. Task
editorial `rowRevision` and release `taskRevision` are distinct. Sets must be
unique and complete, at most 128 Tasks/eight repositories/48 KiB. Unknown/missing
fields reject. Source inventory includes every regular file under runtime
`src` and top-level JS/package entrypoints, with normalized relative path,
raw length and SHA-256; links reject. Bounds are 4096 files/32 MiB. This is an
explicit preparation check, never a snapshot/startup/background scan.

The existing Await -> selected Task -> repository ownership encloses fresh plan,
rows, publication, agreed main, approved origin, raw checkpoint/manifest/ref/tree
and source checks. The native candidate owner verifies bounded ordered selected
histories and compares the complete composed tree with the independently reviewed
`approvedTree`. Native Git materializes the candidate. The registered-base owned
union remains historical ADR-0104 behavior and grants no authority in this route.
CHANGELOG remains release-owned. No effective-dev fallback replaces missing proof.

The original ID and arguments/source/publication/checkpoint fingerprint are
bound to the existing manifest/checkpoint envelope. Before candidate commit and
before ref CAS the original guards run again. Existing expected-head rollback
remains live until the same MCP receipt owner commits a bounded exact result.
All selected row CAS and genuine RM authority are rechecked synchronously inside
that SQLite terminal transaction. Selection, source/base/status and original
successful Await receipts are preserved.

`hub_release_prepare_get` requires `preparation_request_id` plus
`expected_arguments_hash` and genuine RM context in the same Workspace. It
returns only that original receipt and its exact terminal identities. Duplicate
success returns the same receipt without composition. Response loss after
terminal persistence is recoverable by that readback. Missing terminal or
ambiguous persistence remains UNKNOWN; no newer checkpoint, timeout or absent
lock settles it or authorizes automatic Git replay.

ADR-0130 adds explicit same-original `hub_release_prepare_resume` using the
original `request_id`, `expected_arguments_hash` and exact
`expected_preparation_revision`. It creates no second MCP intake or journal.
The existing MCP row holds the original envelope, fixed source root/custody,
revision and bounded owner stage. Only the existing Await -> Task -> repository
lease boundary may checkpoint or resume it. The immutable original argument
hash, caller and source closure remain binding; a newer approved mechanism may
read that retained original closure without importing it or relabelling it.
New attempts checkpoint `checking` before composition and `composing` before
admitting any candidate effect. A caught pre-compose interruption records
`paused`. A lost checkpoint reply can leave `checking`; reacquiring the same
leases and exact revision CAS proves exclusive ownership before resumption.
Current plan/rows/publication and candidate/main/source guards still apply.
Main audit is not repeated or credited as no effect by resume. Bootstrap of
accepted main into dev is a separate normal lease/CAS operation and never
settles a preparation receipt.

`composing` and provisional `terminal-intent` do not authorize replay. Candidate
rollback remains live until the terminal transaction, so even a saved proposed
result cannot turn an ambiguous terminal write into success. Only the existing
successful original receipt supplies terminal readback. Legacy originals with
no owner stage retain UNKNOWN and report the exact missing checkpoint; a later
bootstrap, absent candidate, timeout or current refs cannot reconstruct it.
No automatic startup recovery, original-ID replacement or SQL override is added.

Affected commands:
`node --test --test-name-pattern=preparation-only tests/application/hub-mcp-service.test.mjs tests/application/release-preparation-admission.test.mjs tests/infrastructure/persistence/workspace-catalog-store.test.mjs` and
`node --test --test-name-pattern="restored preparation" tests/interfaces/cli/initial-native-test-cutover.test.mjs`.
Old reviewed invoker bytes are immutable. The extended source closure receives
one affected review and a separate concrete fresh RM operational disposition
before live loading/effects.

## Native Git composition cutover (HUB-303)

Delivery of an independently reviewed native owner before installation uses the
bounded initial-native-test mode of the existing task-await-cutover CLI. The
assigned current caller may move its exact Progress/empty-ref Task to Test;
source commit/tree/branch/clean managed ownership is checked before stores and
under the existing Task/dev/Await owners. The original status arguments and
durable lifecycle/native intent bind main/dev, publication, exact current
candidate/checkpoint/manifest and current plan. SQLite admission and terminal
CAS fence the current caller/active Thread, assignment, empty refs and repository
settings. Test preserves the existing candidate and accepted membership; normal
Await remains the prospective native composition owner. This is a one-shot
delivery bridge, not a new status service or installation. Verified active native
installed status capability closes new bootstrap admissions; historical original
readback and UNKNOWN reconciliation remain available with no second dev CAS.
Old receipts and already prepared full composition are never rewritten to make
the first-run guard pass.

The same bounded source entry represents ordinary Test after normal return of a
previously accepted result. Its explicit returned-result identity equals the unique
retained ref. The existing SQL owner binds successful Test and latest normal-return
originals, revisions and immutable outcome hashes; admission and terminal SQL
recheck them. Git requires the corrected source to descend from that exact result.
Caller-supplied receipts, cleared refs and arbitrary merge sides grant no admission.
UNKNOWN retains this internal binding and original dev intent; terminal readback
remains available after installation closes new bootstrap admissions. Normal Await
creates the corrected selected composition.

Published-resolution identity normalization belongs to domain; filesystem proof
verification re-exports the same function for historical recovery and owns Git I/O.
MCP timing is a callback supplied by composition from the existing timing owner,
sharing one async trace context across application and Git spans. Application
services do not import filesystem proof or process timing adapters.
The initial and returned native source entry enters that same existing Task
operation trace before lifecycle admission and lock waits. Success and refusal
both retain the original operation/Task identity and bounded trace summary;
diagnostics cannot change admission, receipt or Git outcomes.

The ordinary path is `main-selected-git-merge-v1`. Task branches, dev and
PreRelease start from the agreed repository-local main. Each selected exact
reviewed result is merged with native Git into an isolated Hub-owned checkout.
Git owns merge ancestry, index, checkout, modes, add/delete/rename and EOL.
There is no ordinary effective-dev replay, net projector, cherry-pick fallback,
synthetic aggregate tree or selected-composition per-file writer.

Native merge staging imports source objects/refs through a Git bundle, then
performs ordinary clone/checkout and proves each exact input commit exists.
It does not invoke upload-pack against the primary's local configuration,
disable Git clone protection or copy source hooks. Mandatory team hooks and
the primary's config/HEAD/worktree remain unchanged. Bundle transport grants
no selection authority; the same bounded history, merge and CAS fences apply.
The export explicitly includes every exact base/result object already admitted
by the owner, even when imported into an intermediate clone without a local ref.
Ref reachability in that clone is not a new selected-result prerequisite.

Dev is preview only. The exact accepted set and its required descriptors remain
Hub authority. Test-only branches are excluded. A result's bounded first-parent
history (at most 512 commits) must start from accepted main; an unselected merge
side is refused. An explicitly accepted absorption is admitted only through its
exact ordered parents and the existing authenticated saved/stopped handoff,
durable selected receipt and bounded source history. A checklist link, equality
of trees or caller-supplied flag cannot authorize a foreign merge side.

A fresh absorption Test accepts selected_absorption_handoff alone: the existing
authenticated saved/stopped inter-Stream receipt, exact transferred requirements,
source/survivor identities and CAS are checked under both Task leases. Its native
original intent binds the same input; live source Git and durable ownership are
rechecked before dev CAS and terminal Task CAS, including UNKNOWN/reopen. The
successful outcome seals native-task-integration-v1 required selected evidence,
carried unchanged through plan/manifest/generation and historical readback.
No legacy selected preview, bundle/materializer or arbitrary merge waiver is used.

Previously integrated source and survivor must return through the ordinary lifecycle.
Their accepted refs stay intact. Existing successful Test and normal-return outcomes
bind each prior result, repository, revisions and original operation IDs into the
authenticated absorption input; exact outcome hashes are rechecked at admission,
recovery and terminal SQL. Git proves each prior result is retained by its declared
source or survivor parent. Missing, stale or foreign prior bindings refuse.
Combined closure verifies the sealed native result and exact current source.
A previous separate source dev integration is retained only when its side parent
is covered by that source's bound returned result and the integration predates
the combined Test's exact dev parent. Unproved separate integrations still refuse.

Ordinary Test uses an isolated native merge from current dev and its exact Task
result. A conflict leaves MERGE_HEAD, stages and automatic entries there; shared
dev and the last accepted candidate remain intact. The executor uses normal
Git add/commit. Continuation verifies exact ordered parents and a clean checkout.
Necessary compatibility changes on automatically merged paths require the exact
independent inter-Stream ACCEPT receipt, bound through the existing catalog to
the complete reproducible merge diff, ordered selected inputs and final commit/tree.
No path allowlist or caller flag authorizes extra bytes. Missing review, changed
parents/selection/diff/tree or post-review amendments refuse. Ordinary resolutions
without additional automatic-path changes keep their existing behavior. The same
binding is retained and rechecked by native Test, Await, prepared generation and
historical readback; old receipts remain unchanged. See ADR-0108.
A failed original remains
failed; a subsequent Test is a new request using that saved resolution. An
uncertain CAS or SQLite terminal write stays UNKNOWN on its original identity.
Reopen rechecks exact source HEAD/base/branch/cleanliness/process ownership and
dev checkout under the existing leases before terminal persistence. Restoring
the exact source permits the same original to finish with no additional Git CAS.

Await recomposes the current selected exact branches from agreed main. Native
checkout in the exclusive Hub-owned clone precedes ref CAS and is guarded by
native index/worktree readback. No reset --hard, force checkout, clean or custom
physical-byte serialization may overwrite a busy checkout. Ignored/private
collisions are preserved. Known Task-CAS refusal restores the previous candidate
and exact checkpoint bytes through native checkout; an unproved effect retains
the original journal and foreign bytes. Locks cover preparation and CAS only.

The existing ReleaseOperation remains the publication owner. Public RM routes
are hub_release_plan_get, hub_release_run, hub_release_get and
hub_release_continue; public preflight/reconcile/complete writers are absent.
The immutable CandidateGeneration/version/CHANGELOG freezes, not Tasks or
executors. Corrections and later Await selections create later generations;
network/QA/publication do not reserve Task leases. Existing target authorization,
Git/SQLite CAS, original-ID receipts, exact result finalization and external
effect recovery remain mandatory. Source acceptance never authorizes production.

Publication generation captures the exact clean prepared native PreRelease
commit/tree, manifest and checkpoint hashes, selected results and base under the
existing Await/repository owners. It imports that commit through native promotion
into the immutable generation; it never recomposes selected tips during publication.
Accepted conflict resolution commits remain ancestors. Only the existing freeze
owner changes version/CHANGELOG metadata. Native history admission also compares
existing package/lock root version fields; dependency edits with an unchanged
release version remain Task content. Missing or stale prepared selection, result,
base or evidence requires normal candidate preparation and explicit retry.
The original generation identity pins this capture; lost responses reuse its
promotion journal and freeze payload without rebinding or another Git merge.
Stale prepared refusal leaves the same ReleaseOperation waiting at compose;
normal preparation and continue reuse its authorization and original identity.
Only a dirty CHANGELOG whose regular-file bytes equal the immutable release
authorization may accompany capture; other dirty files and unbound notes refuse.

The agreed-main-native-git-v1 provenance records agreed main separately from
durable published history. A newer remote observation cannot replace main.
Preparation checks those pinned local/origin identities under its existing Git
lease. Its preflight callback must not reenter the same release Git lock through
an inspection call; the holding owner performs that fresh read before promotion.
Known main/publication divergence stays explicit; this cutover does not silently
initialize publication, adopt upstream, push or rewrite main.

Cutover preserves the previous exact head/tree, checkpoint and manifest bytes,
hashes, Task source identities and required descriptors in the existing immutable
manifest, plus a retained ref in the owned release clone. Original main-based
results need no mapped commit. Historical genuinely mixed branches require
explicit migration evidence and fail closed; there is no guessed permanent
projection. The new tree may contain agreed main context absent from the old
published-base candidate; that difference is disclosed, never called equality.

Selected materializer v1/v2 are recovery-only for originals already admitted
before cutover. New admission through their preview is closed. Explicit intent,
receipt and actual record versions must agree; a v2 seal or capture cannot be
reinterpreted as v1 through paired header downgrade. Genuine v1 recovery retains
its pinned implementation; v2 preserves the sealed Git/physical identities and
source fences. Historical sealed readers do not impose today's checkout config.
Remove legacy writers only after all supported old originals are durably terminal;
retain their historical readers, receipts, bundles and frozen identities while
those histories remain supported. No old UNKNOWN is replayed with a new original.

A retained historical own-conflict projection reads the exact published
resolution commit and its parent, bounded by the saved own-plan paths. Missing
published resolution evidence fails closed; the original Task tip cannot stand
in for that resolution. This reader does not authorize new net composition.

This section and ADR-0106 supersede the ordinary composition algorithms in the
historical net-projection, effective-delta and materializer sections below.
Those descriptions apply only to their pinned pre-cutover evidence/recovery.
They do not expose old public tools or new admission. Policy remains one builtin
owner, with opaque authored rules preserved (ADR-0066). Tasks with independent
outcomes may share one agreed release; duplicate/inseparable outcomes use normal
saved-work transfer and combined closure, not a file-overlap heuristic.


## Advisory Task operation timing

Ordinary workflow transitions emit bounded, payload-free stage timing under the
original operation and Task identities. Await admission, Task/repository lock
wait, preparation, snapshot, ancestry, Git children and lifecycle persistence
remain inside their existing owners. Durations are monotonic; start records
make an unfinished stage visible. Child/lease detail is capped at 512 spans per
operation, with a suppression count; workflow and major stage outcomes remain
visible. Diagnostics use the existing rotating runtime log, never authorize a
transition or retry, and sink failure cannot replace the operation's outcome.
Git arguments, stdout/stderr, source content, credentials and lock tokens are
not diagnostic fields. These measurements do not assert that historical slow
operations had the same cause as an isolated reproduction.

## Task preparation and definitive validation refusal

Test delegates preparation to the snapshot owner instead of preparing the same
Task twice. Previous result references are resolved against the canonical
repository root. Bounded ancestry traversal batches merge-parent reads while
retaining publication/adoption and lease checks. An explicit ancestry refusal
becomes a terminal integration rejection only after the lifecycle owner reads
back its exact failed transition, proves no successful outcome and still owns
the lease. Persistence failures and ambiguous effects remain unresolved.
See [ADR-0081](../decisions/ADR-0081-task-git-terminal-refusals.md).

## Bounded plan reads

Only non-archived Await Tasks require Git evidence during release planning.
Prospective acceptance first projects its exact Test-to-Await CAS and then uses
the same filter. Draft and legacy done-audit metadata remain available without
revalidating their Git history; plan hashes and selected-result validation are
unchanged. Reading the plan observes an existing dev ref without preparing or
repairing a worktree. See ADR-0080.

## Durable release operation (HUB-260, 2026-09-22)

One authorized release is one durable `ReleaseOperation` owned by the application
service. Its immutable `CandidateGeneration`, per-stage `StepReceipt`, exact
accepted results and per-target publication effects are stored in SQLite. The
working state is `compose → validate → publish → finalize → done`; `waiting`
names a concrete resume state and condition. `hub_release_run` persists the
authorization and returns the operation ID before tests, Git, deployment or
finalization. `hub_release_get` is read-only. `hub_release_continue` wakes the
same operation and never creates a replacement identity.

Await is the current live PreRelease integration, not membership in every active
release. A ready generation remains immutable while Task work continues. A
failed validation permits a reviewed correction of the same selected Task; the
owner composes generation N+1 by native merge of exact selected branches
from the agreed main. It does not merge rolling dev into the candidate.
If publication has begun, generation N finishes by its exact identity and the
correction belongs to a later generation or release.

Returning Test/Await work to implementation preserves its accepted result and
historical dev integration. A correction is a descendant or explicit correcting
result; withdrawal/revert is a separate requested operation. Finalization writes
delivery evidence for the exact published result and marks Done only when the
Task still names that result. A newer result or workflow transition is never
overwritten by an older generation.

No prepared, freezing, frozen, failed or awaiting-finalization snapshot blocks
Task edits or Await acceptance. Await preparation serializes under its
Workspace/Task/repository locks (ADR-0079); release validation and publication
do not hold those locks across tests, network or deployment. A timeout or process death with a
possible external effect is reconciled by exact readback before retry. Partial
multi-target publication preserves its effect vector and continues only missing
targets. External unavailability is a visible condition with durable backoff,
not a request for generic manual resume.

Await acceptance reuses the repository's existing live PreRelease clone.
Workspace Await -> Task -> repository locks serialize preparation and the exact
Task CAS, including unknown-outcome recovery and cross-Task cutover. A waiting
acceptance reads the current accepted set after acquiring those locks. It does
not create or promote an operation-scoped temporary clone. The existing Git
owner retains the previous candidate ref, checkout and checkpoint until both
composition and the Task CAS succeed. A proven rejection restores them; an
ambiguous commit or rollback preserves evidence for the original operation.
Dirty release worktrees are rejected without overwriting local files.
This serializes simultaneous Await transitions, not ordinary message handling.
See ADR-0079. Publication generations retain their separate immutable lifecycle.
Immutable operation generations remain available while their operation is active,
waiting or has an unknown external effect. After a terminal outcome, the durable
operation, receipts and generation identity remain in SQLite while their owned
filesystem generation roots are removed.

When a selected Task replaces a result already captured by the operation, the
new result must descend from the prior result. An unrelated result raises the
typed `RELEASE_RESULT_LINEAGE_MISMATCH`, returns that same selected Task to its
executor through the canonical lifecycle owner, and leaves the release operation
waiting for a reviewed descendant correction. The corrected exact result
replaces obsolete bytes from the prior result while preserving neighboring
selected Task projections.

The public release command names the initiating Stream and Thread explicitly.
It also binds the exact prepared `CHANGELOG.md` bytes and both raw and LF-normalized
digests into the immutable authorization fingerprint. Generation composition
replays those bytes before freeze; it never substitutes publication metadata
from the stable runner checkout or an older repository snapshot.
The durable metadata envelope carries a bounded source path, byte length and raw
plus canonical digests rather than base64-expanding the document through the
control transport. Composition re-reads and verifies the complete supported
repository release notes up to 8 MiB; callers do not truncate or summarize them.

An already imported evidence-only orphan checkpoint may later receive a
`primarySynchronizationProof` annotation from the primary synchronization owner.
Replay first checks the complete evidence hash. Only an unowned `waiting`
operation with `legacy_snapshot_evidence`, no resume state and no retry time may
ignore this newly added field, and only if removing that field alone reproduces
the original evidence hash exactly. The checkpoint and original stored evidence,
generation and operation remain unchanged. This never grants publication or
recovery authority. Any other difference still rejects import. Remove this
compatibility boundary when legacy checkpoint import is retired.

At cutover, old checkpoint and publication-status files are imported once as
immutable evidence. Only a status whose revision and owned release root match an
exact checkpoint activates recovery; a checkpoint without matching publication
authority remains evidence-only. Legacy writers and public preflight/reconcile/
complete routes do not remain independent authorities. The stable current
runner owns recovery and reads N−1 operations; candidate code supplies bytes and
declarations, not a replacement transition engine. See ADR-0073.

## Explicit reviewed-main composition base (2026-09-17)

Ordinary and automatic PreRelease preparation derives its base only from exact
repository publication authority and selected Task adoption evidence. A Release
Manager may instead invoke the explicit reviewed-main preparation path with
complete, unique, repository-scoped local and origin main commit approvals. The
owner audits those fixed caller-supplied commits against the current primary and
origin; observations never populate or replace an approval. It retains the last
published baseline, verifies the existing upstream-adoption boundary, and uses
the exact reviewed origin commit as the composition base only when the audit no
longer requires approval.

The immutable candidate manifest and checkpoint bind the published baseline,
approved local main and approved origin main as composition provenance. Plan,
publication and adoption authority, both reviewed main identities, and the
primary invariant are re-read before candidate commit. Missing, duplicated,
unrelated, partial or stale approval fails before promotion, and a drift failure
retains the previous candidate. This evidence authorizes candidate composition;
it does not declare the reviewed commit published, rewrite publication state, or
create an upstream-adoption receipt. Release preflight continues to require the
prepared base to equal the currently reviewed origin main.

Ordinary Await preparation may still advance its base through a selected Task
upstream adoption. Any candidate whose base differs from the durable published
baseline persists one immutable discriminated envelope in both manifest and
checkpoint: `explicit-reviewed-main-v1`, or `selected-task-adoption-v1` with the
published baseline, adopted base and each exact selected Task result, adoption
ref, blob, adopted commit and accepted local main from
`releaseBaseEvidence`. Candidate preparation and validation reject a missing or
foreign-baseline envelope before any clone, ref or checkpoint effect; freeze
independently rejects it and any manifest/checkpoint disagreement before its
effects; preflight rejects a missing envelope and re-reads selected adoption
authority for the adoption kind. A later approved preflight never retroactively
supplies missing candidate authority. Without a durable baseline for the
repository no advancement can be established and only envelope shape is
checked. A published-base candidate needs no envelope.

After a candidate is prepared or frozen, explicit preparation may add exactly
one newly selected correction Task while every previously selected Task result,
base and squash proof remains identical. The correction snapshot has exactly one
parent, its recorded Task base is an ancestor of that parent, and every path
changed from that Task base to the parent (including deletions and file modes)
must already match the prior candidate's tree. Without that exact representation
proof, preparation falls back to the full selected Task-owned net projection;
it never marks a partial correction as projected. With proof, the candidate
owner performs an exact three-way tree merge using the snapshot parent as the
forced merge base, the prior candidate as the retained side and the correction
result as the new side. This deliberately does not infer ancestry from the aggregate commit graph:
an earlier candidate may already contain the correction result as a merge parent
while still lacking one of its bytes after selected composition. A conflict,
non-descendant correction result, second membership change, changed prior result
or missing mandatory squash proof rejects reuse and preserves the prior
candidate. CHANGELOG and version bytes remain owned by publication freeze.
The correction delta is rejected if it changes CHANGELOG or package-version
metadata. See ADR-0085.

A registered Task base newer than the approved published base cannot rely on
effective dev replay: another integration may already carry the Task's bytes,
making its own dev delta empty or correction-only. The existing net projector
requires an exact bounded single-parent result lineage rooted at that registered
base, automatic uniquely owned integrations covering the latest result, and
unambiguous selected order. It projects only registered-base-to-result OWN,
excluding inherited main context. Unproved lineage, ownership, integration or
order refuses before candidate ref/checkpoint promotion. Previously approved-base
projection and proven incremental reuse retain their existing boundaries.
See [ADR-0086](../decisions/ADR-0086-migrated-registered-base-projection.md).

## Exact result coverage and absorption composition (2026-09-16)

A squash owner witness may classify a reviewed change as already satisfied only
for an explicitly hash-bound LF-normalization disposition. The producer and the
release consumer independently read the bound Git blobs and require one regular
file mode, unchanged dev entry, at least one CRLF-to-LF replacement, byte-for-byte
equality after that replacement, and no NUL, lone CR or remaining CR in the new
result or dev. The disposition does not authorize dev bytes: candidate content
continues to come only from the exact selected results and their selected deltas.
Without the disposition, a dev entry that kept the pre-transfer blob remains a
discarded owner delta and fails closed.

Every mandatory exact-result projection advances speculatively before ordinary
selected deltas are replayed in durable order. Multiple mandatory results advance
in their own deterministic order; each successful projection is then consumed
exactly once instead of being applied again at its historical dev position. A
failed advance restores the immediately preceding speculative tree, and the
candidate owner retains the last accepted PreRelease. The final commit is made
only after the complete selected composition tree and its pinned authority have
both been revalidated.

For a reviewed selected Test, its committed lifecycle outcome independently
establishes that the exact selected composition proof is mandatory. Planning,
integration evidence, frozen-task normalization, manifests and reconstruction
retain that descriptor and its content identity. Missing, changed or ambiguous
proof fails before successor reuse or candidate promotion; absence of a field
does not reclassify the result as ordinary. Duplicate, cache and lineage checks
bind the same proof as well as the result commit. Ordinary results without this
protocol retain their existing projection and reuse behavior.

The latest recorded Task result must be covered by that Task's uniquely owned
dev integrations before release acceptance. Merely finding the result somewhere
in dev ancestry is insufficient: another Task may have carried a later result
while this Task's integration still represents an earlier version. An owned
integration must carry the exact result. Even a later commit with an identical
tree requires ordinary Test integration for its new identity; tree equality does
not rewrite the result named by release evidence.
Existing already-published results retain their separate base checks. Missing
coverage fails with TASK_RELEASE_RESULT_NOT_COVERED; rerun ordinary Test for the
exact result rather than borrowing another Task's integration or a dev snapshot.

In release-enabled Workspaces, absorbed closure additionally validates the
prospective surviving result together with the current Await set through the
canonical composer. Lock order is Workspace Await, both Tasks, then repositories.
The Git callback passes its owned repository lease through to release evidence;
it must not reacquire that same lease. Preview and confirmation each repeat the
proof, which binds the plan, approved base and resulting tree. A changed selection,
base, source or survivor invalidates confirmation. A Test survivor is projected
as a future acceptance only; validation does not change its workflow status.

Validation invokes the existing prepareCandidate implementation in a fresh
temporary owned standalone clone. It never promotes or rolls back the live
PreRelease, edits its checkpoint, or writes readiness into Task rows. Normal
completion removes that temporary root. An interrupted process may leave only
its isolated scratch data; this is never release authority. The fresh proof does
not use prior frozen-checkpoint successor optimization: a result that cannot be
composed from current selected authority is refused rather than borrowing a
previous candidate. No full suite, test contour, build or publication runs here.

Agents must not merge rolling dev into Task branches. Joint compatibility uses
selected-result composition; explicit absorption and approved main updates keep
their existing workflows. After result, absorption or membership changes, verify
composition immediately. Source cards and history remain retained, and source
branches/worktrees remain until verified publication and confirmed cleanup.
Main/base movement requires renewed validation under existing approval rules.
This supersedes earlier permission to clean absorbed branches before publication,
without adding an automatic merge engine or a second ownership registry.
See ADR-0068.

## Conflict continuation and Blocked (HUB-235)

The accepted conflict workflow is agent-led Task consolidation (ADR-0049).
The policy calls this absorption: use it for duplicate outcomes or changes that
cannot reasonably be implemented, checked and released independently. Shared
file paths alone do not require absorption. Preserve source cards and history,
and keep transferred unfinished requirements open. See ADR-0065.
The Stream encountering the conflict takes over the other, surviving Task after
notifying its executor and confirming saved work and handoff. It transfers its
own requirements, checklist and useful results, merges its own branch into the
surviving branch, resolves conflicts and validates the combined work. Only then
does it close its own Task as combined, with a link to the surviving Task.
Task-local save and merge commits for this operation are authorized. Consolidation
does not imply publication or Done and requires no automatic consolidation engine.
Previously integrated results are superseded through the ordinary lifecycle;
the combined result has one surviving owner and is submitted for Test again.

A confirmed ordinary Test conflict retains the Task snapshot and the prior Task
status. Only after proving exact dev rollback and persisting/readback of the
failed lifecycle does the owner report a terminal conflict with paths, Task
result, dev revision and Task checkout. Failed rollback, lease loss, missing
durable evidence or a running child process remain ambiguous and never use this
classification.

The workflow status `blocked` represents suspended work. If dependent Tasks are
kept separate, the dependent Task normally waits for its prerequisite's release.
An explicit user instruction may authorize an exception, including consolidation;
an ordinary start request does not silently override the dependency. Only the
compact Blocked badge is red; the column and prerequisite text use ordinary
colours. Generic manually blocked work may have no prerequisite.

Automatic dependency cascades and original-dev conflict pins are removed.
A dependency refusal completes only the requested attempt and names the other
Task to handle first; it does not mutate that Task. Unknown Git effects retain
the original reconciliation path.

The agent creates a checklist in the surviving Task with one native linked item
for each absorbed, closed Task. Descriptions and unfinished checklist work are
transferred before closure. Return both old Test/Await results before merging,
commit the merge in the surviving branch, validate and submit that branch to Test.
Claim and launch preserve Test/Await/Blocked workflow status; binding a new turn
does not perform a return or accept a dependency override.

The optional hub_task_complete absorbed_into_task_id closes an unpublished source
without marking workflow Done or deleting its branch/worktree. Both Task locks
and the repository dev lock protect the proof: same Workspace, open tested
survivor, clean source and survivor, all source heads/results contained in the
survivor's exact Test result, and no independent source-owned dev integration.
Ownership excludes the survivor's own first-parent lineage, including legacy
fast-forward inheritance. Every source repository must be represented. The
confirmation token binds both Tasks and Git evidence; the durable completion
receipt records the surviving Task. Closed sources are excluded from the release
set. Ordinary claim cannot reopen them.

An already-published zero-own-delta duplicate uses the same lifecycle owner but
requires the explicit `absorption_mode=published_duplicate` Release Manager
request. It does not relax ordinary absorption's open/tested-survivor guard.
The source must remain open in the same Workspace, have a Hub-owned clean
worktree with no untracked paths, Git result, legacy adoption or squash evidence,
and its exact HEAD must equal repository-scoped durable publication, local main
and origin/main. The survivor must already be workflow/status Done, retain one
exact Test result per source repository, and that result must be an ancestor of
the same published revision. Clean or ancestral state without these identities
is insufficient.

A release service Task with no implementation result uses the distinct Release
Manager-only `completion_mode=published_release_service`. It may close only
after every checklist Task is Done and its exact result matches the immutable
manifest named by repository-scoped durable publication evidence. The owner
hashes the manifest bytes, verifies its Workspace and plan, and proves the
published commit remains in local and tracked main. Preview binds the
publication generation, manifest, selected result revisions and preserve-only
cleanup plan; confirmation rechecks them. No result is fabricated and its clean
managed worktree is retained. Publication, Task closure and cleanup remain
separate facts.

Preview binds both Task revisions, every source base/branch/HEAD, every survivor
result, repository-scoped published revisions, publication generation, explicit
mode and a preserve-only cleanup plan. Confirmation repeats the Git proof under
the existing Await -> Task -> repository lease order before lifecycle admission.
It closes only the duplicate Task row, records durable `absorbedInto` evidence,
attributes no result commit to the duplicate, and preserves its managed branch
and worktree. Therefore a failure after admission has no partial Git deletion;
retry of the same operation resumes the existing cleanup-phase transition, and
does so from its stored admission evidence before reading a newer publication.
A lost successful reply is recovered from the exact lifecycle outcome. Source
history or valuable artifacts are never deleted by this mode.

A sibling Task merge is not upstream adoption. The Git owner recognizes managed
Task heads and inspects their merge ancestry; an unknown upstream/dev merge
inside the sibling still requires its existing adoption evidence. Already
published ancestry is excluded using repository-scoped durable publication with
its generation, provided accepted local main is its ancestor and the published
revision remains an ancestor of tracked origin/main. A later remote commit does
not revoke that historical proof and is not thereby adopted. Every common
ancestor of a Task result and tracked origin/main must be contained in the
published revision or covered by exact upstream adoption evidence. This also
rejects unpublished single-parent remote history inherited by fast-forward.
Missing evidence, a remote rewind or divergence fails closed. Primary main and
archived Task adoption records are unchanged.

### Reviewed selected Task composition

An ordinary own-only result may resolve reviewed Test conflicts through the
same selected-composition owner without merging dev or changing its Task base.
This classification requires the immutable Task base to equal current accepted
local main, a nonempty bounded single-parent history (at most 256 commits), and
that exact base to be the unique Task/dev merge base. Its bounded net delta
supports only regular-file additions/edits and excludes CHANGELOG. Conflict
stage 3 must name the exact own edited blob. All non-conflict entries must equal
the automatic merge, and every materialized path must belong to the own delta.
Bundle, ordered proof parents, caller/preview identity, Task revision, current
dev/result, publication/remote and ordinary durable CAS/recovery guards remain
mandatory. This is not upstream adoption or authorization of a merge side.

An ordinary Test conflict proof does not approve a conflict against published
release bytes. The same owner may receive an optional
`ordinary-published-resolution-v1` input with exact Task/base/application,
bundle, publication revision/generation and remote bindings. It independently
recomputes the complete ordinary OWN and automatic published merge. The supplied
single-parent resolution commit must name that publication as its sole parent,
resolve exactly the actual owning conflicts with explicitly bound regular-file
blobs, preserve every automatic non-conflict OWN entry and preserve every
outside-OWN mode/type/blob, including CHANGELOG and Instructions. Additional,
missing, non-owning, rename, deletion and mode/type changes are refused.

The independently verified release tree, conflict stages, resolution commit
and input bundle hash are included in the existing proof/hash, original
lifecycle intent and receipt. The existing release net projector consumes that
full OWN commit against its pinned published parent. Missing proof with an
unresolved non-CHANGELOG published conflict retains the fail-closed guard.
Clean ordinary proofs and legacy joined proof shapes/hashes are unchanged.
No standalone tree, review flag or bundle is an installation or publication
receipt. See ADR-0093 and ADR-0095.

A saved, stopped Progress source may be absorbed into a Progress survivor
through the existing selected Test owner (ADR-0105). This narrow classification
requires an authenticated successful source-executor inter-Stream receipt whose
exact content binds both Tasks, source revision, shared registered base, source
commit/tree and ordered absorption parents. Current native unfinished linkage,
complete source requirements in the survivor, unchanged source revision,
executor/branch/base/result and absence of competing claims/transitions are
also mandatory; a checklist or caller approval flag alone is insufficient.

Both pre-absorption OWN histories and any survivor correction suffix must be
single-parent, end at their exact bound bases, and together with the unique
absorption fit the 256-commit bound. The absorption tree must equal the complete
conflict-free automatic merge of its ordered owning parents. Arbitrary side
merges, flattened snapshots or manually resolved absorption trees are refused.
Full registered-base-to-result combined OWN uses the same regular-file/conflict
stage, automatic non-conflict and outside-OWN guards as ordinary selected Test.
Publication conflict proof remains independently required when applicable.

Preview and distinct confirmation bind the same handoff. Both Tasks are locked;
the existing SQLite intent fences source edits, deletion, new claims and
competing transitions until that original becomes terminal. Current source,
durable handoff and publication inputs are rechecked before dev CAS and terminal
Task CAS. UNKNOWN remains owned by that original and cannot repeat Git CAS.
Already-applied/post-CAS readback and both normal and recovery terminal paths
must recheck source HEAD/base/branch, tracked/untracked cleanliness, process-tree
guards and the same durable binding under both leases. A raw applied catch
fallback cannot bypass this fence. Source drift after a committed Git effect
preserves private bytes and the original UNKNOWN; it is not NO_EFFECT. Exact
restoration allows that same original to settle with no additional Git CAS.
The full binding survives receipts, descriptors, readback, reconciliation,
release projection, mandatory-selected lineage and reuse. Release recomputes
immutable Git evidence and full combined OWN rather than a last effective-dev
delta; absorbed source closure remains the existing combined-closure lifecycle,
after verified canonical composition, and is not a Test side effect.

When accepted local main and the repository's published main have a unique
common base but neither contains the other, ordinary explicit upstream adoption
does not apply. A separate Release Manager-only selected-composition Test path
may use a clean managed Task result whose bounded first-parent history contains
exactly one merge side already included in the exact published revision. The
current publication generation/revision, live remote main, canonical origin URL,
accepted local main, immutable Task base/branch/result and clean managed dev
must all agree. An unpublished or additional Task merge side is not authorized.
This proof never moves primary main or treats remote-only history as published.

The read-only preview imports reviewed Git objects only into a disposable clone.
It recomputes the ordered `[oldDev,Task]` proof parents and tree, automatic
merge-tree baseline, each conflict's exact stage 1/2/3 mode/blob, the reviewed
regular-file entry and the absence of non-conflict edits. Its content hash binds
the bundle bytes, exact publication/remote, Task revision and preview caller.
Confirmation has a new operation ID and rechecks the inputs under the existing
Task/repository/Await leases before a durable lifecycle intent. The Git owner
imports the exact bundle objects without moving a ref, stages only bounded
regular-file edits/additions, then performs one expected-old dev ref CAS.
Materialization uses exclusive hard links and inode/content readback: an ignored
or late private target cannot be overwritten by checkout. Unsupported delete,
rename, symlink, file-directory or mode shapes refuse before CAS. A post-CAS
collision leaves the original operation pending and its private bytes intact;
the same operation can resume once the collision is resolved. A clean exact
index/worktree, Task result ref and durable completed receipt precede Test's
Task status CAS. Unknown effects are reconciled only under the original ID;
no ref-only outcome is Test success.
Intent, journal and completion records are atomically published from synced
temporary bytes. An incomplete pre-CAS journal can only be rebuilt for the
same operation after confirming the old dev ref; post-CAS recovery uses the
same exact ref, staged bytes and worktree readback before a complete receipt.

That dev merge is Test evidence, not a Task-owned release result. PreRelease
must revalidate its exact durable proof and project the selected Task delta
from the published-side merge base, excluding CHANGELOG and all unselected
rolling-dev bytes. Missing/changed proof, additional integration, changed
publication generation or remote, or a non-CHANGELOG release conflict rejects
preparation rather than falling back to effective dev replay. Candidate reuse
requires the same mandatory selected projection. Ordinary explicit adoption,
bootstrap and automatic Task integration keep their existing guards.

Publication evidence remains scoped to the repository: the prerequisite result
must be in the confirmed published revision, and that revision must be contained
in current origin/main. Further fast-forward publication does not renew the wait;
a rewind or unrelated remote revision does not satisfy it.

## Accepted instruction change (HUB-235, 2026-09-14)

The user selected rolling PreRelease preparation after Task acceptance. The
Workspace checkbox instructions now require advancing the accepted Test result
from dev into PreRelease promptly, without starting the full release pipeline.
Only accepted work is included. The 2026-09-16 decision in ADR-0055 supersedes
acceptance-before-composition: Await is committed only after successful PreRelease
integration, and a conflict leaves the Task in Test and preserves the last good
composition. Agent rules describe these statuses briefly; Hub owns their effects.

ADR-0045 supersedes the preparation timing of ADR-0043 at the policy level.
HUB-235 implements preparation before ordinary Await transitions as described
below and in ADR-0055, superseding that ordering in ADR-0048.
The separate post-publication finalization changes remain outside this step.
No autofill or rule migration is introduced.


## Authority and identity

### Task validation and optional test environments (HUB-235)

The release checkbox policy requires appropriate branch-local checks by default.
A test environment is used only if the Workspace provides one and the check
needs a running application or user inspection. Temporary isolated Task
environments are optional and require Workspace support; no permanent
environment per Task is required. Shared environments check combined work and
reuse an already-ready required version. If the project provides a shared test
environment lock, the agent acquires it immediately before manual testing only
after rechecking the exact served version, then releases it after success,
failure or cancellation. The lock is not held during coding, fixes, local tests,
review or waiting for a person. It protects only that contour root.

Workspace rules own commands and readiness criteria. Environment checks do not
replace mandatory release validation. Agent HUB still supplies one rolling
dev-based Test Contour; this policy does not implement branch contour deployment
or change release preflight by itself. ADR-0058 separately removes the mandatory
rolling-contour refresh from release preflight. See ADR-0053.

For a release-enabled Workspace, the Dashboard `Task` aggregate is the live
authority for ownership, readiness and release completion. Its `workspaceId`
and `streamId` identify the Workspace and executor Stream. The durable Task
`row_revision` is the CAS version for every release-relevant mutation.

Every numbered file-changing Task owns a local branch whose name is exactly its
stable human-facing Task number, for example `HUB-11`, and a managed worktree.
Legacy unnumbered Tasks retain `agenthub/task/<taskId>/<repositoryKey>` until
their next managed preparation renames the branch.
`hub_task_claim` and `hub_task_start` return that worktree. All Task changes must
be made there. Provider turn identity remains journal metadata and is not a
source of file ownership.

Task launch persists its request owner, planned destination and row-revision CAS
before creating a Stream, Thread or delivery. While a new destination is not yet
a catalog member, the awaited `task.starting` event is Workspace-scoped, carries
the destination in its payload and deduplicates by Task/request identity. A
rejected event therefore leaves an exact prepared launch without producing the
downstream effects. Startup never launches it automatically; the original MCP
receipt becomes `unknown` rather than a replay lease. A Release Manager may explicitly
cancel it only with exact caller, Task owner and revision evidence plus proof that
the planned Stream and admitted delivery content do not exist. Cancellation
first wins a durable per-Task `prepared -> cancelling` CAS against the launch
runner's `prepared -> admitted(attemptId)` CAS. Only the admitted attempt may
enter Stream, Thread or delivery effects. An already admitted launch makes
cancellation fail; a successful cancellation fence makes every old or concurrent
runner fail admission before effects. Cancellation then terminalizes the
original receipt before clearing launch ownership. These SQLite CAS transitions
arbitrate across connections/processes without a global or timeout lock. Claiming a
still-`starting` Task is rejected; after cancellation the Task can follow the
normal existing-Stream start or claim path without the old request taking it
back.

Each managed Task worktree enables non-cone sparse checkout at the Git boundary
before it is returned. A selected project subtree retains that subtree and the
files of its ancestor directories; a repository-root selection retains the whole
repository. Both exclude `CHANGELOG.md` at every depth. These files belong to
release preparation in PreRelease, not Task worktrees. Clean tracked copies are
removed by Git sparse checkout; modified, staged or newly created changelogs cause
an explicit preparation/snapshot rejection with all user bytes preserved. The
returned `projectRoot` is the selected directory inside the managed worktree.
Scope resolution fails closed if the selected root escapes its source worktree.

Ordinary Task claim, start and Git preparation do not install or scan dependencies.
Before running dependency-dependent tests, builds or commands, the agent calls
`hub_task_claim` with `dependency_mode=ensure`; `skip` is the default, and
`verify` requests full installed-state validation after suspected damage.
Explicit dependency preparation handles every tracked `package-lock.json`
inside the selected sparse project with lockfile-locked `npm ci` when needed,
including declared development
and optional dependencies. Platform-incompatible or otherwise failed optional
packages may be absent as permitted by npm; if an optional package is present,
its installed identity must match the lockfile. Each `node_modules` is an
ordinary local directory below its package root in the managed worktree;
external links and junctions, including links to the primary checkout, fail
closed. A marker inside the ignored dependency
directory binds the policy, source lockfile, adjacent package manifest, Node
version/ABI, platform/architecture and local linked-package expectations to a
bounded proof over npm's
local hidden lockfile plus a deterministic enumeration of physical package
roots, including scoped and nested packages. The physical and hidden-lock sets
must match, and every package's canonical lock/path name, `version`,
`integrity`, `resolved` and link identity must match the declared lock wherever
those fields apply. A non-link alias uses the package name recorded by its lock
entry; an ordinary package without that metadata uses its canonical path name.
For a local `file:`/link entry, the resolved target must remain inside the
managed project after `realpath`, and its physical name and version come from
the target lock entry and target `package.json`, not the link's alias path. npm
metadata entries are not package roots. Prisma-generated `.prisma` service
state is accepted only beside an installed lock-backed package whose resolved
source, installed-lock and physical identity is genuinely `@prisma/client` at
the same `node_modules` level; an npm alias merely occupying that path does not
qualify. Its root contains only the local `client` directory;
the bounded generated tree contains no hidden entries, nested `node_modules`,
links, junctions or special files, remains inside the canonical managed project
after `realpath`, and contributes deterministic structural evidence to the
installed-state marker. Unknown hidden service entries still fail closed.
Containment compares resolved candidates with canonical physical project and
package roots, so an equivalent Windows long-name/8.3 alias is not mistaken for
an escape while a different physical target remains rejected. After successful
full validation, `ensure` reuses unchanged inputs and the same hidden-lock hash
without rescanning individual installed packages. Changed inputs, missing proof,
a changed hidden lock or `verify` enter full validation; a changed input fingerprint
requires a fresh install. Thus ordinary reuse is not a fresh proof against arbitrary
edits inside installed packages: suspected damage requires `verify`. Installation
or validation failure fails explicit dependency preparation instead of returning
a falsely ready dependency result. Markers contain no
checkout path or other machine-specific location. Multiple
tracked lockfiles are prepared serially under one Task/repository interprocess
lock; untracked lockfiles and lockfiles outside the selected sparse project are
ignored.

Dependency preparation keeps the existing Task lifecycle lease and adds the
per-Task/repository dependency lock, after releasing the managed dev lease;
it does not create a second process owner. The combined lease signal and
durable ownership assertion fence every npm operation. npm runs through the
Task lifecycle process-tree guard, so lease loss, cancellation or timeout must
stop and prove completion of the entire descendant tree before preparation can
return. An unproven stop leaves the persistent guard in place and blocks the
next owner of that Task until operator reconciliation. npm guards explicitly use
Task scope, so another Task may prepare or integrate while npm is running.
Repository-scoped Git guards and older guards without an explicit scope continue
to block the repository. Recovery joins the exact unknown MCP
request, pending lifecycle transition, Task revision, repository and guard ID
under the Await, Task and repository locks. The repository lease remains held
from durable classification through guard recovery, resumed Git work, lifecycle
terminalization and the original receipt CAS; nested Git steps reuse that exact
lease instead of releasing and reacquiring it. A caller confirmation is not process
evidence. A guard without a captured process identity is recoverable only when
`Win32_OperatingSystem.LastBootUpTime` postdates guard creation; this bounded
recovery deliberately provides no weaker non-reboot proof. Verified recovery
evidence is persisted before removing the guard, so a crash can reuse only the
same guard identity. Reconciliation first classifies durable state: exact
pending Git work resumes, while an exact workflow outcome, rollback or failed
transition only settles the original receipt without replay. A mismatched or
mixed state remains unknown. It never reopens an unknown receipt or replays the
effect under a new request ID. Ownership is rechecked
after external and validation awaits and immediately before and after marker
promotion; losing it prevents a falsely prepared result.

The original workflow identity may be plain or may include either or both
optional Task revision/current workflow CAS fields. Reconciliation reproduces
exactly the fields present in that original request and verifies supplied CAS
again against the immutable prior Task stored with the transition or outcome.
Ordinary CAS does not imply a release cutover and never requires fabricated
cutover source evidence. A real cutover remains a distinct complete identity
whose source commit, projector hash and any cross-Task source evidence are all
mandatory.

Every repository-scoped guarded Git command holds the common repository dev
lease from the foreign-guard check until natural completion or the bounded
process-tree-stop outcome. Ordinary live contention therefore waits for that
lease and cannot mistake the current owner's temporary guard for an orphan. A
guard still present after the lease becomes available remains an unresolved
orphan and keeps the repository fail closed. For `hub_task_claim`, that check is
before base-ref/worktree mutation, child-process start and the atomic Task claim
binding. Its structured admission error is authoritative no-effect evidence and
terminally fails the original MCP receipt instead of leaving it unknown.

An exact legacy `hub_task_claim` receipt produced by the former pre-lock guard
check may be terminalized on same-`request_id` retry without replay. This bounded
compatibility path requires the original MCP caller/tool/arguments hash, the
recognized `task-git-repository-guard-before-dev-lock-v1` error and guard path,
the canonical repository key and a read proving that no Task claim binding
exists for that operation ID. It does not inspect timestamps, delete a guard or
replay Git mutations. Any Task binding, changed request identity, malformed/foreign path,
repository mismatch or other error stays unknown. The compatibility classifier
may be removed only after supported journals can no longer contain unknown claim
receipts from that source version.

Dependency proof traversal is bounded before queue growth and directory
expansion: each source or hidden package lock is at most 16 MiB, with at most
16 nested `node_modules` levels, 10,000 physical package roots, 5,000 entries
in one scanned `node_modules` or scope container, and 50,000 directory entries
in total. Source locks, hidden locks, markers and package metadata are read from
one opened regular-file handle: its size is checked before allocation, reads
use bounded chunks, and identity, size and modification time are checked again
before close; contents are never fetched through a second path-based read.
Source package entries are collected iteratively; every count, depth and
structural entry is checked before collection growth. Source preflight accounts
only for package roots and required scope containers derived from the lock, so
each declared structural limit remains reachable; service metadata is measured
only by the physical scanner.

Any source or physical overflow is a preparation error, never a cache miss. A
post-install validation failure writes bounded durable evidence keyed by the
exact policy and source-lock hash. Evidence is flushed through a temporary file
in the same directory and atomically renamed over its destination. Temp-name
collisions receive at most four new random-name attempts; only a temp file
successfully created by the current writer may be cleaned up, and exhaustion
leaves the destination unchanged. Repeated preparation never trusts that
marker alone: it independently repeats bounded physical validation and returns
a recorded error without another `npm ci` only when an allowlisted stable code
and state exactly match the reproduced validator outcome. A valid repaired tree
removes forged or stale failure evidence. A changed lock or policy permits one
retry; without matching evidence, a reproducible physical overflow still fails
before npm, preventing a crash-before-first-marker reinstall loop. Recovery is
to repair or remove the invalid `node_modules` tree, or change the lock/policy;
deleting only the failure marker does not authorize another install into the
same overflowing tree. Invalid trees are never marked prepared, and Agent Hub
does not report successful dependency preparation without an honest result.
This local integrity cache does not claim protection from a process that can
modify the source `package-lock.json` itself.

Repeated preparation reads the configured scope and mode, preserves merge-state
admission checks, and does not reapply unchanged sparse settings. New worktrees
and changed scope/mode apply the selected configuration. An existing
managed Task worktree is migrated in place without reset, clean, branch/base
movement or snapshotting: tracked and untracked dirty state must remain
unchanged, including dirty paths outside the new sparse scope. Sparse
configuration is worktree-local; shared and managed `dev` worktrees are not
changed by Task preparation.

One provider turn may perform multiple sequential Task operations. Each claim
is durably identified by its MCP `request_id`, and terminal evidence resolves
the exact `(provider, thread, turn, operation)` binding rather than a
turn-global Task. At most one unterminated Task write operation may exist for a
provider turn. A new explicit claim operation
atomically terminates the preceding binding before it activates the next Task,
so sequential switches are allowed without overlapping active writers.

The persistence compatibility boundary is the absence of `operation_id` on
the binding or work-log table. Store startup rebuilds only that legacy shape,
assigns deterministic `legacy:<taskId>` operation identities and installs the
active-operation guard in the same migration. The rebuild may be removed only
after every supported database version is guaranteed to contain operation IDs.

## Test and acceptance integration

Task work history projects retained terminal journal records through exact
provider/thread/turn Task bindings (ADR-0051), independently of changed files.
It does not infer Git ownership or release readiness. Legacy work logs remain
visible when no matching terminal journal record is available.
Task-card Git diff is a bounded read of the owned managed worktree against its
Task base; it never prepares, snapshots or integrates the Task.

In a Workspace with `settings.releaseWorkflowEnabled === true`, moving a Task
to `testing` snapshots its complete dirty worktree into a local result commit
and merges that result into the shared local `dev` branch. Later transitions to
Await or Done reuse that exact Test-owned result and never take another snapshot.
Git derives the stable changed-file
set between the Task base commit and Task result commit:

`Array<{projectRoot,path,operation:"added"|"modified"|"deleted",turnId:null|string}>`.

`projectRoot` is the canonical Git repository root and `path` is relative to
that root. Git defines the base, result, operation, blobs and patch. Provider
receipts, final text, timestamps and shared dirty trees are never ownership
fallbacks.

The exact local `refs/heads/main` commit is the accepted repository baseline.
Fetching or moving `refs/remotes/origin/main` is observation only and never
changes Task, dev, plan or preflight authority. A new Task atomically verifies
local main and creates its immutable base ref at that exact commit; it never
starts from rolling dev content or a newer remote-tracking tip. Existing Task
base refs remain unchanged. Missing local main fails closed rather than choosing
`HEAD`, dev, publication state or a remote fallback.

Ordinary Task preparation, integration and release evidence only recover and
inspect managed `dev`; they do not fetch or synchronize main. Existing dev must
be clean and contain the accepted local baseline. Explicit post-publication
main-to-dev synchronization requires the exact durable published revision and
also requires local main to equal it. If those exact inputs diverge, or the merge
conflicts, the operation fails or reports `manual_required` only after proving
the old dev head and clean worktree were restored. The owner never checks out or
updates the registered primary worktree, creates `origin/dev`, or treats a
remote ref movement as acceptance. See ADR-0040.

When an explicitly accepted local `main` has advanced beyond the durable
published revision while managed `dev` still contains separate Test results,
the Task Git owner has a separate, operator-invoked bootstrap. It requires one
stable request ID, the exact accepted main and dev commits, published revision
and generation, and a unique dev/main merge base. Published/main must have that
same unique base, or the exact published revision must itself be an ancestor of
the dev/main base when both branches already contain newer accepted upstream.
An older divergent published branch does not satisfy this second case. The same
proof is checked at admission, before CAS and during historical recovery
(ADR-0119). Under the existing dev lease it verifies
cleanliness, ancestry and the unchanged local main, constructs a merge with
ordered parents `[oldDev, acceptedMain]`, and advances only `dev` by CAS. A
durable pre-CAS record binds those proofs; recovery distinguishes no effect from
the exact CAS and restores only its owned worktree. Conflict abort must prove
the old dev head and clean status. Completed replay uses the original receipt;
an unknown CAS outcome is never retried as a fresh effect. This path changes no
Task result, publication evidence, remote ref or registered primary worktree.
It does not infer acceptance of a new local main from a remote movement. See
ADR-0082.
For a sole `CHANGELOG.md` conflict, the operator may supply reviewed regular-file
bytes and the expected complete resolved Git tree. The owner stages only that
file, compares `write-tree` to the exact reviewed tree before CAS, and otherwise
aborts and proves restoration. Other conflicts remain fail-closed. The resolved
tree is bound to the durable request and same-request replay.
If publication advances after the last pre-CAS read, exact CAS readback and
ordered-parent proof still materialize and receipt the already committed dev
effect; the response reports `merged_publication_advanced`. A different request
cannot use the stale generation. Same-request replay reports the historical
completed effect, not a new approval of the advanced publication.
For this accepted-main bootstrap only, materialization currently supports
content changes to existing regular files with unchanged mode. Path additions
(including rename destinations), deletions, file-directory and symlink/type
changes fail before a new CAS. An exact already-admitted CAS is recovered only
after the same tree-shape proof. A main-edited path deleted from old dev is
rejected before merge, even if an ignored private file now occupies it.
Ignored dependencies/WIP do not make an
otherwise clean dev dirty, but nonignored untracked files remain a refusal.
No ignored-file overwrite or cleanup is authorized by this bootstrap.

The one-time bootstrap for an already-diverged managed `dev` is itself a Task
result: under the same Task and dev locks, the snapshot owner accepts a pending
Task-worktree merge only when its exact `MERGE_HEAD` is the current managed dev
head. The accepted Task result must contain one unique first-parent merge whose
second parent is the exact current `main`. When ordinary main-to-dev integration
conflicts, the owner constructs an unreachable bootstrap commit `B` with exact
ordered parents `[oldDev, main]`. Its automatic merge bytes come only from those
parents; each conflicting code path is replaced only when the Task-local proof
matches the index's dev/main mode, type and object identities and the accepted
Task result exactly. `CHANGELOG.md` may use the accepted Task snapshot only as
the excluded release-history path in this same atomic integration. A second
unreachable commit `C=[B, TaskResult]` must reproduce the complete accepted Task
tree, including Task-only files that are absent from `B`.

Only one compare-and-swap publishes `dev` from `oldDev` to `C`; neither `B` nor
partial index state becomes a visible dev head. Durable transaction evidence
written before that CAS distinguishes no effect from the exact committed effect:
recovery restores the worktree to `C` only when the ref and ordered parents still
match, and otherwise fails closed. Interruptions before the CAS restore the exact
old dev head, index and worktree. The registered primary checkout is never
changed. See ADR-0039.

A successful Test integration records only the deterministic Task branch and
its accepted immutable result commit on the Task. The base ref and changed-file
set remain Git data and are derived when a release plan is read. A conflict is
returned with exact conflicting paths only after the Task merge abort proves the
pre-merge dev head and clean status were restored. Abort failure or partial
restoration throws instead of reporting an ordinary conflict. An empty diff is
explicit `no_result`, even when the Task HEAD is already ancestral to `dev`, and
cannot enter Test or Await. Snapshot, merge, ancestry verification and recovery
complete before one row-revision CAS atomically replaces Git references, updates
the exact operation binding and changes workflow status. In a release-enabled
Workspace, every workflow transition is serialized with the Workspace release
lock. Test owns the immutable snapshot and successful `dev` integration proof.
A transition into Await first prepares the prospective PreRelease composition
from the exact Test-owned result, while the Task remains in Test. The existing
planner projects the future Task row and acceptance revisions without persisting them. Only after
all repository candidates succeed does the lifecycle owner commit the status CAS.
Workspace Await and Task leases cover the operation. The canonical candidate
owner retains rollback boundaries until the status outcome is known: a proven
SQLite refusal restores previous PreRelease refs, checkout and checkpoints; a
lost reply is read back using the original lifecycle operation. An ambiguous
outcome remains pending/unknown and must not trigger a speculative rollback.
Composition failure leaves the Task's previous status unchanged. Known failures
are terminal MCP refusals; retrying the same request reads that same outcome.
Corrections require a new attempt by the executor. No full tests, contour refresh,
build or publication runs during acceptance.

Returning an accepted result still uses the existing withdrawal owner, then
prepares the remaining membership. This change does not redefine withdrawal or
release finalization recovery. Legacy committed Await outcomes retain their
original pending-candidate evidence; history is not rewritten. See ADR-0055.
Workspaces without releaseWorkflowEnabled=true keep database-only status changes,
including when auto-review is enabled; no Git or release service is invoked.

Repeated Test may reuse its recorded result only when the worktree HEAD, internal
result ref and exact expected result agree, tracked/staged/untracked state is clean,
there is no merge in progress, the Task has a nonempty effective result, and dev
still includes it. The Git owner checks after acquiring dev ownership; otherwise
it runs the ordinary snapshot/integration path.

Moving a Task to `awaiting_implementation` records that its exact immutable
result is accepted for a future release. A ready Await Task requires a valid
exact result and successful `dev` integration. Missing or ambiguous integration
ownership, an effective delta that cannot be applied to the approved main base,
or a dependency on work owned only by Test/In Progress/New blocks acceptance and leaves the Task in Test. Such a dependency is never
silently included. The accepted policy is that dependent Task B waits until its
prerequisite A is published when they remain separate; explicit user-authorized
consolidation follows the conflict workflow above.

Returning a Test/Await result to New/In Progress preserves the accepted result,
managed dev history, Task branch and dirty worktree. The Task lifecycle records
that the prior result remains accepted while the correction is prepared. It does
not rebuild dev, remove a historical merge side or create a withdrawal intent.
Unknown historical ownership therefore cannot block ordinary correction work.
An identified dependency is still reported without an automatic cascade. A
Git-owned wait ref, when explicitly recorded, gates claim/start preparation and
Test until the prerequisite is contained in the durable published revision and
that revision remains an ancestor of origin/main. A direct user exception may
clear the wait through `hub_task_claim dependency_override_reason`; the exact
instruction is retained in the MCP operation arguments. Already published code
remains in main/dev; reopening that Task is work on a subsequent result.

Withdrawal/revert is a separate explicit operation, not an implicit workflow
status transition. Legacy withdrawal intents remain readable and recoverable by
their original exact operation for N−1 compatibility, but they are not created by
the cutover lifecycle. Their old reconciliation path cannot authorize a new
release operation or freeze unrelated Task work.

Automatic Await preparation advances live PreRelease without modifying any
immutable generation. A running publication never returns a frozen-policy
refusal. Failed composition restores the exact previous live PreRelease HEAD,
checkout branch and checkpoint and leaves the Task in Test. The current accepted
result set must still match before the Await CAS; an old generation is never
evidence that the changed live set is ready. Returning a Task for correction
preserves its prior accepted result and dev history until a new exact result is
accepted. Repository identities are canonicalized for every new composition.

Legacy withdrawal error classification reads the original intent while holding
the repository lock. Only the exact current operation/task intent can prove its
unknown historical effect. A foreign legacy intent leaves both its recovery
evidence and the current Task status unchanged.

## Task Git reference and CAS

Ordinary expected revision/status refusal before lifecycle admission seals a
bounded `NO_EFFECT` outcome through the existing Task SQLite owner. It cannot
overwrite an admitted/terminal operation or authorize replay. Fresh-intake and
lease authority must still hold, and preparation/effects must not have started.
The MCP classifier/startup/canonical original-ID reconciler use the exact sealed
identity, not an error string or present-day Task/Git state. A crash between that
outcome and receipt settlement never requires repeating the refused operation.
Exact immutable refusal settlement is only the existing SQLite receipt CAS,
including database-only/null-root workspaces; it does not acquire release/Git
authority or invoke recovery. Ordinary Git reconciliation keeps its existing
workflow, root, process guard and owner requirements.
Legacy missing-admission UNKNOWN without this evidence remains UNKNOWN; no manual
certificate, guard bypass, SQL repair or historical effects inference is allowed.
The reconciler's own proven pre-effect refusal is terminal without altering the
original ambiguous operation. See MCP-001 and ADR-0085.

The server-side Git boundary owns:

- the Task-number branch;
- the internal Task base ref;
- the immutable accepted result commit;
- the integrated `dev` result.

The Task aggregate stores only `{projectRoot, branch, resultCommit}` for each
repository. It does not store a second release-authority copy of changed files,
base/result revision pairs, blobs or manifests. Work-log changed files remain
diagnostic journal data only. There is no separate readiness row, frozen
manifest or freeze command. The release plan hashes the Task acceptance revision
and Git references. Generic status mutation may roll back to a non-result status
at any time, but Test, Await and Done in a release-enabled Workspace require a proven integrated result. Any
intervening acceptance or accepted-result mutation changes the plan
revision and invalidates an older Release Manager plan. Provider terminal callbacks
do not infer file ownership or release readiness.

## Release plan and completion

### Card revision and accepted-result identity (HUB-235)

`row_revision` remains the exact optimistic-write CAS for every Task mutation.
The same Task row now also carries `release_revision`, exposed as releaseRevision.
It advances on workflow status, Workspace/bucket and open/closed membership
changes. Git reference identity is independently included in the release hash.
Title, description, checklist, attachments and executor changes do not advance
acceptance identity. Returning and reaccepting even the same result does advance
it. This is a version of the existing Task aggregate, not a second readiness owner.

The release plan hashes only open Await membership, acceptance revisions and exact
Git references. Open Done Tasks remain visible as audit data but do not affect
this identity. The existing taskRevision field in ready entries and manifests
now denotes acceptance revision; ordinary Task.revision still denotes row CAS.
Prepared candidates therefore reuse their unchanged manifest/head across editorial
updates, and frozen candidates retain their metadata and validation identity.
Integration evidence, approved base, standalone-clone ownership, exact source and
metadata bytes, request receipts and unknown-outcome fences are unchanged.

Completion rereads membership and accepted results inside its SQLite transaction,
then closes each selected Task with its current row revision. Editorial changes
after publication verification survive closure. A different accepted result,
withdrawal, reacceptance or changed membership fails before any Task is closed.

Migration initializes release_revision once from row_revision, preserving old
candidate identities when their prior evidence still matches. An old plan that
also hashed open Done audit rows is not a new candidate identity: completion alone
may recognize its exact legacy row-based hash, and must still pass the existing
frozen-head/manifest/publication verifier and strict old row checks. It cannot
adopt changed old evidence. Already persisted finalization receipts resume through
their original owner. Old prepared plans invalidated by this identity change must
be prepared again; no frozen bytes or journal receipts are rewritten. Retire the
legacy hash branch when no supported in-flight publication uses it. See ADR-0061.

### Consolidated changelog and version ownership (HUB-235)

The Release Manager writes one consolidated CHANGELOG entry in the prepared PreRelease.
Each included Task has a clickable link and a brief description, normally its
title. Larger Tasks include the main changes from their checklist, or a concise
result summary if no checklist exists. Task branches do not carry changelog
entries or manual release-version bumps.

The publication mechanism assigns the version under Workspace rules and freezes
it with the entry and candidate before final validation. Retrying the same frozen
release preserves that version and entry, including across a calendar-day change.
For Agent Hub, the existing metadata freeze selects local-date CalVer and commits
package.json, both package-lock version fields and the supplied root CHANGELOG
bytes together. This Hub-specific implementation does not prescribe a version
format or implement version adapters for other Workspace products.

Rule composition adds current checkbox-selected templates to stored authored text.
It does not recognize or replace old copied policy blocks. See ADR-0066, which
supersedes the generated-prefix compatibility portion of ADR-0060.

### Agreed main and exact selected native merges (HUB-303)

Await composition starts at exact agreed local main, separately bound to the
durable published revision. Required selected descriptors remain in plan hashes,
receipts, immutable manifests, generations, duplicate checks and readbacks.
The existing plan includes every open Await Task; missing/invalid Git evidence
is blocked, never silently omitted. Shared paths are diagnostics; actual native
Git conflicts are resolved in the isolated checkout. New corrections merge their
whole exact result history, not their last effective dev delta. Changed selection
starts from the same agreed main and excludes omitted results. No entire dev merge
or old aggregate checkpoint supplies content to a new selected set.

See the native cutover section above. The old effective-delta/net-fold algorithms
are retained in historical ADRs and receipts, not on the new ordinary path.


Release publishes the prepared PreRelease; the Release Manager does not select a
second Task set at release start. Before choosing the base, Agent Hub fetches without pull/merge/rebase and
reports every local unpublished or remote main change since the last published
revision, including commit identities, authorship and affected paths. Local and
remote main are not advanced or accepted automatically. The Release Manager inspects
every incoming commit and its complete changes, including conflict-free changes,
and reports findings and release impact to the user. Compatibility is not inferred
from a clean merge. Never pull or merge origin/main directly into local main.
When integration is needed, prepare it in the relevant managed Task branch,
preserve user changes, resolve conflicts and validate the combined result.
Ambiguous user intent requires clarification rather than discarding either side.
Task-local preparation is allowed under the current work authorization; release
acceptance and publication wait for explicit user approval of the shown combined
result and checks. Record that approval against the reviewed local/origin commits
and Task result using the existing adoption and preflight operations. Users do not
have to type or repeat SHAs. Unchanged evidence for the same authorized release
does not require another approval; a release command does not approve unreviewed
incoming changes. See ADR-0057.

Preflight rechecks both exact main values before candidate publication. A second
fetch immediately before push is a compare-and-set guard: movement of origin/main
stops publication for inspection and reporting of all new changes, any necessary
Task-local integration, and approval of the updated result. Only the approved
release updates main through the existing publication/completion operations.

When the approved origin commit differs from accepted local main, approval of
the audit is not adoption. Before any contour or candidate side effect,
preflight also requires an immutable content-addressed adoption receipt for one
selected frozen Task result plus ancestry of that exact origin commit in current
managed dev. The receipt binds Task ID, canonical repository and key, immutable
Task base, accepted local-main baseline, exact adopted SHA, Task branch and
snapshot commit/tree, unique bounded first-parent merge proof and its exact
parents/tree, operator request ID and Git blob hash. Ordinary prepare, claim,
Test, integration, plan and preflight paths can verify this authority but never
create it. The supported operator surface is `npm run release:policy --
task-upstream-adoption preview|enable --project-root <root> --task-id <id>
--branch <branch> --task-base <sha> --accepted-local-main <sha>
--adopted-commit <sha> --snapshot-commit <sha> --request-id <id>`; preview has
no write effect, while enable atomically verifies the pinned local main, Task
base and Task branch before creating one immutable Git ref to the receipt blob.
Graph shape or later preflight approval cannot retroactively create authority.
A remote-only commit, broad dev merge, missing/mismatched receipt or changed
snapshot fails closed. If origin advances after a pinned Task adoption, the new
tip requires a new audit and a separately authorized Task adoption.

If a preflight response is interrupted, including legacy calls that prepared a
candidate, recovery is
readback-only. The Release Manager may reconcile the original request only by naming
the exact original request, original preflight arguments, plan revision and
repository revisions. Agent Hub first binds that request to the authoritative
MCP operation receipt by tool, Workspace, caller Stream/provider/thread and
immutable arguments hash, then reads the existing frozen candidate checkpoints
and manifests through the release Git owner. A prepared checkpoint is only
candidate snapshot evidence, even when it is causally bound to the same request:
failures can still occur after the checkpoint before the final preflight guard.
The original request may be reported as reconciled only from a separate
authoritative final-phase outcome that covers candidate preparation, final
primary/release invariant checks and all required validation. Without that final
evidence, the response is only `candidate_snapshot_only` and the original
outcome remains unknown. Missing, stale, moved-plan, tampered-manifest,
contradictory manifest/checkpoint request identity, wrong Workspace or stale Task
revision/result evidence keep the original outcome unknown. Reconciliation never
reruns preflight, reuses a generic replay lease, finalizes the old receipt or
manufactures Test Contour, validation, main-review or publication evidence.

For repositories without the Agent Hub release pipeline, release preflight retains a
repository-owned production validation adapter. The minimal supported adapter
contract for Bookworm-style Android repositories is enabled only by explicit
`releaseValidation.repositories[]` policy. The default unconfigured state fails
closed with an operator action. A configured adapter runs the approved QA checks
against the exact frozen candidate in isolation after `PreRelease` preparation,
then persists bounded server-owned evidence naming repository identity, plan
revision, Task IDs and revisions, Task result commits, candidate commit and tree,
immutable manifest identity, relevant build input identity, check commands,
outcomes and artifact digests. The
preflight adapter accepts only an exact match to the selected repository, plan,
candidate and Task result evidence. Historical QA reports, mutable build outputs,
tree equality, developer-authored reports, or a ready string are not production
validation evidence unless an explicit adapter proves the full input-equivalence
boundary.

Repository-scoped publication baseline adoption from an external publisher
requires an explicit supported authority for that repository. For a GitHub
release/tag source, the adapter must verify the repository remote identity,
publisher API response, immutable release/tag identity, tag target commit, and
staleness/moved-tag conditions before writing bounded publication evidence for
that repository through the publication-state owner while retaining other
repositories. The supported operator surface is `npm run release:policy --
github-baseline preview|enable --project-root <root> --owner <owner> --repo
<repo> --tag <tag> --release-id <id> --target-commit <sha>`; preview has no write
effect, enable writes only the verified repository-scoped record. An unscoped
local JSON file, an arbitrary supplied SHA, a foreign remote, a moved tag or an
Actions run head SHA fails closed. Activation of such an adapter is a separate
operator decision; existing unscoped state is not rewritten in place.

An Agent Hub legacy publication that predates repository-scoped state may be
adopted only through the separate operator surface `npm run release:policy --
local-publication-receipt preview|enable ...`. This adapter does not infer scope
from a SHA or ancestry. It binds the exact raw legacy state and successful local
publisher receipt by SHA-256; verifies their revision, generation, publication
time, Workspace, repository root, frozen plan/manifest and finalization
identities; and verifies the exact active installed release and its runtime
manifest were produced from the publisher checkout. The operator also pins the
canonical origin and current remote-tracking `origin/main`; local main must equal
the legacy published revision and that revision must be contained in the pinned
origin observation. The adapter never fetches or moves refs. Preview is
zero-write. Enable repeats all verification under the canonical publication
lock and appends repository-scoped evidence through the publication-state owner,
retaining the legacy fields and other repositories. Exact retry is idempotent;
changed bytes, identity, deployment, refs or conflicting scoped evidence fail
before write. This migration neither authorizes newer upstream content nor
bypasses ordinary preflight.

Every publication-state writer acquires or re-enters the canonical publication
lock before reserving its per-file write turn. A writer outside the current
owner therefore cannot occupy the write queue while waiting for that owner and
block a nested owner write. The write turn still serializes same-file updates,
and a rejected write releases its turn so later writers can continue. Duplicate
repository evidence is compared recursively across the complete persisted
record, including nested publisher and receipt fields; two records that differ
below the first object level are conflicting rather than silently coalesced.

The Release Manager uses the prepared PreRelease, supplies its consolidated
`CHANGELOG.md`, and freezes the public version before validation. Freeze binds
the exact main base, release-plan revision, included Task IDs and acceptance
revisions, Task results, owning dev integrations, aggregate `PreRelease` head,
manifest hash, standalone candidate head and Agent Hub package version. Later
Await Tasks are not silently added. The frozen release date/version remains the
tested identity even if the local calendar date changes before publication.
Only a Stream with `settings.releaseManager=true` may record verified release
completion.

Explicit preparation ordinarily composes the selected effective deltas. A
bounded incremental preparation may start from an exact previously frozen
manifest only when base, Workspace and selected Task IDs are unchanged, every
other selected result is unchanged, and exactly one selected result advances by
ancestry. Row-revision changes with an unchanged result are metadata-only. The
builder applies only that result's exact non-`CHANGELOG.md` patch to the frozen
candidate, without three-way or alternate fallback, then records the new current
revisions and reuse evidence. A conflict fails normally. Known unselected paths
and any contribution outside the selected delta remain excluded; changed
selection/base or a non-descendant result uses ordinary selected-delta
composition instead of this optimization.

Legacy freeze evidence binds the consolidated root CHANGELOG and exact package metadata to the
prepared aggregate and plan using the same release repository owner and lock.
It records durable freeze intent before promoting the clone's main reference
and resumes the identical target after interruption. Source edits or mismatched
plan/head/content fail closed. The registered primary is never the promotion
target. The imported candidate generation remains immutable. Any change of plan revision,
Task acceptance revision, Git reference or approved `main` invalidates its use by later
composition, publication and completion CAS. Await membership and Task work are
not frozen by that generation; a newly accepted result creates a later generation
when the operation is still before external publication. A push alone proves only
that target's effect and does not authorize finalization.

Freeze keeps the exact raw identity of the supplied CHANGELOG payload separate
from the canonical Git blob that owns its materialized checkout. Before durable
intent, the checkout bytes must equal the supplied payload byte for byte. Once
intent exists, the release owner retains the exact raw payload as immutable,
content-addressed evidence and binds its file identity and SHA-256 into both the
manifest and checkpoint. A direct retry must still present the same raw payload;
the public publication retry reads that evidence instead of deriving caller
identity from a checkout that Git may already have rewritten. Missing, linked or
digest-mismatched evidence fails closed. The checkout may differ only through
Git attributes or clean/smudge conversion and must still resolve through
`hash-object --path` to the stored blob. This split does not relax source,
manifest, plan, version, ref, dirty-path, regular-file or Workspace fences.

Candidate readback is phase-specific. A `prepared` checkpoint requires the
standalone clone to be an exact clean `PreRelease` checkout. A `frozen`
checkpoint requires an exact clean `main` checkout while both `main` and
`PreRelease` still equal the checkpointed `preReleaseHead`. Other phases and
any branch, ref, tree, index or worktree drift fail closed. Freeze remains the
only owner that promotes and attaches the standalone clone to `main`.

A failed pre-publication freeze, or an exact `frozen` candidate whose full
publication run failed before the first publication-effect stage, may be
explicitly abandoned only through the Release Git Workspace recovery owner.
Preview takes the canonical publication,
Workspace Await and repository leases and binds the exact checkpoint and
manifest bytes, plan, prepared/freeze commits and tree, clean clone, both local
refs, durable published revision, reviewed incoming `origin/main`, publication
run/checkpoint state and caller operation. Confirmation repeats that proof and
first preserves the original checkpoint, manifest and publication observations
as content-addressed evidence. It then CAS-restores only local `main` and
`PreRelease` to the exact values recorded by the freeze intent, restores the
clean prepared checkout and records an idempotent `abandoned` outcome. A retry
of the same operation resumes its durable phases before fresh-admission guards
are evaluated: it validates the immutable persisted recovery identity and only
the enumerated clean frozen, prepared-detached and completed ref states. A newer
remote main may be observed after admission only when Git proves that it does
not contain the frozen candidate. A completed outcome replays without reading
mutable publication state. Another operation, an unknown phase, dirty checkout,
identity drift or evidence that the candidate was published has no effect.

The frozen candidate's approved origin commit remains immutable recovery
provenance. If the live remote advances before a failed-frozen recovery, the
owner may additionally accept one separately reviewed direct child of that
approved commit. The caller supplies its exact commit, sole parent, tree,
  binary-diff SHA-256 and Git object ID, stable patch ID, the unchanged release
  tracking commit and the canonical origin URL SHA-256. The owner imports the
  remote tip and frozen
candidate only into a disposable bare object store, proves those objects and
that the remote does not contain the failed candidate, then removes the store.
It never fetches into or updates the release clone. The approved base, reviewed
observed tip and durable published revision remain separate proof fields.
A legacy failed-frozen candidate whose manifest and checkpoint both lack
provenance and request binding may instead supply the explicit
`missing-provenance-recovery-v1` input. Its approved base is derived only from
the original terminal ready `hub_release_preflight` receipt (exact caller,
canonical arguments hash and SHA-256 of the persisted result bytes) and the
historical immutable selected Task adoption, re-derived from its exact ref,
blob and objects independently of the current primary `main`; the resulting
supplemental authority is content-addressed in the proof and rechecked on every
retry and completed replay. A separately bound current observation of the
primary, remote, release tracking and origin URL must stay exact after preview;
a newer remote tip still needs its own reviewed-origin-advance identity while
release tracking stays at the historical approved origin. All
are persisted in recovery evidence and rechecked before admission and on retry;
divergence, force-push, unreviewed bytes or later remote/tracking movement fails
closed. Recovery remains local-only, so reviewed upstream bytes are preserved
for an ordinary future reviewed-main candidate rebuild rather than being
silently adopted or substituted as the published baseline.

Failed-frozen admission additionally binds the raw publication run and log plus
the exact raw presence and bytes of the publication checkpoint (or its explicit
absence), the exact run/candidate identity and the versioned executable
publication-stage contract. The allowlist is ordered: contour validation and
full tests are pre-effect stages; artifact preparation, Git publication,
runtime installation, worker deployment/verification, runtime activation and
VS Code extension installation are effect stages. Exactly one validation
boundary is terminal: either contour failed while full tests remain pending, or
contour completed/reused and full tests failed. Every effect stage must remain
pending and progress must be empty. Checkpoint evidence is classified as an
exact current-candidate pre-effect prefix, an exact retained prior-generation
pre-effect prefix, or explicit absence; confirmation and retry recheck the same
raw presence and bytes without replacing a retained prior checkpoint.
Completed contour evidence requires its current checkpoint. A retained prior
checkpoint is admissible only when the contour failed before writing or was
explicitly reused from that scope-compatible checkpoint. An existing retained
checkpoint must contain a non-empty ordered pre-effect prefix with a non-empty
fingerprint for every completed label; an empty fabricated record is not
equivalent to explicit file absence.
Unknown/new stages, unsupported schema, mixed checkpoint identity, missing run
binding, an active or ambiguous run, or any effect-stage receipt reject before admission. The
publication lock covers evidence read, admission CAS and local ref recovery;
lock order is publication → Workspace Await → repository, matching the
publisher's outer publication ownership and avoiding inverse acquisition.

Recovery never pushes,
deploys, mutates Tasks, deletes candidate objects/evidence, invents a result or
silently starts rebuilding. A later candidate is built through ordinary
reviewed Await preparation, so an approved incoming base remains distinct from
the last locally published revision.

Completion performs one transaction that checks every accepted Task identity
and the plan hash, CAS-writes each current row, then changes only those Tasks to `done` and persists a
versioned finalization marker in the same commit. That marker binds the exact
plan and published repository revisions to primary synchronization, dev
synchronization and explicit next-candidate invalidation receipts.
Generic `done` and
`hub_task_complete` do not create production evidence.

Post-deployment verification requires an explicit revision for every frozen
repository. That revision must equal, not merely contain, the checkpointed
`preReleaseHead` bound to the exact `{planRevision, manifestHash, baseCommit}`.
It also proves every accepted immutable Task result is contained, then repeats
publication revision/generation readback immediately before the Task closure
transaction. Once verified, only included Tasks are completed
and their managed branches and worktrees may be removed. Published `main` is
incorporated into `dev` without discarding later Test work. Remaining Await
Tasks stay accepted and the previous candidate is durably invalidated. No
candidate is rebuilt automatically after completion. The next acceptance into
Await composes the next candidate. Recovery of an incomplete accepted composition
uses the explicit RM-only preparation operation below; it preserves the original
successful Await and does not repeat that transition. Release preflight stays
read-only and fails closed on a stale candidate. This post-completion
orchestration remains HUB-235 checklist item 15. A repeated
completion request resumes only unfinished synchronization stages, never Task
closure or candidate preparation. Each successful stage
persists its receipt through a short canonical mutation before the next stage.
The active marker clears only after all stages have confirmed success.
The last 16 completed exact-plan outcomes remain canonical evidence for lost-response
replay; transport acknowledgment is not permission to forget release completion.
Interrupted Desktop completion reconciles only an existing pending or completed
outcome, never starts fresh Task closure. Legacy Await-only markers cannot prove
primary/dev synchronization: recovery explicitly reports unavailable legacy
evidence and resumes only their original synchronization scope.

The canonical Agent Hub `publish:changed` CLI delegates to the durable operation;
its stable runner prepares selected runtime, Worker, Android and extension
artifacts after validation and before Git publication (ADR-0062). Preparation leaves current runtime pointers, stable launchers and
installed extensions unchanged. Application consumes the prepared bytes; Worker
deployment uses the prepared Wrangler bundle without rebuilding. Component
artifact digests are pinned in the existing run journal, which also records
effect intent. Artifact manifests describe outputs, not publication progress.
Retry verifies payload hashes and installed results before reuse. A missing or
changed output after an admitted effect remains unconfirmed and is not blindly
reapplied. Worker readback binds the exact digest tag to a single 100-percent
production version and rechecks deployment identity. HTTP verification remains.
Expected runtime identity comes from the prepared product before installation.
CLI completion readback also verifies the retained prepared evidence. Existing
post-restart completion only finishes its saved readiness/finalization.
Pre-protocol runs already at deployment require their original executor; exact
legacy completion-only runs keep their saved completion path. Remove that branch
when no supported old pending publication remains. Standalone `publish:all` and
`runtime:deploy` preserve combined deployment for their existing callers.

The publication executor consumes the frozen manifest; it does not select Tasks
or infer approval. Its durable journal retains exact candidate, validation mode,
run ID, stage results, expected installed release, publication generation and
completion command identity. Before deployment, even after a saved Git success,
it rechecks the approved origin base and frozen plan. Push uses the exact
candidate revision and exact origin lease with an ancestry guard; observing the
same candidate on origin reconciles a lost push response without another push.
The first automated adapter supports one exact repository; multiple repositories
fail before publication rather than receiving partial completion evidence.

Starting a different publication identity cannot overwrite a nonterminal run.
Under the canonical publication lock, the existing start owner may automatically
mark a dead run `interrupted` only when its exact journal and checkpoint show
that execution reached solely the named pre-effect validation stages, no effect
stage was started, reused, completed or failed, and progress is empty. The old
terminal status is durably archived beside its existing log before the new
status is created; an exact retry after a crash between those writes is
idempotent. A live owner, unknown stage, effect-stage history, progress or
checkpoint mismatch fails closed and remains subject to its specific recovery
path.

Before replacing an already terminal publication identity, the start owner
archives the exact prior status beside its canonical run log. A conflicting
archive or a log identity outside the canonical run directory fails before the
new status is created. This preserves the terminal publication evidence even
though `publication-status.json` remains the current-run projection.

Deferred restart and `--skip-restart` with an unready runtime are
`awaiting_restart`, not success. Publication-state is recorded only after
required exact runtime readiness. Pending finalization stays recoverable and
retains checkpoints. A ready replacement resumes only readiness, publication
recording and canonical completion under the publication lock, without build,
deploy, push or restart; startup readiness does not wait for that work.
Only completed Workspace finalization yields `succeeded`. A low-level publisher
without a Workspace adapter yields `published` and does not claim Task closure.
When the safe restart owner defers rotation, the publication result carries the
machine-readable `yield_current_turn` handoff. The current release agent ends
its turn without starting more work; this neither interrupts another user's
turn nor requests an early restart before the existing safety gate.

Exact runtime readiness uses the authenticated bounded `runtime-health`
command, not the full application snapshot. Its live/ready flags and process
release ID/PID must match the filesystem runtime status, and the endpoint ID is
reread after the probe so an endpoint swap cannot be accepted. A mismatch keeps
completion pending and performs no publication or Task-finalization effect.

After readiness, durable `awaiting_finalization` is continued by the single
owner of the original publication operation without new user input. An explicit
`retry_required` repeats only the persisted Workspace finalization under the
same publication lock; retries are bounded by a shared budget and end with an
explicit reason once it is exhausted. Repeated readiness/resume events are
idempotent and create neither a second owner nor a second terminal. Already
successful tests, build, Git publication and deploy are never repeated.

An ambiguous finalization transport result retains the same command identity.
Only an authenticated definitive Desktop rejection proves that the durable
command is terminal and permits one fresh command identity for the same saved
publication completion. The Workspace completion owner then resolves an exact
completed outcome or pending marker idempotently; it does not repeat Task
closure, Git publication, deployment or runtime activation.

Validation is explicit and persisted: full, focused by affected surface, or a
user-authorized quick mode without the test gate. All modes retain publication
identity and readiness checks. Unknown paths expand the publication scope but
cannot override an explicit quick choice; focused mode retains full validation
for unknown paths. Full validation runs candidate smoke first.
Successful test files are reused only with the same proven input fingerprint;
opaque dynamic inputs without an explicit declaration are uncached. The v2 cache
survives successful suites/publication, with 30-day and 2000-result bounds; legacy
or proofless entries are not evidence. A failed file has no unconditional retry.
The full-test stage has no aggregate execution deadline. Its ten-minute
output-idle watchdog and local test, network, build and readiness bounds remain;
those bounds report failure, not an inferred external outcome. Other publication
steps keep their finite execution bounds. See ADR-0118. The two cosmetic
browser matrices run in `test:visual`, affected focused UI validation and full
validation exactly once, rather than every ordinary unit run. See ADR-0034.
The process-per-file runner overlaps at most two files after CPU/memory admission
and only for an explicit execution declaration proving distinct disposable
roots, locks, Git repositories, ports and browser profiles. An undeclared file
is exclusive; equal shared-resource tags serialize. Every child gets a unique
temporary environment root, while the same selected file set, failure set and
checkpoint fingerprints remain authoritative. A miss logs only stable policy
reason codes or `input fingerprint changed`; it never logs input contents.
Validation subprocesses are observers, not delegated publication stages: the
test runner removes inherited publication session and stage-delegation markers
before every child process. Publisher-owned deploy, activate and verification
stages retain their separately verified live-owner delegation. Validation that
exercises publication locking uses a fixture-local lock root, never the live
publisher target already held by the parent pipeline. This applies both to
direct state/adoption writers and to validation wrappers whose production
defaults acquire the publication lock, including safe restart and publication
orchestration tests, and runtime publication-completion recovery.

After one successful Worker deploy, live verification may retry only a
recognized exact-index byte-count or SHA-256 mismatch. It keeps the same
published candidate, changed-file set and verification checkpoint, performs no
deploy call. Index convergence alone shares one absolute deadline of 60 seconds
and at most six attempts; a late index cannot start subsequent stages. Other
verification requests retain their separate five-minute logical-request budget. A transport,
authorization or policy failure is not classified as convergence and is
returned immediately. Persistent byte mismatch becomes the terminal
`WORKER_DEPLOYMENT_MISMATCH` result with expected/actual hashes and lengths but
without an HTML body dump.

Verified release completion invokes the same Task Git owner with each exact
published repository revision. The returned `devSynchronization` evidence
distinguishes `already_current`, `fast_forwarded`, `merged`, `conflict`, and
`manual_required`. Publication and Task completion remain truthful when local
dev needs manual reconciliation: publication is not rolled back, but dev
integration is never represented as successful.

## Task close and destructive deletion

`hub_task_complete` and `hub_task_delete` are two-step operations. The first
call returns a confirmation token and an exact preview of branches, worktrees,
dirty and untracked paths, result commits, publication state and deletions. A
confirmed operation is serialized by the Task lifecycle lease and the token is
revalidated against the current Task revision, Git state and exact durable
publication generation. Replacing publication evidence at the same revision
invalidates confirmation before cleanup.
Both Desktop Dashboard actions and MCP tools enter the same application
lifecycle owner. The owner acquires the Task lease before computing either the
preview or the confirmed preview, and enumerates branch/base/result refs from
all stored Git references even when their worktree is already absent.

Complete closes an implementation Task only after workflow Done, rejects dirty
worktrees and removes a branch plus its protective result ref only when the
exact result commit is contained in `origin/main` and durable publication state
names that same revision and a non-empty generation. A local `main` ref alone is
never publication evidence. A Task without Git artifacts
may close as analysis. Delete is the explicit destructive route for unpublished
results. It records a durable cleanup transition, performs Git cleanup first and
deletes the Task row only after cleanup succeeds; failure leaves the Task and its
prior workflow state available.

Cleanup also proves that each current Task branch and worktree head is contained
in that published revision. A previously published result does not authorize
discarding a later commit. Preview binds current branch heads even when their
worktree is absent. The Git owner rechecks repository evidence after acquiring
its repository lease, uses non-forced worktree removal for Complete, and deletes
each branch ref with its observed old commit as a compare-and-swap. A late file
edit prevents worktree removal; a late branch move preserves the changed ref.
Publication remains recorded if cleanup needs repair. Task records and history
are retained after release; destructive Task deletion is not release cleanup.
The explicit published-duplicate absorption above is the only exception to the
ordinary source workflow-Done prerequisite. It is not ordinary Complete and it
does not use cleanup publication as a substitute for survivor ownership.

## Test Contour

The explicit `test-contour.mjs accept-release` command is a separate bounded
artifact-acceptance scope (ADR-0035), not a rolling contour refresh. It consumes
already-built previous/candidate Windows runtime artifacts, verifies and retains
their exact manifest hashes and never rebuilds or edits their release bytes.
Every run owns a fresh isolated root; its candidate RuntimeHost supplies a
persistent isolated environment across WMI replacement. All control calls,
pointers, locks, homes and synthetic adapter state belong to that root.
Success requires observed simultaneous live previous/replacement PIDs, exact
candidate ready lock/control identity, and previous process exit. The report
must enumerate checked and excluded scenarios; passing this lifecycle scope
does not imply coherent production-data or queue/outbox recovery parity.

Test Contour branding is a staging transformation before manifest hashes are
computed. It cannot mutate an already manifested release. A failed preparation
leaves stable launchers and the current pointer unchanged; artifact acceptance
still verifies every manifested byte, including the test interface document.

Explicit recording inputs prepare a fresh writable cohort from immutable capture
evidence through the existing preparation owner. The acceptance launcher uses a
v2 marker binding the exact root/profile and SHA256 of provider, preparation,
project descriptor and persistent config. Every independent Windows launch
verifies these identities and reconstructs the same isolated recording homes;
unknown profiles, partial cohorts or old launcher capabilities fail before Hub
startup. Cleanup uses stable root ownership, so changed config cannot prevent
closing its already-owned process job. Recording acceptance reads the existing
selection and never creates a synthetic Thread, replays user input, drains queues
by force or turns a waiting restart into successful replacement.

There is one rolling Test Contour. It is always built from `dev`; Agent Hub does
not deploy a contour per Task branch. The contour status records the exact
`dev` head it displays. Candidate preparation completes before the current
runtime is stopped, so a Git or build preparation failure leaves the previous
working contour available.

The agent UI smoke runs only against the verified isolated fake provider. It
owns one exact smoke Workspace/Stream/Thread identity in contour-local artifacts,
reuses it while the public snapshot proves that the same Thread is current and
attachable, and otherwise prepares a replacement only through the public
`new-task` lifecycle. Existing copied Streams, their names and display order are
not conversation authority. Before a create or UI send can reach the server,
the smoke artifact durably records its exact public request, command identity
and client message identity. A known HTTP rejection fails immediately.

A queued/deferred send receipt with no provider turn is only an admission ACK,
not successful smoke evidence. The smoke validates its command, client,
Stream/Thread and durable item identity, then reads the canonical public snapshot
until that same message receipt names the exact accepted provider turn; it does
not submit the message again or synthesize the turn from request fields. After
an unknown outcome or a crash between effect, response, terminal recording and
acknowledgement, recovery reads that original durable identity and creates no new
submission or provider effect. Successful evidence binds the exact returned
control receipt, Stream, provider, Thread, client message, provider turn,
rendered response and journal record. Matching text in another or older
conversation is not smoke success.

Every refresh is one persisted maintenance operation, not a provider turn. Its
identity binds the exact contour root, contour marker, port, model, source `dev`
head, candidate release and owner process. Contour refresh and verify use
one interprocess lease per contour root. A second process waits for that lease;
after acquisition it either coalesces with an already-ready identical target
(`root`, marker, port, model and source) or
creates a newer operation that deterministically supersedes the prior result.
Callers may read an exact operation revision without polling and must treat a
superseded readback as a stale result, not as validation of the newer contour.

The manual `lock` command is a foreground holder of that same per-root
interprocess lease. Its durable request receipt binds display owner, the exact
active Agent Hub provider/thread/turn, request ID, acquisition ID, release token
and the exact ready operation/source head/release rechecked after acquisition.
`lock-status` reports the current owner without
exposing the release token. `unlock` only requests release of the matching live
acquisition; replay returns its original held or released receipt, and a stale
unlock cannot affect a newer holder. Refresh, stop, verify, clone, adopt and
uninstall therefore serialize with the manual session without a parallel gate.
The existing refresh, stop and verify commands wait for the same lease for up to
ten minutes and then fail their wait; they do not bypass the hold or introduce a
second operation queue. Different contour roots remain independent. A `stale`
manual status says only that its saved receipt no longer matches the current
operation lock; the nested lock status remains authoritative for a concurrent
non-manual operation.

The foreground process owns the canonical lock but also monitors the bound Hub
turn. Normal unlock, handled helper cancellation and that turn's committed
provider-run terminal record release in `finally`; therefore a completed,
failed or aborted Codex or Claude testing turn does not leave a surviving exec
helper holding the contour. Codex's existing delivery terminal remains accepted
evidence. The provider-neutral record is written only by the owning completion
boundary and has no delivery outbox. Disappearance from `activeRuns` without
exact terminal evidence is unknown and does not release.
A helper crash leaves the canonical token-owned lock for the existing
confirmed-PID-death recovery. Neither age nor a missed heartbeat can retire a
live or identity-unknown owner. A stale manual receipt is diagnostic only and
cannot block operations after the canonical owner is gone.

The candidate release does not become `current` until its exact manager and
runtime report ready. The serving runtime writes a per-launch nonce and its
contour, operation, release, model, PID, expected port and actual listening port
into `/health`; all values must match the refresh operation. The root-local
instance lock must independently name the same spawned runtime PID, candidate
release and `ready=true`. A forged lock or a healthy unrelated server on the
requested port is not readiness evidence. If the operation owner dies, the next lease
owner finalizes an already-ready exact candidate or records the interrupted
operation as failed before starting new work. A planned replacement is reported
as refresh state and is not classified as a runtime crash.

Release preflight verifies the existing prepared PreRelease under the Workspace
Await lock (ADR-0058). It does not compose or rebuild a candidate, prepare rolling
dev, refresh/start a contour, or require the contour to display current dev HEAD.
The main audit and explicit upstream adoption gate remain mandatory. The stored
candidate must match the current accepted plan, Task revisions/results, Workspace,
repository and reviewed main base, with verified manifest hash and a clean managed
checkout. Missing/stale evidence, a partially completed freeze or an unfinished
Git operation is an error; preflight must not repair it by rebuilding silently.

Candidate head, tree and manifest hash are returned as the exact checked identity.
Before returning ready, preflight rechecks primary identity/dirty fingerprints,
candidate identity/phase and the accepted plan. Unrelated later Test work in dev
and contour unavailability cannot delay this check. Optional test-environment use
remains governed by Workspace policy. Existing configured repository-owned QA
continues to validate the prepared candidate and must return matching evidence;
the Agent Hub pipeline remains the one full final validation/build/publication.

This readback does not perform publication metadata freeze. The existing explicit
freeze operation binds its expected prepared head and plan before incorporating
version/CHANGELOG metadata; its final frozen candidate is the publication target.
An unchanged preflight reuses the same candidate without writing new manifests or
checkpoint request IDs. A legacy interrupted preflight remains unknown unless its
own canonical terminal receipt or final outcome proves completion; an existing
candidate alone never proves that preflight succeeded.

Persisted operations created before the target included `model`, or runtime
states created before the per-launch health nonce, are never eligible for
same-target coalescing. The next refresh replaces them; this compatibility guard
may be removed once all supported contour roots have completed one refresh with
the full identity.

Ordinary contour start, refresh and verify source resolution remains `dev`-only. The publication pipeline's explicit `--release-candidate`
verification is a separate gate: it resolves source bytes
directly from the Agent Hub-owned standalone release clone, requires that clone
to be clean and attached to `main` with `HEAD == refs/heads/main`, and records
that exact source identity. It never prepares or falls back to a `dev` checkout
inside the contour root. The ownership/isolation guard remains mandatory, and
the source identity is checked again immediately before and after candidate
deployment so a changed clone fails before activation. No ordinary command
selects this source mode. An ordinary `start` always resolves the current exact
`dev` identity before reusing a persisted runtime; a persisted release-candidate
runtime is replaced by `dev` rather than restarted.

The rolling contour is preview evidence, not release proof. Release validation
still requires the prescribed isolated candidate checks and publication
pipeline before production side effects.

A prepared recording cohort may exercise recovery under the boundaries in
RST-001 and ADR-0038. It does not change the single rolling contour, dev source,
operation lease or exact-readiness rules. Its captured Task Git references are
evidence only: Task/Release Git operations must fail before Git effects and Task
CAS until an independently owned Git cohort is available. A locally recorded
delivery or excluded operation cannot authorize production publication.

An ordinary production-data clone has no recording effect policy, so its
isolation is established in the cloned journal itself (HUB-217). Every cloned
Workspace takes the contour project as its working directory and has its release
workflow disabled, because a Stream with an empty working directory inherits the
Workspace directory before its own project and release startup reconciliation
addresses registered Workspace roots. Every historical Task Git reference keeps
its Task, branch, result commit and timestamp, but its repository is remapped to
an uncreated contour-owned path derived from the original repository key. Task
cleanup, which deletes branches and Task refs from references even without a
contour worktree, therefore fails inside the contour instead of reaching a
production repository. The production journal is only read by the clone.

Complete/Delete confirmation is a projection of the authoritative server cleanup
preview. Before the confirmed request the client displays every available Task
branch, managed worktree and HEAD, dirty/changed/untracked paths, result commit,
publication revision/generation/state and exact deletion target. The client does
not derive cleanup policy or publication authority, and cancellation sends no
confirmed mutation.

## Workspace policy and Release Manager role

`settings.releaseWorkflowEnabled=true` activates Task release tracking and the
built-in workflow rules. Release Manager authority is only
`stream.settings.releaseManager === true`; multiple Release Manager Streams are allowed.

The visible role is **Релиз-менеджер**. A one-time catalog migration transfers
the former persisted role boolean to `releaseManager` and removes the old key,
preserving explicit new true/false values and unrelated settings. Runtime
authorization and UI toggles use only the new boolean; names never grant the
role after migration. This role-setting migration is independent of developer-rule
text. Historical policy text recognition and replacement are removed (ADR-0066).

The role policy requires one service Task `Релиз [версия]` at release start,
reused across retries. It holds the whole prepared PreRelease composition in a
native linked checklist and retains Task titles and summaries. The publication
mechanism owns the version; a pending-version title is updated on that same Task
when the version is selected. The release manager checks clean accepted results
and records one immutable generation without stopping included executors or
freezing Task cards, branches or worktrees. The agent verifies that generation
rather than keeping a second manual identity register. A failed generation
remains historical evidence and does not require abandon or policy-unfreeze
before a correction. Unknown publication effects still require exact readback
and are never cancellation evidence. After verified publication, canonical completion
marks included Tasks Done and closes them; confirmed cleanup removes only their
branches/worktrees. Original Task cards and the release Task remain as history.
Checklist completion follows verified publication and cleanup. Failed local
synchronization or cleanup resumes separately, without replaying publication.
The next acceptance into Await prepares the next candidate when needed.

Both checkbox-generated policy blocks explicitly permit a user's instructions
for the current work to override conflicting workflow requirements, including
Task creation, validation scope and publication sequence. Only an explicit
request establishes an exception; urgency or frustration does not. The agent
must preserve its agreed scope in continuation and rotation context until that
work is completed or the user changes it, without extending it to later work.
This delegates workflow choices only: system instructions, safety/security,
unrelated developer instructions, tool authorization and integrity checks still
apply, and skipped checks and publication state must be reported accurately.
The default Task and release requirements below apply absent that exception.
This is prompt policy, not a new persisted authorization owner or a bypass of
the server transitions and evidence checks defined in this contract.

Workspace and Stream custom rules are opaque authored text, including copied
standard blocks, line endings and whitespace. Saving, reopening and rendering
instructions do not recognize, remove, replace or deduplicate such blocks.
Only explicit checkbox settings select the current generated policies; a missing
setting stays disabled and is never inferred from saved text. Catalog startup
does not rewrite rule revisions or backfill settings from rule content.
Generated policies are composed from stored text on each read and are not saved
back into custom fields. Copying a policy into a custom field intentionally keeps
that copy alongside any checkbox-selected policy. There is no automatic cleanup
of existing copies and no database migration for this removal. See ADR-0066.

When that setting is false or absent, every Task workflow status, including
Test, Await and Done, is an ordinary database transition through the same
Task lifecycle owner. It keeps row-revision CAS, durable operation outcomes,
exact claimed-turn bindings and status events, but does not acquire a Git lease,
require a Stream/project root, prepare a worktree, snapshot or integrate Git,
or invoke release preflight. Existing Git references remain unchanged. This
scope clarification is recorded in ADR-0031; Complete/Delete retain their
separate artifact-aware cleanup contract.

Workspace `settings.autoReviewEnabled=true` instructs every Task executor to send
its exact completed result directly to an independent Workspace Stream for review.
The flag defaults off and is independent of release workflow and Stream roles.
The implementation executor
does not review its own work. The review request is limited to the Task
requirements, actual Git diff and consequences of the changes. The Task is
blocked when those changes fail its requirements, cause or worsen a real
regression in existing behavior, or add unnecessary functionality that must be
removed. Pre-existing unrelated defects, impractical edge cases without
contract impact, unsupported findings and out-of-scope issues do not block the
Task. Initial review must use an independent Workspace Stream with the same
provider as the executor and without Astra. Only the user explicitly naming a
reviewer Stream waives either restriction; availability or a Team Lead choice
does not. If a reviewer becomes unavailable, the user or Team Lead may appoint
an eligible replacement and transfer all open findings and correction history.
Being busy alone is not grounds for replacement. After
a `RETURN`, the corrected exact result goes back to the same reviewer, and that
`RETURN` remains open until that reviewer confirms the correction.
The Task records reviewer Stream identity and links to the request, checked
result and verdict; Thread rotation does not change reviewer identity. Reviewers
reply directly to executors. An unchanged approved result is not reviewed again
without new evidence; checks and review can run concurrently on a fixed result.
Approval does not replace user acceptance or release validation. This is agent
instruction policy, not a new review scheduler or status gate.

Team Lead distributes Tasks and does not relay routine reviews. It implements
work itself only when explicitly requested by the user. Otherwise it joins for
a decision or reassignment.
Existing authored rules and disabled flags are preserved; no Workspace is
silently opted into auto-review. See ADR-0054.
The consolidated policy revision is documented in ADR-0065. The previous exact
issued Workspace V12, Release Manager V8, Team Lead V2 and auto-review V1 forms
remain recognized by the existing composer, without fuzzy replacement or live
custom-field writes. Remove them only when supported stores cannot retain them.

By default, the built-in rules require a Task for every change to a repository,
configuration, data, documentation or another deliverable. Read-only diagnosis,
explanations and answers do not create Tasks. If diagnosis becomes
implementation, claim a Task before the first change and continue only in its
main-based managed sparse worktree returned by the normal claim operation.
The generated policy does not add a separate project-selection instruction.

Disabling release workflow changes only Workspace policy. It does not mutate or
discard Tasks or historical publication evidence.

## Bootstrap of the release-control wiring

Publication plan reads during freeze and Git publication use the bounded
120-second repository-operation deadline. Planning may prepare managed Git
state and must not inherit the 10-second interactive Desktop deadline.
This does not relax the exact plan, manifest, repository or Git lease checks.

Before a replacement runtime is installed, the publisher reads the current
release plan with the candidate's `TaskReleasePlanService`, the authoritative
Task database and the ordinary Git release-evidence reader. One short read-only
SQLite snapshot captures Tasks and accepted lifecycle outcomes; it is closed
before Git evidence is read. The read-only store never creates a directory or
database, runs migration or legacy cleanup, and rejects a missing or incompatible
schema. Freeze, frozen-candidate preparation and the final pre-push guard each
read a fresh plan and require exact equality with the immutable checkpoint.
After installation, release completion remains owned by the installed canonical
Desktop runtime and its durable command identity.

The former `--bootstrap-mcp-context` publication option is obsolete and is
rejected explicitly. It called the installed public planner and therefore could
not correct a successfully returned plan from an older schema. Retain the old
bridge module only while historical callers remain supported; it is not a
publisher plan source and may be removed after that migration window.

The canonical completer must reach Desktop through both startup composition
layers. Historical publishers could explicitly supply a local MCP context when
an installation returned `Task release plan is unavailable`; that bridge called
the same installed planner and never covered a successful older plan projection.
It remains source-compatible only for historical direct callers and is no longer
accepted by `publish:changed`. The context capability was never part of durable
publication identity or logs; remove the unused bridge module when those callers
are outside the supported migration range.

An accepted release-projector correction that is not yet installed may bootstrap
one exact `Test -> Await` transition from its clean Task checkout. The local
cutover verifies the exact source commit and resolver SHA-256 before opening the
production stores, then requires that commit to be the unique immutable Task
result for the canonical repository. It binds both source identities and the
expected Task revision and status in the canonical MCP arguments hash, and
invokes the ordinary `hub_task_status_update` owner.
When a selected dependency must enter Await before the Task that owns the
accepted projector, the cutover may name that separate source Task. Source and
target must belong to the same Workspace and canonical repository. The source
Task ID, Test revision, unique result commit and resolver hash are bound into the
receipt; the Await owner acquires both Task locks in deterministic order and
rechecks the source Task and clean checkout inside those locks immediately
before the target lifecycle transition. The current target Workspace/Stream and
both effective repository roots are re-read under those locks. The same SQLite
transaction that begins the lifecycle transition then fences the exact current
target and source Task revisions/statuses, Workspace and Stream ownership, both
repository roots, the source result reference and the enabled release workflow,
so a settings or source-authority write cannot pass between readback and
transition. The target Task remains the only Task whose result, status and
release membership change.
The same Task, repository and Await locks, lifecycle transition, immutable result,
dev integration and unknown-receipt rules apply. PreRelease is prepared before
the target enters Await, just as for an ordinary acceptance request. A failed
composition leaves the target in Test; it never changes the source Task status.
The one-shot composition skips startup reconciliation of unrelated receipts and
does not patch `PreRelease`, refs or SQLite directly. Its request ID is subject to
the same no-blind-retry rule as the installed MCP operation.
If that extended receipt becomes unknown after a durable terminal outcome, its
operator reconciliation must reproduce the complete original cutover arguments
hash. The expected revision and status must equal the durable prior Task, the
source commit must be its unique result for the canonical repository and must
equal the recorded lifecycle result, and the resolver SHA-256 remains mandatory.
For a cross-Task cutover, durable lifecycle evidence additionally binds the
original source Task ID and revision. Terminal reconciliation uses that recorded
authority even if the source Task later advances; altered, missing or mixed
source identity remains unknown and performs no Git or lifecycle replay. A
pending recovery resumes with the exact immutable source evidence from its
existing transition and preserves that evidence in the terminal outcome.
Missing, altered or mixed cutover identity stays unknown; terminal reconciliation
performs no Git or lifecycle replay.

## Legacy cutover

A legacy open Await Task that predates Task Git references may be adopted only
through the explicit Release Manager-only MCP migration. The caller names the exact
terminal Stream turn, its reported result commit and an exact equivalent commit
already contained in local `main`. Adoption requires an unchanged Task revision,
no existing Git references, terminal evidence that names both the Task and the
reported commit, matching single-parent non-`CHANGELOG.md` patch IDs and changed
path operations, and an adopted commit that is an ancestor of local `main`.
The operation creates the deterministic Task branch, base ref and legacy
adoption marker ref. If an earlier status attempt already prepared that branch
at current local `main`, adoption may realign only its clean Agent Hub-managed
worktree and matching base ref to the verified result; any dirty, external or
otherwise divergent branch fails closed. Release evidence for the exact marker excludes every
`CHANGELOG.md` because release history is consolidated by Release Manager. It never
creates a synthetic commit or moves the registered primary checkout. The Task
stores the adopted immutable result and an append-only audit row identifying the
evidence turn, source commit, main commit, patch ID, actor and request. Arbitrary
`HEAD` adoption and adoption of an already evidenced Task fail closed.

Active legacy registry entries and Task-freeze rows are imported into their Task
aggregate before cutover. Every source row is exported to append-only history
and verified by source identity, payload cardinality and SHA-256. Only then are
the live registry/freeze source tables physically dropped. The retained history
is audit-only and is never read by release planning. All new work follows
ADR-0009 Task branches, ADR-0010 integration boundaries and ADR-0011
Git-reference authority.

## Independent release repository

`PreRelease` is materialized only in an Agent Hub-owned standalone clone under
runtime data. Its Git common directory is distinct from the registered primary
Workspace. It imports the exact frozen Task results without sharing branch
ownership; a linked worktree is never a release holder. Publication entrypoints
require the independent-clone marker and reject the primary Workspace.

The clone writes a content-addressed execution manifest and retry checkpoint
containing the exact plan revision, approved local and origin main base, Task
IDs and row revisions, result commits, owning dev integration lineage and
`PreRelease` head. Candidate construction uses detached temporary state and
CAS-swaps the branch plus checkpoint only after complete success. A failed exact
or three-way application therefore leaves the last good `PreRelease` and its
checkpoint intact. This is audit evidence, not a second readiness authority;
retry may reuse it only when the complete frozen identity and head match.

The registered primary must own and remain attached to `refs/heads/main` before
preflight, after candidate preparation, during retry, after publication and at
startup reconciliation. Release code must not switch, detach, reset, stash,
clean, or otherwise mutate its HEAD, index or working tree.

At runtime startup, reconciliation receives the working directory of every
release-enabled registered Workspace from the Workspace catalog. It audits those
roots even when `release-repositories` is absent and no checkpoint has ever been
written. A legacy Workspace without its own working directory uses the runtime's
registered default project root; historical thread roots are not treated as
primary authority. A detached primary and every linked `main`, `PreRelease`, or legacy-named
holder are diagnostic evidence; discovery performs no clone creation, checkout,
branch change, cleanup or removal. Checkpoint enumeration additionally recovers
Agent Hub-owned clones that are no longer associated with a registered root.
For each registered root the audit also derives the exact managed repository
layout. An existing `releaseRoot` without its matching valid checkpoint, or with
an absent/mismatched ownership marker or shared/invalid Git common directory, is
an orphan and yields `manual_required`; startup never adopts, repairs or removes it.

The effective Workspace and Release Manager developer rules, and the visible release
tooltip, state the same execution boundary: the primary is not a release checkout;
the frozen release runs only from `releaseCandidates[].releaseRoot` in the
standalone clone; legacy linked release worktrees are neither created nor reused.
Compatibility injection removes the old Release Manager instruction to update local
`main` or use a separate linked integration worktree.

After verified publication, synchronization is limited to a guarded `--ff-only`
update while the primary still satisfies the invariant. Existing dirty paths are
hashed first. Overlap with published paths, a non-fast-forward, or an invalid
primary yields `manual_required`: the successful release stands and primary HEAD
and local bytes remain untouched. A successful fast-forward must preserve every
pre-existing dirty-path hash.

Linked release holders from before ADR-0013 are detection-only migration
evidence. They are never reused or removed by startup/retry. Cleanup requires a
separate authorization and proven Agent Hub ownership. The detection guard may
be retired only after every supported installation has an independent-clone
checkpoint and no supported migration can contain a linked holder.

## Exact squash absorption

A Release Manager may replace one tested source result and one tested survivor
result with one new survivor-owned squash result. The operation is previewed
first and confirmed by the returned SHA-256. That identity binds both Task row
and release revisions, both branch/result/base commits, the repository, the
previous accepted survivor result, the reviewed clean-before commit, the new
clean result, the before-dev commit, the exact after-dev tree, every
source-result path witness, every clean-before-to-clean-after owner witness, and
the acting Workspace/Stream/provider/thread plus the stable preview request.
The later effect request has a separate immutable MCP receipt and does not
change the transfer hash.

One exact local bootstrap may use this same owner when a reviewed replacement
must supersede the current Progress survivor before the installed public squash
is available. The survivor must still reference its unique prior accepted Test
result; the source must remain Test. The immutable cutover proof adds the pinned
reviewed checkout commit/tree and projector SHA-256, exact clean-package
ZIP/bundle/manifest/inventory SHA-256 values, expected main and dev commits, and
the complete current survivor worktree tree. The first call is read-only and
returns both the ordinary transfer hash and cutover hash. Confirmation uses a
new request ID and supplies both hashes plus the preview request ID. Stale
source, survivor, main, dev, checkout or artifact identity rejects before a
lifecycle transition or visible Git effect.

Before replacing the Progress checkout, the Git owner writes its exact tracked
and ordinary untracked snapshot to an immutable commit/ref. Checkout uses native
ignored-file collision protection. A changed late tracked or ordinary untracked
snapshot fails closed; unrelated ignored bytes remain in place, and an ignored
collision is never overwritten. Target paths absent from the preserved tree are
derived with rename and copy detection disabled, so a rename destination cannot
bypass the same exclusive-create boundary. Recovery recognizes the exact
preserved-plus-subset-of-target-additions state, including an additions-only
replacement and a crash after the last file copy but before its index update.
The preserved ref and the additions-ready real index are separate recovery
facts. If a crash records the ref before preparing that index, readback resumes
the preserved-to-without-additions phase first; it cannot infer index readiness
from an exact worktree snapshot alone. This survivor-index phase is distinct
from a later pending dev-worktree materialization after the accepted dev CAS;
recovery routes each state only to its owning materializer.
The reviewed commit object is imported during
preview, so recovery never depends on a mutable source directory. The normal
squash proof and dev/materialization owner remain unchanged after survivor
staging. Only exact final Git readback permits the atomic Progress-to-Test
survivor and Test-to-Progress source commit. This is real Test evidence, not a
synthetic prerequisite. A subsequent ordinary Test-to-Await acceptance and
candidate preparation must still succeed; the bootstrap alone is not release
acceptance and cannot bypass a main/dev mismatch.

The Git owner verifies that the complete source delta exists in the new result.
A source addition cannot be deleted or replaced by an empty blob. The reviewed
clean-before commit must be an ancestor of the new clean result. Every changed
dev path must belong to that exact clean-before-to-clean-after delta; comparing
against the previous broad survivor result is forbidden because it could claim
excluded dev residue. Unrelated dev paths and history remain byte-exact. A path
already carrying the new result is preserved; a foreign overlap requires an
exact hash-bound resolved entry and may not retain the before-dev entry while
discarding the survivor delta. Application
creates one integration with parents `(old dev, new result)`, the accepted tree,
and one expected-old dev CAS. A no-op merge parent is not acceptance evidence.
After the ref CAS, the Git owner updates managed dev through a temporary Git
administrative/index view whose old-to-new checkout uses Git's native
`--no-overwrite-ignore` protection. It then advances the real index only through
the exact old-to-new two-tree check. That index promotion explicitly ignores the
already-verified worktree comparison: the temporary target index owns that check,
while the two-tree merge still rejects any real-index entry that no longer equals
the expected old tree. Thus recovery can advance an old index when the worktree
already exactly equals the accepted target without treating those target bytes as
a conflicting dirty edit. A concurrent tracked, ordinary untracked or
ignored local file/directory collision is preserved and keeps the operation
unknown; it is never erased by a hard reset or by treating ignored bytes as
disposable. Recovery may finish the real index when the worktree already exactly
matches the target. SQLite commit requires readback of the exact dev ref,
integration tree, index tree, clean managed worktree and absence of a local path
where the accepted tree requires deletion.

The existing lifecycle transition reserves both Tasks. After exact Git readback,
one SQLite transaction advances the survivor result/release revision and returns
the source to work, retaining both cards and histories. The lifecycle outcome is
the only durable transfer record. Its one post-transaction Task snapshot, unique
result reference and squash proof jointly own the Test result release revision;
release planning must not derive that revision from the proof's pre-transaction
survivor revision. A prospective Await plan carries this independently stored
identity while assigning the future status CAS its own newer revision. A changed,
missing or stale outcome, result reference or proof rejects acceptance and
composition. The net
projector revalidates every witness and the exact integration before projecting
the clean result. It merges that exact result automatically with the preceding
selected composition; any conflict rejects preparation. The rolling-dev tree is
not replayed into the release candidate. Unlike the optional net projection for
an ordinary Task, this squash projection is mandatory whenever the selected
result is absent from the approved base. Missing integrations, invalid or
unreadable proof objects, witness mismatch, non-unique ownership, and every
other unproved path reject preparation before candidate ref/checkpoint commit;
they never fall back to the effective dev delta. Candidate reuse revalidates the
same proof and requires its Task ID in the stored projected set. A result already
contained in the approved base needs no pending projection. Generic manual
merges receive no exception.

An ordinary later Test result may continue the squash survivor's first-parent
lineage without rewriting the immutable transfer outcome or its result revision.
The exact later result still needs its own uniquely owned Test integration.
Composition revalidates and projects the original clean squash result, then
replays only subsequent automatic, uniquely owned integration deltas in their
durable order. It never projects the descendant's whole tree or a broad
result-to-result diff: adopted dev context is not new release authority. Missing
latest-result coverage, ambiguous order/ownership, non-automatic continuation
integrations or a changed witness fail closed. Other selected Tasks keep their
original integration order relative to these continuation deltas.

Await validates the exact Test-owned result and its dev integration under the
Workspace Await, Task and repository leases, composes the prospective accepted
set into live `PreRelease`, and only then commits the lifecycle CAS. A failed
composition restores the prior live candidate and leaves the Task in Test. This
live integration is not an immutable operation generation: each ReleaseOperation
composes and freezes its own isolated generation, and publication reserves that
generation against the current accepted selection immediately before its first
external effect.
The acceptance proves current membership, not permission to publish. The
2026-09-17 acceptance-only Await identity is superseded; exact-result validation
and unknown-outcome handling remain in force.

After the survivor is durably published, the same transfer evidence may prove
the source result and branch/worktree published-by-transfer for cleanup. Exact
source head, clean worktree, survivor publication and expected-old branch CAS
remain mandatory; late bytes are never removed.


## Physical checkout identity for selected materialization

Selected materialization keeps pinned old/new Git blobs as composition authority
and separately binds exact physical old/staged-new bytes to supported built-in
EOL serialization. Effective worktree-path attributes and core.autocrlf/eol/
safecrlf configuration are captured and rechecked before CAS, materialization
and applied/UNKNOWN recovery. Clean Git equivalence does not authorize later
physical byte drift. Arbitrary filters, ident, encoding transformations and
unsupported text normalization refuse without invoking those transformations.
Private movement, hard-link ownership, no-overwrite and byte-exact backup/
rollback remain mandatory. No shared EOL/config/attribute conversion is allowed.

Before preparation, a text path may retain a complete CRLF serialization of
its normalized LF old blob even when current attributes require LF checkout.
If captured built-in text normalization permits it, version 2 records this
explicitly as `normalized-crlf`; new bytes still follow current checkout EOL.
The sealed reader reconstructs that exact old serialization. Binary/unset-text,
mixed or foreign bytes and unsupported transformations refuse. Once captured,
physical identity and checkout-authority drift still refuse; rollback restores
the exact old CRLF without changing shared configuration or attributes.

Version-2 intents/materialization journals explicitly separate blob and physical hashes
and retain checkout authority; version-2 completion receipts bind the complete
materialization record hash. Older journal/receipt identities are not silently
reinterpreted: unsupported recovery refuses while preserving bytes and original
UNKNOWN. R1 absorbed source fences remain unchanged.

Historical release evidence accepts only matching explicit intent/receipt/
materialization-record versions. A claimed version 1 carrying a version-2
seal, checkout authority or blob/serialization identities refuses; paired header
downgrade cannot turn sealed evidence into legacy interpretation.
Version 1 retains its original historical proof interpretation;
version 2 additionally checks the sealed materialization record and pinned
blob-to-serialization relations. Historical projection does not authorize
movement or use later rolling-dev bytes/configuration. Live recovery requires
version 2 and fresh physical/configuration checks; legacy pending recovery
refuses while preserving its original and data.

## Original native Await with already published notes

An UNKNOWN ordinary Await may resume without a fabricated process guard only
through the existing reconciliation, lifecycle, preflight and release Git owners
(ADR-0116). Its complete original receipt/CAS, current Task workflow/executor/
references, clean Test source and absence of a process guard remain mandatory.
The sole prospective result must be the original result. This exception admits
only a completed native prior candidate whose source equals durable OWN
publication, allowing only package version fields and
root CHANGELOG to differ. Its only dirty path must be regular staged CHANGELOG,
exactly the published blob with supported LF/CRLF physical text. Current
origin/main is independently pinned and rechecked; its later commits are fetched
as objects by ordinary clone creation but never become a composition base or
selected source through this recovery. Approval of external incoming remains a
separate publication boundary.

The release Git owner journals the original-bound move before archiving its
entire standalone clone and checkpoint inside its own root. Ref/index/worktree,
private bytes, original journal and manifest remain evidence; no cleanup, ref
repair, reset or serialization of old bytes is permitted. Authority and physical
pins are rechecked before movement. The same journal resumes interrupted moves;
changed originals, selections, publication, refs, index or bytes refuse. The
ordinary owner then creates its usual standalone checkout, composes the exact
prospective selection and performs the existing Task CAS/receipt settlement.
Only the preserved already-published prior checkout is retired; candidate
promotion/CAS retain ordinary rollback. Terminal repetition reads the same
outcome without new Git effects. This migration is removable once the pending
ordinary native Awaits lacking their own preparation intent are settled; it
does not relax ordinary dirty-checkout rejection or authorize publication.


## Managed source custody after a forward claim fence

ADR-0131 does not admit a new Git result, acceptance, release or cleanup. The
existing Task Git owner holds its Task lease across ordinary prepare-to-claim;
a forward successor instead verifies the exact already managed clean source,
registered base/branch and declared ignored WIP inventory under that lease.
It performs no dependency ensure, branch alignment or source materialization.
A durable exact-cohort retirement certificate and existing claim writer authorize
only the predeclared successor binding. WIP/history and the legacy UNKNOWN remain
preserved, and active/queued previous-executor work still blocks actual assignment.
Publication/installed capability and the public release set are unaffected.

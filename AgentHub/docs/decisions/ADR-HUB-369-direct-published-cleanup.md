# ADR: Exact direct-publication evidence for canonical Task cleanup

Status: proposed implementation; exact result remains subject to review.

## Context

Historical direct delivery can port a Task's exact changes into a publication
without a unique Test reference or source-commit ancestry. Ordinary Complete
then refuses or labels its clean managed checkout unpublished. The user asks
to close published cards and remove their unnecessary managed Git artifacts;
keeping permanent branch backups is not the requested result.

## Decision

Extend the existing RM-only Complete envelope with `published_delivery` and
`completion_mode=published_delivery`. The existing Git owner reads the original
terminal publication journal and its prepared artifact by exact raw hashes.
It proves Task/repository membership, published commit/tree, tracked-main
ancestry and the source range from its immutable Task baseline. A two-parent
baseline merge can include only entries from those exact original parents.
It compares the whole source and immediate publication change payload, retaining
paths, modes, whitespace and binary bytes. Hunk coordinates and blob-ID headers
can differ after the port; root CHANGELOG belongs to the release owner.
Context is retained and must uniquely identify every changed block in both
before/after files. Identical line edits in a different repeated block do not
prove delivery. The existing batched blob reader verifies raw Git bytes;
binary/non-UTF8 changes require whole before/after identity.
If the exact entire source result is already an ancestor of the named original
publication, that stronger native proof replaces the port comparison.

The proof is a live owner capability, not a caller-supplied boolean, fake Test
reference or inserted publication receipt. The existing preview/token and
Task/dev leases admit an exact cleanup intent before the existing native Git
owner removes the worktree, branch and service refs. Ignored/dirty/later work
still refuses. Card/history and the prior workflow survive closure.

The same lifecycle operation retains admitted evidence after partial cleanup.
Original-ID RM reconciliation validates the original MCP arguments hash and
stored intent/outcome, rechecks historical bytes and remaining Git pins, and
finishes only that operation. An old UNKNOWN without this admission is neither
replayed nor declared no-effect. Terminal outcome readback performs no Git work.

## Scope and retirement

This is a compatibility route for exact retained terminal direct-delivery
records. Other absorbed/ambiguous history and later unpublished work do not
inherit its authority. Retire the input after those legacy artifacts are gone.
There is no new publisher, archive copy, backup branch, SQL writer, installation
or runtime-effect authority. Actual old-card confirmations belong to RM.

## Completed operational work

The user also requires cleanup of a completed filesystem operation whose Task
has no implementation result. RM explicitly attests that completed operational
outcome with `completion_mode=operational`. The same Git cleanup owner requires
no result/adoption/squash, HEAD exactly equal to its immutable Task base and
published/tracked ancestry. Dirty or ignored artifacts still refuse until their
artifact owner has retired them separately. No product Test, workflow Done or
new delivery receipt is invented. The same admitted cleanup/outcome recovery
handles partial deletion; no second closure writer is introduced.
An already closed zero-own-delta service can use this cleanup without reopening
or rewriting its card and original completion timestamp.

## Original confirmed Delete after artifact retirement

A legacy Delete can have a durable failed cleanup transition and an UNKNOWN
outer receipt after the ignored-data guard refused removal. Error text or
current absence cannot prove no-effect. RM instead supplies its original
successful preview identity. That preview's actor/token/Task reconstruct the
exact original confirmed arguments hash. The same existing transition must
still bind the current Task revision, executor, workflow and results.

The Git owner compares remaining worktrees/heads/dirty paths and service refs
against that original plan, allows only retired ignored paths and artifacts
already removed by this cleanup, and verifies each dirty file against an
existing retained copy outside all deleted sources. This read creates no copy
or archive. Missing/changed bytes, new commits/artifacts or Task drift refuse.

The existing SQLite mutation owner records the original failure plus forward
authority in the same transition before the existing native cleanup owner
acts. SQL retry never repeats Git. The outcome retains the original failure
and supports exact terminal readback after a lost outer reply. The original
request is completed forward, never declared no-effect or replaced with a new
Delete ID. An unrelated original claim remains UNKNOWN. Historical cases with
no positive preview/admission or missing preservation remain unsupported.
Before continuation admission, the live owner can refuse only its new
reconciliation attempt; the old UNKNOWN is unchanged. After entering the
existing SQL/native boundary, ambiguity is retained. Terminal readback uses
the same public Task presentation as the original Complete/Delete response.

## Evidence

Focused public-MCP tests use real Git/SQLite and disposable publication records:
non-ancestor exact port with no Test ref; clean deletion/card preservation;
changed evidence, non-RM, later data and stale preview refusal; unsealed UNKNOWN
preservation; partial native deletion and lost terminal MCP write reconciliation.
The actual historical source projection is separately read-only verified; its
original journal/artifact and real managed source are never deleted by tests.

## Review correction: staged preservation

The initial checker compared only working bytes with the index, missing staged
changes against HEAD and distinct staged content on an MM path. The same owner
now verifies every unpublished index blob through the existing batched reader,
and working bytes independently. Existing retained-file entries may name the
same path with distinct SHA-256 hashes. No copy/reset/stash is performed, no
new Delete identity or writer is added, and both admission and immediate native
pre-removal validation use the complete check. Focused public-MCP regressions
refuse staged-only and working-only MM proofs without changing the original
failure, Task, index or source; sufficient copies complete that same original.

## Original combined delivery and retained journal

Actual application exposed that five earlier Tasks were ported together before
the final sixth Task. Comparing every Task with the final commit's parent delta
rejects those real earlier ports. Permit only the original run's exact from to
terminal first-parent chain as the combined range, retaining the previous
last-port route. The complete own Task delta must survive with exact paths,
modes and unique ordered raw before/after contexts. Add/delete, binary,
non-UTF8 and unterminated content require whole identity. Missing or ambiguous
contributions refuse; there is no contains-strings or arbitrary-range proof.

An explicit optional original journal path supports the retained historical
file after the current pointer advances. Its exact hash, runtime identity,
prepared artifact and membership remain authoritative and are reread unchanged.
No discovery fallback, fabricated root/journal, publication or receipt writer
is added. Already executed cleanup receipts and the earlier reviewed result
remain immutable; actual historical confirmations still belong only to RM.

### Review correction: original removals must survive

Unique before/from and after/terminal blocks can both exist when the original
before block remains and the expected after block was appended elsewhere. That
does not preserve the Task replacement. In addition to the existing context
checks, map each complete source edit's removed/added line ranges inside ONE
actual zero-context Git edit of the original from-to-terminal delta. Retained
context lines must remain unchanged and map to their exact after positions.
The unique raw snippets bind those coordinates to the original objects. Git's
zero-context diff uses explicit algorithm and zero inter-hunk context, so its
old/new spans contain actual edits rather than unchanged surrounding lines.
This adds only reads through the existing Git/object owner, with no cleanup,
publication, receipt or temporary-object writer. The maintained real-MCP negative
retains old before text and uniquely appends after text; refusal precedes preview.

## User-approved overlap absorption policy, 2026-10-28

The user replaced the earlier duplicate/inseparable-outcome criterion with this
exact rule, including the subsequently requested review requirement:

При любом пересечении задач обнаруживший его исполнитель поглощает другую задачу в свою, сохраняя всю работу и требования, проверяя результат и завершая штатное поглощение. Так связанные изменения получают одного ответственного и доводятся до выпуска целиком. Согласование не требуется: исполнитель уведомляет TL, а TL — пользователя; ответа не ждут. При включённом авто-ревью, если поглощаемая часть не имеет положительного ревью, обязательно провести её ревью в составе объединённого результата.

The built-in Release workflow is the owning policy source. Its contradictory
independent-dependency exception is removed. The existing saved/stopped handoff,
full requirements and native checklist transfer, ordinary return/Test/Await,
canonical selected composition, combined-closure preview/confirmation and
absorbed-versus-published distinction remain. Previously accepted unchanged
parts retain their exact independent review; combined changes and open findings
remain subject to the existing review owner. Executor-to-TL and TL-to-user
notification is the explicitly authorized operational exception to final-only
reporting, not an approval wait. No second raw Workspace policy owner is added.

## Combined closure preserves accepted native resolutions

Actual combined-closure validation rebuilt the complete Await set in a disposable
repository and lost the already accepted native resolutions, refusing a future
Task's conflict before source closure. Revalidate the exact current prepared
candidate with the existing prepared-generation source owner instead. Exact plan,
whole selected evidence, base and provenance, native histories and selected
content, manifest digest, checkout and primary guards remain mandatory. Recheck
the same binding around the existing fresh authority callback and refuse drift;
do not replay composition or rewrite the holder. Nonmatching/absent prepared
state still uses ordinary disposable composition. This is not release membership
approval, publication or an alternative closure/receipt writer.

Review correction: retain the existing final authority callback after the last
prepared-source verification as well as the between-pass holder check. Equal
holder bindings do not prove that external authority stayed current during Git
verification; a late authority change refuses before returning a proof.

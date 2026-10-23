# ADR-0131 — Forward custody of a legacy preparation original

## Context

The original preparation can be UNKNOWN after a successful main audit and a
later strict dev-ancestry refusal, without a historical owner checkpoint. A later
bootstrap does not settle it. Replaying initial prepare or inventing a checking
stage would erase the distinction between unknown past and proved future work.

The user authorized preserving forward continuation of that same original.
It remains distinct from Task claim custody, stale-main release continuation,
Task acceptance and public publication.

## Decision

The existing frozen local-source consumer exposes `executePreparationForward`
through the same default runtime factory and genuine RM capability. The service
requires the exact original envelope/hash/caller and a current complete envelope.
Selection, plan and publication cannot change. The new mechanism may bind its
own reviewed source/current installed base; neither old arguments nor old source
receipts are relabelled. There is no new MCP intake, publisher or operation ID.

The terminal-evidence path requires a non-serializable observer verifying completion of
the exact old execution and its native child work using authoritative execution
evidence. An absent PID, missing job/candidate, current references, provider turn
completion alone or a user-supplied boolean is insufficient. The concrete frozen
operational entry and observer receive independent review before live effects.
Unavailable or insufficient evidence refuses before custody transfer.

The existing Await → selected Tasks → repository leases enclose observation and
the revision/identity CAS. The existing MCP operation's preparation column gains
an explicit forward segment, bounded to 64 events/128 KiB. It records immutable
legacy identity/error/outcome, current source custody, owner epoch, observed
effects and new completion. Every transfer and effect checkpoint appends to that
segment. The raw legacy status, result, error and timestamps remain unchanged.
The original remains UNKNOWN; readback separately exposes the proved forward
completion. Old serialized resume is not silently upgraded.

A persistent SQLite trigger fences legacy-field replacement and old schema
checkpoint writes even from connections opened before transfer. Stale owner or
revision updates fail CAS. Failure before owner transfer cannot change the
winner. Leases and terminal evidence, rather than a new epoch alone, establish
that it is safe to enter effect ownership.

The existing Git candidate owner inventories retained checkpoint, native journal,
references, checkout/index and bounded native staging records before its effects.
It preserves main audit/tracking refresh and old native staging. Native merge
continuation uses the existing exact identity and convergence checks. A complete
candidate with the same original request/hash/publication, exact approved tree,
selection/base/provenance and verified native history is adopted without a new
candidate or manifest. A partial promotion without complete candidate proof
remains retained/refused at that specific boundary. No generic force, rollback,
cleanup or absent-candidate NO_EFFECT inference is introduced.

Forward integration reads existing managed dev through its owning read-only
inspection under the repository lease. Missing, dirty or unfinished dev and
pending bootstrap/withdrawal/block records refuse without creating worktrees,
aborting merges or running implicit recovery. Strict ordinary `prepareDev` is
unchanged. Its dev-only work and prior Test evidence remain intact.

The new completion is committed by the existing catalog owner under synchronous
selected-row/RM/owner validation. Lost terminal replies read that exact forward
completion; ambiguous persistence preserves the original and native journal.
Exact completed retry is read-only. This is not publication or installer success.

## Validation and limits

Focused real public-consumer/Git/SQLite tests cover the ancestry refusal after
main audit, normal bootstrap, retained UNKNOWN history, unproved invocation
refusal, lost transfer/terminal replies, committed-candidate adoption, old SQLite
connections and epoch/history CAS. Failures are controlled injections, not claims
of actual OS-kill testing or live production recovery. A concrete original with
insufficient invocation/child completion evidence must still refuse the terminal
path. The separately authorized isolation path below never invents that proof.

## Explicit isolated effects (2026-10-23 decision)

The same local observer may instead return `preparation-effects-isolated-v1`.
It proves the exact original invocation terminal and binds the RM authorization
and finite owner-generated future write-target inventory. It does NOT assert
`joinedChildren`, terminal legacy outcome or NO_EFFECT. Serialized MCP inputs
cannot select or manufacture this evidence. The original state/event history
records the reason, proof and immutable isolation plan in its existing column.

The existing candidate owner allocates a full independent root by exact original
identity, using a bounded path key plus full identity collision check. A selected
OID-only Git bundle transports verified objects; no linked worktree, alternate,
shared mutable object store, imported config or template/hooks is allowed.
Native merge/checkpoint/journal/marker/index/ref effects stay inside that root.
Inherited config and Git environment are recorded only by hashes; local commands
ignore system/global/Git-path configuration and disable hooks/fsmonitor/automatic
maintenance. Read-only remote authentication remains with its existing owner.
No remote ref/publication writes are admitted by preparation.

The existing operation column is also the durable candidate routing authority.
Production and local default factories read it; frozen candidate reads therefore
cannot be redirected by late legacy checkpoint/ref writes. Its SQL identity is
fenced against old UPDATE, DELETE and INSERT/REPLACE (including connections with
recursive triggers disabled). Missing/ambiguous identity, unsafe path, altered
config, unverified objects or partial preparation is retained and refused.
Leases, current main/dev/selection/publication validation and native resolution
review remain mandatory. Future publication still uses the ordinary frozen
candidate pipeline. This is not authority to isolate unrelated operations or
protect against arbitrary malicious code with the user's privileges.

The isolated path is specifically an exclusion of legacy write targets. An
unexpected same-original candidate or partial promotion already in that legacy
namespace is preserved and refused before transfer at its exact root; it is not
silently recomposed into a second candidate. Exact imported-candidate handling
would require its separately checked owning proof. The unchanged terminal path
can still adopt its proved complete original. Once isolation is owned, loss of
its response reuses the same independent candidate/head without duplication.

New preparation Git effects use the existing TaskGit repository process guard
under the same already-held lease. The scoped Git queue permits one child per
guard without a global lane. An interrupted current child leaves that existing
guard unresolved and the next admission refuses; isolation of the old invocation
is never reused as proof that a newer invocation or child has completed.

## Retained root CHANGELOG after an installed-source transition

An original selected result can inherit exact release-owned root notes from its
then-installed source while a later installed repair carries newer agreed-main
notes. Forward preparation may bind one `historicalChangelog` record in the
existing closed local-source provenance. It binds the same original request and
argument hash, its original installed manifest/release, one selected result and
revision, exact source commit/tree, and `CHANGELOG.md` mode/blob. The existing
operation reader supplies the immutable original envelope; a caller field alone
is not original authority. Admission verifies it before custody transfer.

The original envelope must name that installed manifest; current installed-source
authority remains independently verified. Canonical runtime retention must still
bind both manifests. The retained hash-pinned manifest must name the exact plain,
clean source HEAD/tree, an ancestor of the current source base. Both that endpoint
and that exact selected result must carry the same root notes mode/blob. Missing,
foreign, dirty, altered or nonancestor evidence refuses without another endpoint.

The resulting native authority is path/result scoped. It never adds a historical
commit to history `bases`, `metadataBases` or adoptions: those also govern package
versions. Package-version checks and unselected merge-side refusal are unchanged.
The binding stays inside the normal candidate manifest/checkpoint, survives
normalization/reuse/generation/freeze, and is reverified through the same original
record and retained source on readback. There is no second journal, historical
UNKNOWN settlement, publication permission or release-history rewrite.

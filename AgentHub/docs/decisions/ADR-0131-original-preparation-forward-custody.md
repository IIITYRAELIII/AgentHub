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

A non-serializable terminal observer is mandatory. It must verify completion of
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
insufficient invocation/child completion evidence must still refuse.

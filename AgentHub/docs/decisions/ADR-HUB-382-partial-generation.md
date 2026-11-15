# ADR-HUB-382: preserve failed partial generations during amendment

## Context

The compose receipt had attempt identities, but the Git generation directory was
keyed only by operation, generation and repository. A failed, unregistered next
generation could retain prepared metadata A. After a legitimate explicit
amendment to metadata B, currentGeneration + 1 selected that old directory again.
Its immutable input guard correctly refused, leaving no supported continuation.

## Decision

Use the existing amendment and receipt owners. At amendment capture, recognize
only the contiguous unregistered compose slots whose exact canonical receipts
are all terminal failed, hash-valid and bound to this original authorization and
last registered generation. Bind their complete receipt digests into the hashed
amendment. The last failure must match the original compose error. Existing
not-applied target observations, genuine RM access, exact membership/metadata and
revision CAS still govern the amendment.

Compose uses the next honest generation after those captured slots. Before
admission it observes targets again. Inside the existing SQLite transaction, the
owner rechecks captured receipts, absence of registered generations in those
slots, current amendment, exact composition input and execution owner. It writes
only the usual compose receipt. The candidate later advances currentGeneration
through the normal immutable-generation owner, with the last registered
generation as its predecessor. Crashes reuse the same intent or exact stored
generation; a changed input cannot supersede an unresolved/applied compose.

Old readers and amendments without this optional internal capture retain their
ordinary path. Legacy evidence is not retroactively enriched: the genuine RM
submits a fresh explicit ordinary amendment with current CAS to obtain the new
capture. No new public option, ledger, SQL writer, generation edit, directory
deletion or publication replay is introduced. UNKNOWN and any contradictory
receipt/readback remain a refusal, never not-applied credit.

Because allocated generations may be sparse, the existing amendment admission
guard checks all registered generations and unresolved compose receipts above
currentGeneration, rather than only currentGeneration + 1. A target-readback wait
cannot let a fresh amendment abandon its original stored candidate/intent and
fall back to an earlier failed slot. The existing same-original continuation
settles that candidate first; ordinary amendments then proceed from the settled
current generation. Older historical receipts are not a global veto.

## Evidence and limits

Real Git/source-generation storage and durable release SQLite exercise the
public continuation, two registered generations, a failed prepared partial and
new metadata. The old partial plus receipts survive; the corrected candidate
freezes under a new identity before any publication. Focused negative controls
cover ambiguous/applied compose, external effect readback, active owner, CAS and
receipt drift. Runtime delivery and publication remain the release manager's
separate actions.

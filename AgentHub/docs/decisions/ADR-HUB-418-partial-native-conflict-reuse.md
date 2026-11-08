# ADR-HUB-418 - Reuse completed steps from partial native captures

## Cause

The sibling lookup required a completely finished composition. A committed,
verified resolution was therefore hidden while a later step was conflicted.
Actual release journals also carry selection-specific planRevision/selectionHash
inside baseProvenance, and upgrades change the implementation stamp. Removing
only the completion check would not make those actual hints usable.
The current HUB-416 verifier also returns successful ordinary Git binding evidence;
the older reuse caller incorrectly treated every non-null return as a refusal.

## Decision and authority

The existing sequencer may read exactly the recorded completed prefix of a
partial journal: integer next, matching merges length, matching ordered Task/result
entries, and head equal to the last recorded commit. The active next conflict,
working tree and unrecorded commits are never solutions. Snapshot/custody and
unchanged-at-use checks remain mandatory; no source capture is edited.

Whole-prefix adoption still requires the entire stamped reuse context and ordered
Task entries to match, followed by current verification of each step. Separately,
a stamped conflict-only hint may differ in implementation and the two selection
labels planRevision/selectionHash. Every other context field, including effective
base, installed source/manifest, repository/common dir and history authority, must
agree. Missing stamps do not gain this path; the existing prepared-checkpoint
legacy bridge remains separate and complete-only.

A conflict-only hint cannot supply a prefix. Its recorded resolved commit must
have the recorded two parents. Actual old and current whole conflict stages must
match. Only regular-file conflict afterimages enter the CURRENT automatic tree;
the current verifier checks the new commit with new parents and no old review or
selected-content exemption. Unique outside-marker compatibility bytes, changed
stages or foreign provenance remain ordinary conflicts. Current final history,
selected content, authority, import closure, intent, dirty/ignored and CAS guards
remain unchanged. No new cache, writer, ledger, review gate or installed patch.

The reuse caller accepts either the older null success or exact current ordinary
evidence with the checked before/commit/two parents and conflict-path array, never
a review/compatibility capability. Fresh prefix evidence is retained for the
current sequencer's reopen checks. A current selected-content refusal rejects the
hint and leaves ordinary conflict handling; it is never treated as success.

## Evidence

Small real Git regressions first fail on the parent: a completed first resolution
followed by an active second conflict is unavailable, and cross-selection reuse
stops at the first conflict. The correction reuses only committed steps, preserves
the new automatic contribution and both new parents, leaves active source WIP and
journal untouched, and refuses changed stages and foreign history. Existing
original-ID timing records lookup, candidate counts, transport, prefix and conflict
reuse separately. Fixture elapsed is observational, not a production speed claim.

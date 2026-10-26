# ADR-0068 — Exact result composition before absorbed closure

Status: accepted

## Current results sharing an older integration (2026-10-26)

Native selected composition merges exact Task results from agreed main. A shared
older integration in several result histories is not itself the current result
of any of those Tasks. Derive unambiguous integration owners first. An ambiguous
historical integration may remain unassigned only if every claimant already has
an independently owned integration naming its exact current result as a side
parent. Omit that shared integration from all claimants' evidence; it contributes
neither coverage nor candidate bytes. Preserve unique historical ownership and
all repeated direct integrations. Missing current coverage, duplicate current
ownership, ancestry-only coverage and foreign wrappers retain their refusals.

This refines the former blanket ambiguity refusal for otherwise separately
integrated current results. It does not authorize dev content, absorption, a
changed Task base, a caller allowlist or mutation of historical receipts. The
native selected-history and selected-content checks still own the release tree.

The user requires prevention of selected-release composition failures in the
current release, in addition to repair of the existing mixed history.

Two distinct claims were previously conflated: a Task result can be an ancestor
of dev while its own effective integration carries only an earlier result; a
survivor can contain an absorbed branch while its selected release projection
cannot reproduce the combined work. Successful code tests prove neither claim.

Keep the existing prospective Await preparation and status CAS. At the owning
Git evidence boundary, after unique integration-owner selection, require an
integration carrying the exact latest result. A later no-op commit still needs
ordinary Test for its new identity. Do not infer coverage from foreign nested
ancestry or equal trees: that would disagree with the canonical net projector's
exact-result requirement and could silently fall back to an incomplete delta.

Before absorbed closure, validate the survivor plus existing Await membership
through the same planner, approved-base resolver and candidate composer. The
survivor stays Test if it was Test; the proof is not acceptance. Preserve the
existing Workspace Await -> Task -> repository lock order and pass the owned
repository lease into evidence reads. Repeat validation at confirmation and
bind its exact identities into the existing preview token and closure receipt.

Composition validation uses a fresh temporary instance of the existing release
Git owner and its unchanged prepareCandidate algorithm. The temporary instance
inherits the contour-effects policy and never touches the live candidate or its
checkpoint. Return only validation identities, never a publishable scratch path.
Copy source Git objects through a temporary bundle, without copying or disabling
repository hooks/configuration; Git clone protection remains enabled. The primary
still supplies repository identity and invariant checks. This also supports Git
versions that reject direct cloning from a source with installed core.hooksPath.
Cleanup completes before validation succeeds. A crash may leave scratch data but
cannot replace live PreRelease. Frozen-successor optimization is deliberately
unavailable in a fresh proof; inability to reproduce the selected composition
blocks closure. No parallel projection algorithm or readiness registry is added.

Keep Test integration semantics: adding a failure after dev/result refs changed
but before Task CAS would create another partial-effect boundary. This decision
instead strengthens existing Await admission and adds the missing pre-closure
proof. New result bytes must reenter ordinary Test and acceptance. Agent rules
prohibit merging rolling dev into a Task and require immediate composition checks
after selected result/membership changes. Absorbed cards/history are retained;
branches/worktrees remain until publication and confirmed cleanup.

Validation must cover late result/early integration, direct exact integrations,
rejected unintegrated no-op successors, foreign ancestry, absorption refusal with preserved
source state, preview invalidation, lock order, base/selection drift and unchanged
live candidate bytes on both successful and failed scratch composition. Existing
Await refusal and unknown-commit reconciliation remain authoritative.

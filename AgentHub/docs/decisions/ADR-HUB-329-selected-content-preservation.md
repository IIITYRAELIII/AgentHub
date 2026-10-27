# ADR-HUB-329: Native ancestry does not prove selected content

Date: 2026-10-26
Contracts: REL-001, SYS-001
Status: correction under focused verification and independent review

## Observed defect

The native sequencer treated a selected result already reachable from the
current prefix as contained. Its readback proved the same ancestry and unchanged
prefix. Neither check established that later commits had retained its changes.
The historical selected rotation result is an ancestor of the delivered base,
while that base's controller and Desktop selection rules omit approved changes.
The same counterfactual Git replay identifies nine clean missing paths in that
base and no clean missing paths in the restored accepted current source.

A second gap excluded an entire conflict path from automatic-byte preservation.
Resolving one conflict by copying an old whole file could therefore discard clean
changes elsewhere in it without using the compatibility-review boundary.

## Decision

Keep the native merge history, original Task bases/results, selection authority,
existing private journal, exact review binding, primary/origin/lease/CAS guards
and the one publication owner. After all selected steps, inspect each selected
delta with Git's explicit original merge base against the chosen final commit.
This creates mathematical Git objects only; it never applies the repair result
or changes the chosen checkout/ref. Missing clean selected content refuses
before delivery. Prepared/frozen readback repeats the same invariant, including
legacy journals, rather than trusting a stored boolean or ancestry alone.

Text conflicts are scoped to their marker ranges. A zero-context native diff
must not delete or insert outside those ranges without existing exact review.
Binary/type/delete conflicts retain exact parent choices; additional bodies use
the same compatibility-review authority. Clean omitted selected paths include
deletions and modes as well as file contents. A later selected correction is
evaluated in the full final composition, not refused prematurely at a contained
prefix that it is about to repair.

Compatibility changes already authorized by the independent native review are
derived from its verified automatic/final tree diff and matched to the final
whole mode/blob afterimage. A caller cannot supply an allowlist, retarget an old
review to another body or infer acceptance from a matching path name.

## Limits and evidence

Genuine overlapping conflict choices are not proof of semantic equivalence;
the existing native resolution/review and functional checks still own them.
This does not claim that Git can infer requirements from arbitrary rewritten
code. It removes the concrete silent ancestry shortcut and whole-conflict-file
permission that admitted missing clean changes.

Focused real-Git regressions cover contained rollback, unrelated later content,
restoration by another selected result, reopening a completed legacy journal,
lost deletion/mode, a clean omission beside a conflict and exact reviewed
compatibility. Independent review, ordinary compatible application, Test/Await
and the original release's later prescribed pipeline remain separate. Historical
failed generations and UNKNOWN receipts are not rewritten or called successful.

## Explicit unchanged automatic context (2026-10-26)

The accepted HUB-351 Test exposed an inherited dependency context: the real merge base
was `9a825`, while the immutable Task custody base remained `05c2`. Three source
entries were identical to dependency `9a825`, and the native automatic result retained
newer Dev entries. Counterfactual replay correctly reported obligations but the
old actual-diff review could not authorize retaining unchanged automatic entries.
This is a compatibility decision, not evidence that every such difference is safe.

Keep immutable Task bases and the old actual-diff review unchanged. A NEW whole
authenticated native-review message may additionally carry
`selectedContentCompatibility = {binding, acceptedObligations}`. Its versioned
binding is derived entirely by the final-check owner from Git and includes the
complete ordered Task/base/result set, final commit/tree and ALL uncovered replay
obligations. Each obligation binds the Task, immutable base/result, replay tree,
path, expected and retained mode/type/OID (or absence), prefix and real automatic
tree/entry. The accepted indices select exact records in this complete binding.
The retained entry must equal that real automatic entry. Extra/stale/tampered
bindings, different Task/base/body/selection and unaccepted obligations refuse.

The existing verifier authenticates both the original native diff review and the
new compatibility message against exact catalog receipts. The same private merge
capture may add this second review only while undelivered, after successful full
replay validation; it preserves the original review. No fake file edits, Task-base
rewrite, history reset, second publisher, caller allowlist or new approval ledger
is introduced. Prepared and historical readback rederive the entire binding.
The HUB-351 Test proof does not authorize another selected PreRelease composition.

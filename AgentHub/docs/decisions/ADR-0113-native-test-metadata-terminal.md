# ADR-0113 — Complete an applied native Test after metadata edits

Status: accepted for the explicitly authorized recovery correction.

A description update advanced the Task revision while its native Test merge was
being prepared. Git reached the exact recorded target, but the terminal row CAS
correctly rejected the stale revision. Replaying the Test would risk another
effect; restoring the old description or changing SQL receipts would discard
evidence.

The existing reconciliation, lifecycle, Git and TaskBoard owners provide one
narrow terminal-only recovery for ordinary originals without explicit caller
CAS or selected/absorbed/initial-source families. Workflow, assignment, result
references and original envelope remain unchanged. The Git owner checks the
original native journal and merge capture, exact ordered parents, source/base,
main/dev/target trees and clean source/dev/staging indexes under its existing
locks. It performs only Git reads and refuses every retained process guard.

The lifecycle repeats this proof immediately before the TaskBoard transaction.
That transaction compares semantic state with the immutable prior Task and CASes
the observed current revision, retaining the current description and other
metadata. It writes the original terminal outcome and result references. The
receipt owner settles that same original; repeated recovery only reads it.
No merge, snapshot, provider effect, restart, alternate ledger or general CAS
waiver is introduced. A race or unproven drift remains unknown.

Behavioral evidence uses real isolated Git and SQLite through these owners:
metadata preservation, workflow/assignment/reference/source/dev/guard refusals,
a terminal CAS race, and repeated recovery without Git or outcome changes.

# ADR-HUB-448 — Published parent of a returned Test

The native absorption history check may retain a source-side merge at the exact
result of the source Task's recorded Test and normal return. The merge must
have two parents and its second parent must equal the published commit proved
by the current Git owner. A dev ref, metadata match, survivor Test, foreign
parent or unverified Test result supplies no such authority. Outside the
agreed and verified published history, the other source commits stay linear.
Historical Test readback takes this public commit from the original native
capture, whose identity already includes the owning Test's publication proof.

The saved/stopped handoff may name a different, preserved managed HEAD.
The Git owner verifies the clean source worktree still has that exact HEAD
and the selected source lies on its first-parent history. The source's prior
Test and normal return remain mandatory for this choice. The survivor's
ordered merge binds the selected commit and its tree. Combined closure uses
the same choice and retains both the selected commit and the actual HEAD in
its original evidence. The preserved branch and late commits stay in place.
The two Task leases remain authoritative. Already closed absorptions keep
their original interpretation.

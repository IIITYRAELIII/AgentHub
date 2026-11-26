# ADR-HUB-448 — Published parent of a returned Test

The native absorption history check may retain a source-side merge at the exact
result of the source Task's recorded Test and normal return. The merge must
have two parents. Its second parent must be the published commit in the
source Test's original native capture and must remain in the currently
verified publication's ancestry. That original publication can supply its
exact inherited release metadata. A dev ref, metadata match, survivor Test,
foreign parent or unverified Test result supplies no such authority. Outside
the agreed and verified published history, the other source commits stay linear.
Historical Test readback takes this public commit from the original native
capture, whose identity already includes the owning Test's publication proof.
For both ordinary and saved-source handoffs, the Git owner matches the capture
to the dev commit in the hash-bound Test outcome and rechecks the normal return
in the Task journal. Existing handoff and outcome records keep their format.
When closure validates a new candidate, its temporary Git storage is separate
from the parent owner's original capture and read-only Task journal.

The saved/stopped handoff may name a different, preserved managed HEAD.
The Git owner verifies the clean source worktree still has that exact HEAD
and the selected source lies on its first-parent history. The source's prior
Test and normal return remain mandatory for this choice. The survivor's
ordered merge binds the selected commit and its tree. Combined closure uses
the same choice and retains both the selected commit and the actual HEAD in
its original evidence. The preserved branch and late commits stay in place.
The two Task leases remain authoritative. Already closed absorptions keep
their original interpretation.

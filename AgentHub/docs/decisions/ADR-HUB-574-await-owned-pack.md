# ADR-HUB-574 — Reuse exact Git packs during Await

Await receives the exact tested commits and validates current Task, publication
and Git authority before promotion. When the owned import already contains a
pack for the entire admitted closure, the release clone can copy that pack and
index into separate files. A subsequent native consumer can copy a pack for
an admitted subset and ask Git to encode the remaining objects. The existing
maintenance receipt binds the pack to that import and physical owner. A pack
that no longer has its recorded identity is ineligible for reuse.

The source and destination custody checks, Git connectivity and the original
operation journal still protect creation and recovery. The pool lease covers
the copy and any delta pack. No permanent alternates or shared consumer
hardlinks are introduced. A shallow source still requires a closure comparison.

The result planner reads related Git refs together at each invocation. During
native promotion, the Git owner rechecks publication and history after the
joined plan and base reads. At the final Task CAS, read the base after the
plan has finished and preserve plan refusal priority.
The changed-file projection can be reused during that invocation once the
live result, base, branch and adoption evidence match. Checkout readback uses
Git's porcelain status to check HEAD and worktree state in the same command.
The index tree is still checked at each promotion boundary.
Without an accepted checkpoint, ordinary Await searches old conflict captures
only if Git encounters a conflict. The existing verifier still determines
whether an old resolution can be used. The trace separates primary root,
revisions, worktrees and dirty state, as well as reuse enumeration and journal
reads.

For an ordinary, already accepted conflict-free prefix, the original Task
outcome binds the accepted manifest, Git head and tree, Workspace and
publication/history authority. When that exact completed checkpoint remains
the ordered prefix of the new selection, the native owner transports its
accepted head and merges the remaining results. The final selected-content
check and promotion gates still run. Old receipts, ambiguous earlier state
and resolved conflicts use the existing verifier. Reopening a persisted reuse
intent also retains its original Git readback.
Manual and original-operation recovery continue to use their existing ordering.
Measure the durable outcome through the HTTP MCP endpoint against both an empty
and a populated PreRelease. Report queue wait, time to receipt and the
consumer pack/copy spans independently.

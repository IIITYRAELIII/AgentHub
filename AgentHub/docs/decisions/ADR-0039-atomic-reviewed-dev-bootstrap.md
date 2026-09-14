# ADR-0039 — Atomic reviewed managed-dev bootstrap

## Status

Accepted for HUB-216 implementation. Refines ADR-0009, ADR-0010 and ADR-0020
only for a Task result that already contains a reviewed merge of the exact
current `main` and the old managed `dev` history.

## Context

The former bootstrap merged that Task result directly into old `dev`. This kept
the accepted bytes, but placed the reviewed `[Task, main]` proof below the second
parent of the dev integration. Release projection intentionally searches the dev
first-parent line, so a later selected Task could replay against the wrong base
and conflict even though the combined result had already been reviewed.

Moving `dev` first to a temporary main merge and then to the Task integration
would expose an intermediate head and leave a crash window between two ref
writes. Copying the whole Task tree into that main merge would also import
Task-only bytes before the Task integration owned them.

## Decision

While holding the existing Task and repository dev locks, the Task Git owner
builds two unreachable commits. `B=[oldDev, exactMain]` uses Git's normal merge
for nonconflicting paths. Every conflicting code path requires one unique merge
on the accepted Task result's bounded first-parent line with exactMain as its
second parent. The index's dev/main entries must match that proof's two parents
by mode, type and object; the proof result must match the accepted Task snapshot.
Only those exact accepted entries are staged. `CHANGELOG.md` remains the sole
excluded-path exception and may take the accepted snapshot entry only inside
this same Task operation.

`C=[B, TaskResult]` is then constructed with ordinary merge semantics and must
have exactly the accepted Task tree. Task-only files therefore enter only `C`.
The owner writes durable recovery identity and publishes `refs/heads/dev` once,
using `update-ref C oldDev`. Before that CAS, `dev` remains oldDev. After it,
recovery may reset the managed worktree to `C` only when the exact stored commit,
tree and ordered parents still match. A changed ref or ambiguous proof blocks.

## Consequences

The dev first-parent line retains an exact reviewed main merge for release
projection without exposing a partial bootstrap or widening Task ownership.
Clean and fast-forward synchronization keep their existing behavior. Missing,
foreign, wrong-main, mode/type/object-mismatched or ambiguous proof leaves old
dev unchanged and reports the conflict for review.

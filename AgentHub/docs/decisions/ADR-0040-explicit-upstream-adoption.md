# ADR-0040 — Explicit upstream adoption for Task Git

## Status

Accepted for HUB-216 implementation.

## Context

The former Task Git owner preferred `origin/main`, fetched it during ordinary
preparation, and synchronized managed dev before creating or testing a Task.
Updating a remote-tracking ref could therefore change a Task base, block an
unrelated claim on a main/dev conflict, and move release evidence without a user
decision. Publication state could not safely replace that authority because it
may be stale, absent, or scoped to a different publication operation.

## Decision

The accepted repository baseline is the exact local `refs/heads/main` commit.
New Task creation atomically verifies that ref and creates the Task base ref at
the same commit. Existing Task bases are immutable. Ordinary `prepareDev`, Task
integration, release-plan evidence and preflight never fetch or synchronize
main; remote-tracking refs are observations only. Missing local main and dev that
does not contain it fail closed without choosing another ref.

Main-to-dev synchronization is an explicit exact-commit operation. Durable
post-publication finalization may supply its published revision after local main
equals that revision. Before publication, reviewed upstream content enters dev
only through a selected Task snapshot containing a unique first-parent proof
whose second parent is the pinned upstream commit and a separate immutable
operator adoption receipt. The content-addressed Git blob and ref bind the Task
and repository identity, exact local baseline, immutable Task base, adopted SHA,
snapshot commit/tree, proof commit/parents/tree and operator request ID. Preview
validates and hashes without writing; enable atomically verifies local main,
Task base and Task branch before creating the receipt ref. Ordinary Task and
release workflows may verify this record but cannot create it. ADR-0039 governs
the subsequent atomic dev bootstrap, whose final CAS revalidates the pinned
receipt. Later remote movement cannot replace it.

Release audit may approve a different exact origin commit, but preflight accepts
that base only when the commit is already an ancestor of current dev and one
selected frozen Task result has the exact receipt. Approval or graph shape
without the prior operator record has no release side effect.

## Consequences

Claims and existing Tasks remain usable when origin advances or conflicts with
local work. Upstream changes require an explicit review and durable Task-owned
adoption before dev bootstrap or release. Cleanup enumerates and removes the
Task's adoption refs only under the normal publication/destructive lifecycle.
Publication still synchronizes dev deterministically from its durable exact
revision, while missing, moving or ambiguous authority remains fail closed.

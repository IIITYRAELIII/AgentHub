# ADR-0079 — Serialize Await in live PreRelease

## Status

Accepted, 2026-09-29, by explicit user instruction.

## Decision

Reuse the existing Agent Hub-owned PreRelease clone for Await acceptance.
Acquire the Workspace Await lock before Task and repository locks; retain it
through composition and the Task CAS. Recovery and cross-Task cutover use the
same ordering. The existing prepareCandidate callback boundary restores the
previous ref, checkout and checkpoint on a proven failure, and preserves them
on an ambiguous outcome for reconciliation by the original operation owner.
Do not allocate a release-gens clone or promote a prospective generation for
this transition.

## Consequences

Simultaneous Await transitions queue rather than clone and compose concurrently.
This avoids the failed per-acceptance local clone transport when the registered
repository has core.hooksPath configured, without disabling Git clone protection.
It does not remove first-time creation of a repository's release clone.
Task results, published-base authority, selected-result composition, unknown
outcome handling and primary preservation remain unchanged.
Publication operations still own immutable generations; changing that separate
lifecycle is outside this correction. Test integration already serializes in
the shared dev worktree and needs no second mechanism.

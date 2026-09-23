# ADR-0073 — Durable release operation without Task freeze

## Status

Accepted, 2026-09-22.

## Decision

Agent Hub uses one SQLite-backed `ReleaseOperation` as the sole mutable owner of
release progress. Each ready candidate generation is immutable and records exact
repository bases, selected Task results, commits, trees, manifests and runner
version. Durable step receipts and per-target effects separate local intent from
external readback.

The state machine is `compose → validate → publish → finalize → done`, with
`waiting(resumeState, reason)` for a concrete recoverable condition. Technical
retries and corrections within the original Task/target authorization continue
without another user confirmation. External effects are never blindly replayed;
partial publication resumes only missing targets.

Task lifecycle remains independently editable. Await means current live
PreRelease integration, not membership in every operation. Validation failure
creates a later generation after the selected Task has a reviewed correction.
Return does not withdraw the prior result from dev. Finalization closes only the
exact current published result and preserves newer work.

The public API is `hub_release_run`, `hub_release_get` and
`hub_release_continue`. Run returns after durable admission. Old release
preflight/reconcile/complete writers and frozen-policy gates are removed at the
same cutover. Legacy JSON is imported once as immutable evidence; only an exact
matching nonterminal publication status activates recovery.

The release runner is stable current-owner code, not executable code loaded from
the candidate. Every command receives the candidate `AgentHub` directory as its
explicit working directory, including artifact build/effect callbacks. The
runner reads N−1 operation schema. Long composition, tests, Git, deployment and
network work execute outside Workspace and Task CAS locks; Await promotion keeps
only exact identity checks, pointer writes and the Task CAS inside the lock.

## Consequences

- A failed release attempt no longer blocks Task correction or unrelated work.
- Operation identity, target effects and generations remain auditable across
  process death and transport timeout.
- Unknown external effects can still require specific external evidence; generic
  manual resume is not accepted as proof.
- Historical checkpoint/status files cease to be mutable authorities after
  import, so rollback before effects restores one writer rather than two.

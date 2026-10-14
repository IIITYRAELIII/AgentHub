# ADR-0043 — Separate Task acceptance from release preparation

## Status

Superseded by ADR-0045 and then ADR-0055: an ordinary Await transition composes
`PreRelease` before it commits. The historical decision below is preserved as
context and is not the operative rule.

Accepted for the HUB-216 release workflow simplification. Reaffirms ADR-0013
and supersedes the eager Await/post-publication materialization portions of
ADR-0024 and ADR-0034.

## Context

Await previously rebuilt the Workspace-wide `PreRelease` and rolled back an
otherwise proven Task when any selected Task could not be composed. This joined
Task acceptance to release assembly, repeated expensive projection during
status changes, and made unrelated release conflicts lifecycle failures. A
stopped publication validation run also occupied the single journal even though
durable stage evidence proved that no publication effect had started.

The current release additionally has one already frozen, selected-only 13-Task
candidate. Replacing it with a later dominating Task result would import known
unselected theme and recording files, while replaying all selected integrations
needlessly repeats the already proven composition.

## Decision

Test remains the owner of the immutable Task snapshot and `dev` integration.
Await records acceptance and invalidates older plan/candidate identity; it never
builds `PreRelease` and never rolls back because another Task cannot compose.
One explicit prepare operation selects the full set, builds the candidate,
freezes the consolidated changelog and CalVer, runs validation, then publishes
that exact immutable tree.

The builder may increment an exact frozen candidate when the base, Workspace,
selected Task IDs and all other Task results are unchanged and exactly one Task
result advances by ancestry. It applies only that result's non-changelog delta
to the frozen head and records current row revisions. Selection/base changes,
non-descendant results or an apply conflict do not gain an alternate shortcut.
This keeps unselected content out of the release.

The existing publication start owner may terminalize a different dead run as
`interrupted` under the canonical lock only when its exact journal/checkpoint
show exclusively named pre-effect validation stages and empty progress. It
archives the old terminal status beside its log before creating the new run;
live, effectful or ambiguous runs remain fail-closed.

## Consequences

Task lifecycle latency and correctness no longer depend on Workspace-wide
release composition. Candidate freshness remains enforced by the existing plan
revision and manifest CAS at prepare, freeze, publish and completion. CalVer is
part of the frozen tested tree, so a date boundary after freeze does not mutate
or revalidate the release. The incremental path is a narrow optimization of an
already selected candidate, not permission to publish a dominating Task tree or
unselected `dev` content.

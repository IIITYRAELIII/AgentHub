# ADR-0010 — Test integration and Await PreRelease

## Status

Partially superseded by ADR-0013. The Test-to-`dev` decision remains accepted;
the Await-to-`PreRelease` rebuild decision is superseded.

## Decision

A Task result is snapshotted and merged into `dev` when the Task reaches
`testing` or a later implementation status. The shared Test Contour is refreshed
after successful integration and continues to represent the rolling `dev` head.

Acceptance is a separate boundary. Moving a Task to `awaiting_implementation`
rebuilds `PreRelease` from current `main` plus the exact result commits of all
accepted Await Tasks. `dev` is never merged into `PreRelease`, so Test-only work
cannot enter the release candidate.

Release Manager freezes the exact release-plan revision, included Task IDs and
`PreRelease` head. A consolidated changelog entry is written only in
`PreRelease`, and only when the repository has `CHANGELOG.md`.

## Consequences

`dev` may contain simultaneous Test and Await work without defining release
contents. Removing, returning or replacing an Await Task deterministically
rebuilds `PreRelease`. After verified publication, released `main` is incorporated
into `dev` without discarding later Test work, and `PreRelease` is rebuilt from
the remaining Await set.

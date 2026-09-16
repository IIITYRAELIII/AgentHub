# ADR-0013 — Release-time PreRelease freeze

## Status

Accepted. Supersedes the Await-to-`PreRelease` portions of ADR-0010.

## Decision

Moving a Task to `awaiting_implementation` records its exact accepted result for
a future release. This transition does not build, rebuild or mutate
`PreRelease`.

Only an explicit user release command starts candidate assembly. Release Manager
selects the exact ready Await set, updates current `main` from `origin/main`,
builds `PreRelease` from that `main` plus the selected exact Task results, and
then freezes the exact release-plan revision, included Task IDs and resulting
`PreRelease` head.

The frozen candidate is immutable. Await Tasks accepted after the freeze are
reserved for a later release. If an included Task changes, is withdrawn or is
excluded, completion CAS fails and Release Manager must explicitly rebuild and
refreeze before publication can complete.

## Consequences

`dev` remains the rolling Test integration branch and is never merged into
`PreRelease`. Test-only work cannot enter the candidate. Await transitions stay
fast and cannot mutate an active release. After verified publication, remaining
Await Tasks stay accepted until the next explicit release rather than causing a
new mutable candidate to be built automatically.

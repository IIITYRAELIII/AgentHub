# ADR-0007 — Task controls remain mutable after freeze

## Status

Accepted. Refines the aggregate immutability consequence of ADR-0005 while
preserving immutable release evidence. ADR-0006 remains the narrower decision
that first made the ordinary `done` status unrestricted.

## Decision

Freezing a Task appends an immutable, revision-addressed release manifest, but
does not lock the live Dashboard Task. Users and agents may change any workflow
status, reopen or close the card, move it, rename it, and start or claim further
work. A rollback from `awaiting_implementation` clears pending automatic-freeze
intent for the Task.

Every live Task mutation advances its revision. Release selection requires an
exact match between the current Task revision and the frozen revision, so an
edited or rolled-back Task leaves the candidate set without deleting or
rewriting historical evidence. Generic `done` and card completion remain board
operations and never manufacture publication evidence. Terminal evidence is
independently derived from the claim baseline and terminal Git tree. Its
persistence never rewrites the current workflow status.

## Consequences

An erroneous or premature status can be corrected by its executor without
Release Manager intervention. Release history remains auditable and append-only, while
readiness is derived from the exact current revision instead of enforced by a
user-visible lock. Correcting the contents of a malformed evidence manifest
still requires an explicit evidence replacement/reset operation; this ADR does
not infer file ownership from mutable working-tree state.

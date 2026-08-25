# SYS-001 — Accepted decisions and ownership

## Invariants

- One durable owner is named for every behavioral state and identity.
- Code, tests and UI projections cannot silently redefine accepted behavior.
- A conflicting change updates this contract and records the reason in an ADR.
- A narrow passing test is evidence only; it cannot waive a violated invariant.
- Temporary compatibility logic declares its migration boundary and removal
  condition.

## Readiness evidence

The change names affected contract IDs, identifies the authoritative owner,
states preserved invariants and records any remaining migration gap.

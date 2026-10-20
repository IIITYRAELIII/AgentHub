# SYS-001 — Accepted decisions and ownership

## Invariants

- One durable owner is named for every behavioral state and identity.
- Code, tests and UI projections cannot silently redefine accepted behavior.
- A conflicting change updates this contract and records the reason in an ADR.
- A narrow passing test is evidence only; it cannot waive a violated invariant.
- Temporary compatibility logic declares its migration boundary and removal
  condition.

## Public source and private operational data

A standalone public source repository is not a destination for automatic bug
report commits. Having `AgentHub/package.json` proves source layout only. The
legacy Utilities report path is identified by its existing inventory/team-setup
markers, which remain after source removal. Publication checks that boundary
before Git fetch, report staging or push; an explicit repository argument does
not bypass it. These local markers do not attest remote visibility: the operator
must retain the original private reporting destination or leave reporting
unavailable. Private GitHub vulnerability reporting is a separate explicit
channel, never an automatic upload of runtime state.

Source-history projection records new commit/tree identities and declared
exclusions without rewriting original Task refs, receipts, frozen generations or
UNKNOWN outcomes. A source audit, rewritten OID or packaged runtime alone is not
release acceptance. The existing release/runtime owners retain composition,
publication and stopped-writer cutover authority. See ADR-0329.

## Readiness evidence

The change names affected contract IDs, identifies the authoritative owner,
states preserved invariants and records any remaining migration gap.

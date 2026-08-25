# ADR-0001 — Accepted contract registry

## Status

Accepted.

## Decision

Agent Hub keeps machine-indexed accepted behavior in `docs/contracts`. Changed
paths select contracts through `registry.json`; contradictory behavior changes
must update the contract and add an ADR. Changelog entries name affected IDs.

## Reason

Regression tests proved insufficient because fixes repeatedly moved ownership or
changed sequencing while preserving narrow assertions. The registry records why
the behavior exists and which invariant a test is intended to prove.

# Agent Hub accepted contracts

This directory is the authoritative registry of accepted Agent Hub behavior.
It exists to prevent a local fix from silently redefining an invariant owned by
another layer.

## Workflow

1. Select contracts by matching changed paths against `registry.json`.
2. Read the selected contracts before editing behavior.
3. Keep their invariants intact, or update the contract and add an ADR in the
   same coherent change.
4. Record affected IDs in the Utilities `CHANGELOG.md` field `Контракты`.
5. Before readiness, report preserved invariants, checked evidence and remaining
   migration gaps.

Use `npm run contracts:affected -- <path> [...paths]` to select contracts for a
change. Use `npm run contracts:check` to validate the registry and documents.

Tests are evidence for a contract; they do not replace it. Compatibility guards
must name their removal condition and cannot become a second source of truth.

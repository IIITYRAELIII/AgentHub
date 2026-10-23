# ADR-0124: Durable prior-executor claim refusal

Status: implementation candidate under the user-approved correction, 2026-10-19.

## Context

The claim owner rejects a handoff while the current executor has active or
queued work. This check precedes Git preparation and TaskBoard.claim, but its
generic exception previously left the MCP receipt UNKNOWN. Existing repository
process-guard recovery cannot prove that a historical busy error had no effects.

## Decision

Retain the existing claim, catalog SQLite receipt and same-ID recovery owners.
At that exact live pre-effect boundary, seal a bounded structural proof in the
existing pending receipt result_json. A catalog transaction compares the fresh
receipt identity and immutable argument hash, the observed Task row revision,
status/workflow/previous executor and the absence of original claim bindings or
lifecycle admission/outcome. It persists the active/queued reason and exact
claim argument shape, excluding the context capability. No Task row is changed.

The normal MCP failure write records failed/NO_EFFECT with a typed busy reason.
If it is lost, the proof survives in the same pending or unknown receipt. Startup
or exact same-ID readback verifies the proof and absence of original admission,
then settles only that receipt. The Task claim writer checks the same refusal
fence, so a late continuation cannot assign the refused operation. A different
caller/arguments hash cannot reuse it. Queued Thread ownership is read through
the existing canonical point resolver rather than an absent Stream projection.

## Limits and validation

An already admitted claim, partial Git preparation, typed exception without a
sealed proof, changed intake identity or historical error text stays UNKNOWN.
No historical certificate is reconstructed from the present executor or from
missing state. No new table, queue, journal, public operator endpoint or guard
bypass is introduced. Historical originals are not changed by source tests.

Focused public MCP tests use real disposable SQLite and production mutation
capabilities with observable Git-prepare boundaries. They cover active/queued
refusal, idle assignment, same-ID retry, receipt-write loss/reopen/startup,
the direct claim fence and admitted/partial/foreign identity negatives. Existing
workflow refusal tests retain the earlier accepted result. Exact source review
and affected compatibility precede integration and S2-owned delivery; source
acceptance alone does not attest a running version.

Focused validation from `AgentHub`:

```sh
node --test --test-concurrency=1 tests/application/hub-mcp-claim-refusal.test.mjs tests/application/hub-mcp-workflow-refusal.test.mjs
node --test --test-concurrency=1 tests/application/hub-mcp-service.test.mjs tests/infrastructure/persistence/sqlite-mutation-owner.test.mjs tests/infrastructure/persistence/workspace-catalog-store.test.mjs
npm run contracts:check
```

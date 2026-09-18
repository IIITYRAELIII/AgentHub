# ADR-0050 — Preserve complete Task descriptions

Status: accepted
Date: 2026-09-15
Contracts: MCP-001, UI-001

## Context

The application enforced an arbitrary 20,000-character limit on Task descriptions
and combined creation text. HUB-235 reached that limit during ongoing work.
The database does not require it. UI editors, MCP validation, voice capture and
bug-report capture enforced or silently worked around the same restriction.

## Decision

Remove the independent character limit from Task description and creation text,
including their UI and import paths. Keep normalization, required creation text,
the 160-character title limit and existing complete-request transport bounds.
An oversized request must fail explicitly at its transport boundary; Task text
must never be shortened to fit the former description limit.

## Consequences

Existing data needs no migration. Previously truncated source text is not
reconstructed. This change does not alter Dashboard snapshot loading or its
transport budget; lazy Task detail loading remains separate work.

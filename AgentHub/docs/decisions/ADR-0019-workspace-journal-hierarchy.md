# ADR-0019 — Workspace journal hierarchy

## Status

Accepted for HUB-175.

## Context

The virtual Journal initially reused the date-group Workspace selector inside
`workspace` grouping. That duplicated the Workspace already named by the outer
group, displaced its established profile chart and made the expanded hierarchy
look like a second Workspace picker.

## Decision

Date, week and month groupings keep the Workspace selector and its existing
usage breakdown. `workspace` grouping uses the outer group as the sole
Workspace identity and expands directly to its resource-only Stream rows plus
the established Workspace profile. Each Stream expands vertically to its lazy
turn page. The profile is loaded from a materialized aggregate projection and
does not hydrate peer turn details.

## Consequences

- Workspace usage details and percentages remain the existing journal facts.
- Workspace grouping has no duplicate Workspace tiles.
- Stream and Workspace expansion remain separate lazy operations.

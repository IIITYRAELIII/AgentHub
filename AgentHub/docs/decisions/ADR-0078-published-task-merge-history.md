# ADR-0078 — Exclude verified published ancestry during Task consolidation

## Problem

The registered primary main may remain at an older commit while an independent
release clone publishes a newer revision. A Task based on that published
revision contains release merges after its original Task base. Sibling
validation mistakes those published merges for unapproved new upstream and
blocks the combined Task before dev integration.

## Decision

For current merge-adoption discovery only, exclude the ancestor range of the
exact durable published repository revision. Require a publication generation,
exact repository root, matching origin/main tracking commit and accepted-local-
main ancestry. Missing or inconsistent evidence retains the old fail-closed
behavior. Explicit adoption and historical object-only proof reconstruction
do not use this current-state exclusion.

No ref, primary checkout or acceptance receipt is rewritten. Sibling identity,
Task snapshot, dev and composition guards remain in place. A real-Git regression
combines Tasks over a published merge with stale primary main, checks missing,
foreign and mismatched publication rejection, and verifies unchanged main.

# ADR-0045 — Rolling PreRelease instructions

Date: 2026-09-14. Status: accepted policy; implemented in HUB-235, not deployed.
Task: HUB-235. Contract: REL-001.

The user accepted preparation of PreRelease immediately after Task acceptance
to avoid accumulating integration problems until publication. Only accepted work
is promoted; conflicts preserve acceptance and the last good composition. The
remaining accepted work is prepared after publication. Preparation does not
start another full test/build/deployment pipeline.

This replaces the explicit-prepare-only policy of ADR-0043. HUB-235 implements
Await preparation in the lifecycle and covers it with real-Git integration tests.
The rule text itself is maintained in the checkbox source; it does not autofill
authored Workspace or Stream fields. These changes are not deployed yet.

Placement correction, 2026-09-15: shared release policy belongs in the release
workflow checkbox text; Release Manager policy belongs in the Release Manager checkbox text.
Do not copy either into authored Workspace or Stream rules as an
"Accepted user decision" override to bridge an unreleased version. Those
mistaken duplicates were removed from the live fields. Existing project-specific
rules remain. The corrected checkbox text ships with HUB-235; removing a duplicate
does not update the installed checkbox implementation.

# ADR-0033 — Explicit user exceptions to generated release policy

Status: accepted

## Context

The Release Workflow and Release Manager checkboxes inject strict developer policy.
An explicit user request to use a different workflow otherwise conflicts with
that policy, and a continuation can lose the agreed interpretation.

## Decision

Both generated blocks use the same scoped exception: explicit user instructions
for the current work override conflicting workflow requirements, including Task
creation, validation scope and publication sequence. The agent carries that
scope into continuation and rotation context until completion or a user change.
Urgency alone is not an exception; unrelated later work gets the defaults.

The exception does not override system or safety/security requirements,
unrelated developer instructions, or server-enforced authorization and integrity
checks. Reports must distinguish skipped validation and actual publication.
No authorization database, runtime policy switch or provider lifecycle changes
are introduced.

## Compatibility and evidence

The exact pre-change Workspace and Release Manager templates remain recognizable
legacy prefixes. Composition replaces them once; customized text is retained.
Keep these compatibility entries until no supported persisted rules can contain
those versions. Existing manually edited policy is not silently rewritten.

Domain tests cover prefix replacement, idempotence and custom content.
Provider-context composition through the real Workspace catalog verifies both
checkboxes and a Stream rebound to a new Thread. This proves delivery of the
policy, not that an external model will always retain an exception in its own
summary; the instruction requires that retention explicitly.

# ADR-0014 — Lossless limit sample merge

## Status

Proposed. Refines [USG-001](../contracts/USG-001-usage-attribution.md) for
conflicting inline `limitSamples[]` evidence on repeated usage turn imports.

## Decision

Inline `limitSamples[]` are lossless evidence. The merge identity is the
normalized full sample body:
`(observedAt, limitId, window, windowMinutes, usedPercent, resetsAt, planType)`.

Two samples with the same `(observedAt, limitId, window)` but different values
are conflicting evidence, not duplicates. Both are retained. Exact normalized
duplicates collapse.

All runtimes store samples in canonical UTF-8 byte order over the same field
sequence. Locale collation is not used, so Node and Python produce the same
semantic order for mixed-case and non-ASCII fields.

## Consequences

Repeated or enriched imports of the same turn may add samples but must not
delete existing samples. A richer replacement row merges its incoming samples
with persisted samples before storage.

Downstream correlation may reject or mark intervals ambiguous when conflicting
evidence prevents a single admissible endpoint. That is preferable to losing
evidence during synchronization.

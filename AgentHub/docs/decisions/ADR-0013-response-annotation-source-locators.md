# ADR-0013 — Exact source locators for response annotations

## Decision

New response annotations persist a bounded version-1 source locator containing
the exact provider message identity, rendered surface kind and ordinal, UTF-16
range, and SHA-256 boundaries for canonical message content, surface content
and selected content. The client creates the locator from the actual DOM range
and authoritative provider item. Intake is the trust boundary that removes an
invalid locator while preserving readable quote text.

Response-citation navigation resolves only that identity and validates all
three hashes before highlighting the range. Hidden trace details are opened
only after validation. Missing or stale sources fail closed to the existing
annotation-card jump. Legacy annotations remain unlinked to source text; no
text, timestamp or display-order backfill is permitted.

## Consequences

- Duplicate text in one or several messages cannot redirect a citation.
- Markdown and inline-code node boundaries do not change range identity.
- SQLite, reconnect and terminal history retain the locator inside the existing
  annotation JSON, so no parallel persistence owner or schema column is added.
- A source edit or renderer-visible content change disables source highlighting
  instead of selecting a plausible but incorrect fragment.

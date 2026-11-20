# ADR-0013 — Exact source locators for response annotations

## Decision

New response annotations persist a bounded version-1 source locator containing
the exact user or agent provider-message identity, including an active
non-final agent item, rendered surface kind and ordinal, UTF-16
range, and SHA-256 boundaries for canonical message content, surface content
and selected content. The client creates the locator from the actual DOM range
and authoritative provider item. Intake is the trust boundary that removes an
invalid locator while preserving readable quote text.

The user-created annotation card resolves only that source identity and
validates all three hashes before highlighting the range. Hidden trace details
are opened only after validation. A response citation remains a separate
identity-based link to the corresponding user annotation card and displays the
user's annotation/comment rather than the selected source text. Missing or
stale sources fail closed without changing that annotation-card target. Legacy
annotations remain unlinked to source text; no text, timestamp or display-order
backfill is permitted.

## Consequences

- Duplicate text in one or several messages cannot redirect a citation.
- Markdown and inline-code node boundaries do not change range identity.
- SQLite, reconnect and terminal history retain the locator inside the existing
  annotation JSON, so no parallel persistence owner or schema column is added.
- A source edit or renderer-visible content change disables source highlighting
  instead of selecting a plausible but incorrect fragment.

## Same-turn steering and active commentary

The owning Codex native-item and ordered history projections capture the exact
annotated-user identity when the item is created. That bounded target travels
through the existing reference/group JSON; it is presentation metadata, not a
new message authority or a source locator. SQLite and snapshots preserve it.
Full-source reads reuse only the addressed group's captured context after the
existing native identity checks, so steering B cannot rewrite earlier A.

A completion record can follow a later user input even though its native item
started earlier. The existing target JSON marks that native start capture with
`origin: "native-item"`; it outranks a completion-order inference. Exact item/
group joins in the same provider/Thread/turn retain the capture through observer
updates, hydration and the existing durable history merge. A later native item
captures its own target. Foreign/changed owners and ambiguous joins cannot borrow
an earlier capture. This is presentation provenance, not dispatch authority, a
new persistence owner, a text match or a replacement source locator. Existing
reference positions/empty lists and all source/range/hash guards remain intact.

Explicit detail reads validate and skip oversized tool-result records which
cannot project a trace item, using the existing streaming JSON validator.
Their complete bytes still enter the source-prefix SHA. Oversized assistant,
unknown, malformed and ambiguous source records retain their visible refusals.
Source identity, selected range and all three content hashes are unchanged.
The existing command trace measures annotation-source validation separately
from send/ACK/queue/provider/DOM work; it records no selected text or payload.

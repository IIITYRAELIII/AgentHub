# ADR-0032 — Complete response quote selections

## Decision

Remove the independent quote-length cap from DOM capture, composer draft
normalization, source-locator admission and server history normalization.
Previously a selection over 400 characters disappeared at capture or lost its
source locator, while quote text could be silently shortened to 400 or 4,000
characters at other boundaries. These outcomes contradict the user's complete
selection and can separate its text from the retained source hash.

The full selected text now crosses the existing annotation payload. General
message/transport and draft-storage limits, annotation-count/comment limits,
source identity checks, valid UTF-16 offsets and SHA-256 checks remain intact.
No new persistence owner, retry or source-matching fallback is introduced.
Composer previews use a keyboard-focusable scroll area with a visual height
bound so a long quote cannot push comment and send controls below the viewport.

## Consequences

Selections of 401, 430 and many thousands of characters remain selectable,
persistable and deliverable when the complete command fits its transport.
Existing truncated quotes cannot be reconstructed from text or guessed
offsets; old records remain unchanged. No storage schema migration is needed.

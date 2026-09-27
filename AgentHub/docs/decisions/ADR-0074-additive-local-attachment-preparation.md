# ADR-0074 — Additive local attachment preparation

## Status

Accepted for HUB-264.

## Context

Clipboard preparation awaited server capabilities and required an unchanged
composer edit revision. Typing during hashing, or a second paste, silently
discarded valid files. Committing a captured old draft could also resurrect text
that an authoritative receipt had already cleared.

## Decision

Prepare local Blobs without a network request. Apply the existing local bounds
of eight files, 256 MiB per file and 512 MiB per draft. After preparation, append
to the current draft and recheck aggregate bounds; do not replay captured text,
references, annotations or earlier attachments.

The exact Task identity and generation remain mandatory. A destructive-operation
fence cancels pending additions after send, clear, attachment removal, replacement
or rebinding. Ordinary typing and independent additive pastes do not cancel each
other. Each committed append still advances the canonical edit revision and
invalidates an old retry identity. Annotation and queue-transfer revision fences
remain unchanged. Pending preparation blocks managed reload.

Before upload, validate the complete batch against negotiated server capabilities.
The legacy aggregate limit remains 20 MiB. A failure before dispatch preserves
the unsent draft through the existing preparation-cancellation path. No message,
upload, retry identity or durable acceptance is inferred from a local preview.

## Evidence and limits

Disposable production-browser fixtures cover five clipboard pastes while
capability negotiation is unavailable, concurrent text edits and file preparation,
reload persistence, count limits, send/clear/removal/rebinding fences and late
receipt reconciliation. Clipboard events and files are synthetic; this is not a
measurement of the user's live browser or network.

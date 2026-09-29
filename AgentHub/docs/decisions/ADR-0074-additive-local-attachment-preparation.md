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

The browser displays a bounded, operation-scoped object-URL preview immediately
after accepting a File, labelled as preparation. It is presentation only and is
never serialized as an attachment or granted durable recovery. The selected
draft cannot be sent while its visible files are still preparing; explicit
cancellation releases the preview and permits sending the remaining draft.
Other Streams are not blocked. Settling, clear and rebinding remove obsolete
previews without allowing a late callback to reintroduce the file.

Before upload, validate the complete batch against negotiated server capabilities.
The legacy aggregate limit remains 20 MiB. A failure before dispatch preserves
the unsent draft through the existing preparation-cancellation path. No message,
upload, retry identity or durable acceptance is inferred from a local preview.

## Evidence and limits

At the user's explicit presentation correction, local attachment save failures
remain structured diagnostic/non-durable state without a composer paragraph or
toast. Managed reload still cannot discard an unpersisted draft. Successful
message admission is shown by its canonical message/queue projection, without a
second acceptance notification. This removes redundant notices, not recovery or
receipt authority.

Storage I/O has bounded open/write/read deadlines, but elapsed time after
successful exact committed-byte verification is not evidence of a failed save.
Retire a connection on transaction timeout so a later selection does not inherit
that stalled connection. Do not clear stored drafts or silently replay an upload.

Disposable production-browser fixtures cover five clipboard pastes while
capability negotiation is unavailable, concurrent text edits and file preparation,
reload persistence, count limits, send/clear/removal/rebinding fences and late
receipt reconciliation. Clipboard events and files are synthetic; this is not a
measurement of the user's live browser or network.

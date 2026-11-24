# ADR-HUB-121 — Atomic folder editor and comment

## Status

Accepted user direction for the corrective folder catalog result. Exact Design
review, native Test and publication remain separate outcomes.

## Decision

The canonical WorkspaceCatalogStore folder record owns an optional comment.
Schema17 adds `comment TEXT NOT NULL DEFAULT ''` inside its existing schema
transaction. Existing IDs, revisions, tombstones, membership and original
receipts are retained. Catalog hashing includes the comment, so ordinary client
snapshots invalidate consistently. There is no separate local comment store.

The existing addressed folder command owner accepts `update` with stable folder
ID, expected revision, name and comment. It validates duplicate/name/comment
constraints and commits both fields, any renamed memberships and its terminal
receipt in one transaction. Comment-only/clear changes advance the revision.
Legacy checked rename keeps the comment; name-only stale clients remain refused.
The existing 80-character name rule and Workspace comment limit1000 are retained.

One native Workspace-style dialog replaces askText and the Mobile rename layer.
It reuses `workspace-card-modal`, its form/header/scrollable fields/footer and
quiet/primary buttons. It shows only name/comment. No folder-specific layout or
theme rules are added; the existing comment-height rule gains one shared alias.
Menu and Mobile edit paths reach the same controller.

An open draft is separate from canonical snapshots. Stale rejection reads the
latest exact identity without overwriting inputs; a second explicit Save is
required with a fresh request identity. Pending and UNKNOWN retain the original
request/arguments and block duplicate/conflicting writes. Receipt checks never
resubmit. Closing/reload restores only the existing notice; an explicit terminal
rejection read projects a named retained-draft notice without auto-open or focus
theft. Only its explicit action restores the fields after a safe identity read.
Opening does not delete that draft; successful Save or explicit cancellation
clears it. Terminal rejection unlocks the entity. Stable folder IDs restore focus.

## Boundaries

Delete preview/member preservation, checked Workspace movement, canonical folder
projection and Dashboard Task-card drop retain their owners. Dashboard does not
display or edit folder comments. Existing accepted results/frozen evidence are
preserved. The user's non-GUI restriction limits new verification to executable
Node DOM/command/SQLite and source reuse checks, not rendered visual parity or
native pointer/touch/installed-host/screen-reader certification.

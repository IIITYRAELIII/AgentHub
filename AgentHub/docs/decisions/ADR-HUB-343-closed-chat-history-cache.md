# ADR-HUB-343: Release canonical history when its chat column closes

## Context

The browser retains canonical pages in the client history maps and projected
messages in the application map. Normal single-Stream navigation replaces the
open column but previously never released either cache. A controlled full-client
sequence visiting eight chats retained all eight canonical payloads after GC.
This is a proven lifetime defect, separately from the unobserved original Opera
document and its reported CPU/process memory. It does not establish that those
historical values had this single cause.

## Decision

The existing open-column layout publishes retained Task identities with its
visible-Stream event. The history owner releases only pages outside that layout
and outside the selected/visible transition. Its existing request generation
invalidates late pages and pending refreshes; dispatched reads are not replayed
or used as cancellation evidence. The app releases the corresponding projection
only when it is no longer selected or visible.

Still-open columns in any Workspace retain loaded/paged history. An explicitly
closed column reopens from current canonical history, rather than preserving
its old local pagination. Drafts, attachments, pending/outgoing submissions,
active-turn projections, read receipts, pins and server history keep their
existing owners. No global memory cap, timer, theme change or effect suppression
is introduced. This bounds retained history by the content intentionally open,
not total browser private memory or the number of open Workspaces.

## Verification

Full shipped-client browser checks observe collectability after normal column
replacement and current history on reopen, preserve parallel columns and reject
late closed-page projection/read evidence. Comparable heap observations are
controlled measurements, not an original Opera incident or global CPU fix.

# ADR-HUB-414 — Reuse loaded windows during chat switching

Status: accepted by the requested correction, pending independent validation.

The reported A-B-A-B delay is reproducible with current client assets: ordinary
layout replacement evicts both previously loaded pages, each return dispatches
open-task and an additional layout-triggered task-history read, and the shared
message surface resets scroll. Holding those reads leaves both chats empty.
No disk-cache deletion is established by this evidence.

Keep canonical windows in their existing maps. Recently viewed pages use the
same four-entry working-set size as the existing four-column layout; genuinely
open Workspace windows retain their existing protection. This bounded recent
working set replaces eager eviction on ordinary selection, not explicit close.
Explicit close and displacement from the recent working set use the same
projection-release/generation fence. No second payload cache or durable owner
is introduced, and read ACK/outgoing/receipt state is outside this eviction.

A still-matching page is rendered immediately. The existing select-task mutation
and versioned task-history read run independently, preserving navigation,
request-generation and binding checks. A new exact final can remain unread while
the older loaded page is shown; display after paint and a durable exact receipt
remain necessary. The existing trace reporter records cached paint under the
selection's trace identity without content or new timers.

Scalar scroll/render state and the first visible message anchor follow the
lifetime and exact Workspace/Stream/provider/Thread binding of the canonical page.
An unpinned reader returns to that message even when the inactive page appended
or prepended messages; missing anchors retain the prior top position. Bottom
following is reserved for a previously pinned reader. Restoring
it synchronously establishes the correct scroll owner before live-card updates;
old pin callbacks cannot follow a different page or newer user intent.

Validation uses actual client/DOM switching with held transport, existing
known-version requests, real SQLite read receipts, bounded eviction and late
response controls. Installed user latency remains a separate observation.

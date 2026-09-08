# ADR-0022 — VS Code host-message relay identity

## Status

Accepted for HUB-166.

## Context

The embedded-browser source guard introduced with ADR-0019 assumed that native
VS Code host messages always arrive with `event.source === null`. VS Code 1.133
instead relays them from the outer frame of the same opaque WebView origin. The
guard therefore discarded real `agenthub:control-result` messages before the
attachment viewer could receive its resolved durable resource URL. The image
request never started and the shared viewer deadline expired, while isolated
browser tests with a synthetic direct control response remained green.

The relay cannot be admitted by message shape. Embedded HTTPS documents can
post arbitrary Agent Hub-shaped payloads to their parent.

## Decision

Keep one shared receiver guard. Registered embedded-frame sources remain an
unconditional deny, including after replacement. In addition to null-source
native messages and same-window messages, admit an object source only when all
of these facts hold:

- the current page protocol is exactly `vscode-webview:`;
- the page owns the acquired VS Code API capability;
- the event origin exactly equals the current non-null opaque WebView origin.

No ordinary HTTP(S) surface receives this exception. The guard still runs
before payload parsing in every receiver.

## Consequences

Current VS Code host control/session/runtime replies reach the shared client,
so an attachment resource is assigned before the existing generation-bound
deadline. A remote embedded page, stale registered frame, opener, foreign
origin or ordinary page with a look-alike object remains unable to enter the
host-message channel. Future VS Code relay changes must update this explicit
source-and-origin contract instead of adding a viewer-specific bypass.

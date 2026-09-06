# ADR-0019 — Sandboxed embedded web view

## Status

Accepted for HUB-145.

## Context

Agent Hub needs an in-app way to inspect an ordinary web page. Building a
general browser, proxying arbitrary traffic through Agent Hub or sharing a
normal authenticated browser profile would create new credential, navigation,
storage and network authorities far beyond that request.

## Decision

Provide one shared-client view backed by a direct HTTPS iframe. Admit only
bounded public-looking hostnames and require Chromium's credentialless iframe
support. Keep the frame opaque with only script execution enabled; do not grant
forms, same-origin, pop-ups, downloads or top navigation. Keep the address
ephemeral, unload it when the user leaves the view and provide an
external-browser escape hatch for sites that prohibit framing.

Opaque sandboxing does not suppress `parent.postMessage`. All host-message
receivers therefore share a positive source boundary: same-window messages and
native channels with no page source are accepted, while every registered
iframe, opener or nested foreign browsing context is rejected before payload
parsing. Current VS Code relays native messages through its same-origin outer
webview frame rather than exposing a null source. That one additional channel
requires both the acquired VS Code API capability and an event origin exactly
equal to the current opaque `vscode-webview:` origin; ordinary web pages cannot
claim it. The embedded-frame source is registered for its full lifecycle and
old sources remain denied after unload or replacement. Origin or payload shape
alone is not used as authentication.

Initial URL admission rejects IP literals, the current Hub hostname, local and
single-label names, `.onion`, `.alt`, other configured special-use suffixes and
the complete `example.com`, `example.net` and `example.org` documentation trees.
Matching uses normalized exact DNS-label boundaries. Redirect and DNS-rebinding
resolution remain a documented Chromium/network limitation rather than a claim
made by the client validator.

The local server, Cloudflare Worker and VS Code webview add only `frame-src
https:` to their existing CSP. No backend fetch endpoint, cookie jar, tab model,
download manager, extension bridge or provider-facing browser capability is
introduced.

## Consequences

Modern Chromium surfaces can display cooperative public HTTPS pages without
exposing Agent Hub state or ambient cookies. Sites with anti-framing policy and
clients without credentialless iframe support remain external-browser only.
Supporting authenticated sessions, arbitrary local addresses or anti-framing
bypass requires a separate explicit decision and threat review.

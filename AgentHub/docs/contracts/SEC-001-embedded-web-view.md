# SEC-001 — Embedded web view

## Scope and authority

The shared Agent Hub client owns one deliberately limited embedded web view.
It is a client-side convenience for viewing a public HTTPS page, not a browser
engine, authenticated browsing profile, backend proxy or provider tool.
`assets/web-app/embedded-browser.js` is the authority for initial-address
admission and transient view state. `assets/web-app/host-message-trust.js` is
the owning authority for messages entering Agent Hub from its native/VS Code
host. The Chromium iframe sandbox is the authority for document capabilities
after navigation, but is not a host-message authenticator.

## Security invariants

- Only bounded HTTPS URLs with a dotted hostname are admitted. Literal IPs,
  single-label and local hostnames, embedded credentials and the current Agent
  Hub hostname fail closed. Hostname comparison is case-insensitive, removes a
  trailing root dot and follows the URL parser's ASCII/IDN normalization.
- Special-use suffixes `.alt`, `.arpa`, `.example`, `.internal`, `.invalid`,
  `.lan`, `.local`, `.localhost`, `.onion` and `.test` are denied at an exact
  DNS-label boundary. The IANA documentation trees `example.com`,
  `example.net` and `example.org`, including their subdomains, are also denied;
  unrelated names that merely end in the same characters are not.
- Agent Hub never fetches or rewrites the remote page on the server. A load is a
  direct browser request and receives no Agent Hub authorization header.
- The iframe is `credentialless`, uses `referrerpolicy=no-referrer` and has the
  exact sandbox capability `allow-scripts`. It does not receive same-origin,
  forms, pop-ups, downloads or top-navigation capability. Camera, microphone,
  geolocation, clipboard, payment and USB permissions are explicitly denied.
- An opaque sandboxed document can still call `parent.postMessage`. Every
  Agent Hub receiver for runtime publication, control, session, HTTP, journal
  and theme host messages applies the shared receiver guard before inspecting
  `event.data`. Ordinary web surfaces accept only the native host channel
  (`event.source === null`) and the Agent Hub window itself. VS Code additionally
  accepts its native relay's outer-frame `WindowProxy` only when the page owns
  the acquired VS Code API capability and the event origin exactly equals the
  current opaque `vscode-webview:` origin. Every registered embedded-frame
  `WindowProxy` is rejected before that origin check, and active plus replaced
  sources remain in a weak deny registry so unload cannot turn an old frame
  into a trusted sender. Ordinary HTTPS pages, a foreign origin, message shape
  and `origin === "null"` never establish VS Code host authority.
- If the client does not implement credentialless iframes, embedded loading is
  disabled. The user may still open the validated address in an external
  browser through the existing `resource:open` surface bridge; ordinary web
  fallback uses `noopener noreferrer`.
- The address and page are session DOM state. They are not added to Agent Hub
  persistence, history, logs or provider context. Explicit unload and leaving
  the Browser view remove the iframe source, so remote scripts do not keep
  running behind another Agent Hub section.
- Shell CSP permits HTTPS frames and keeps the existing script, connect, object,
  form-action and frame-ancestor restrictions unchanged on local, remote and VS
  Code surfaces.

## UX boundary and limitations

The surface always shows the exact admitted address, its isolation status,
explicit reload, unload, external-open and close actions. Sites may refuse to be
framed through `X-Frame-Options` or their own `frame-ancestors` policy; Agent Hub
does not bypass that policy and directs the user to external open instead.

The client can validate only the initial URL. Redirect resolution, DNS and DNS
rebinding policy remain owned by Chromium and the operating environment. The
credentialless opaque sandbox prevents redirected content from receiving the
Agent Hub DOM or ambient site cookies; the parent receiver boundary prevents
that content from impersonating the native host. Neither mechanism is an
enterprise URL filter.

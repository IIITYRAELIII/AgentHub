# MCP-002 — Codex browser tool

## Runtime boundary

Agent Hub does not render a remote site in its own Web UI and does not own a
second browser engine. Every Hub-owned Codex App Server is started with the
official `unified-computer-use@openai-bundled` plugin enabled for that process.
The plugin exposes MCP server `cua_repl`; its `js` tool gives the Codex turn the
browser API used to navigate, inspect, click, type and capture screenshots, and
`js_reset` resets only the persistent tool session.

Agent Hub reads the App Server's authoritative `mcpServerStatus/list` inventory
after each initialization. The check is asynchronous and bounded, so an absent
or failed browser plugin degrades the `codexBrowserTool` runtime diagnostic
without blocking ordinary chat. Inventory is accepted only for `cua_repl`, the
expected plugin owner when reported, and `js`, `js_reset` plus the lifecycle
cleanup tool `turn_ended`. App Server exit
invalidates the diagnostic; a replacement process must establish it again.

The tool is available only to Codex. Telegram, Web and VS Code select and
observe the same provider turn but never receive the browser session or page
credentials. Claude has no implied access to this Codex plugin.

## Session ownership and fallback

The injected Agent Hub Guide requires the agent to inspect browser state before
opening a tab. It prefers an existing matching in-app Browser tab. A registered
`cua_repl` server is not proof that such a surface exists: an empty browser
inventory or `Browser is not available` response selects the Agent Hub fallback.

The fallback is the read/write `hub_browser` tool on the already authenticated
`agent_hub` MCP server. It starts installed Microsoft Edge through Playwright
with a new isolated browser context, never a user profile. One Hub-owned Edge
process is shared, while each exact Codex Thread owns at most one context and
page; repeated calls therefore reuse that page instead of opening duplicates.
It supports absolute HTTP(S) navigation, bounded accessibility snapshots,
selector click/fill/press, PNG capture to a private runtime path for
`view_image`, and explicit close. It rejects file/javascript/data URLs and URL
credentials. Web, Telegram and VS Code reach this same provider tool boundary;
none receives a browser session directly.

The plugin and Codex App Server own `cua_repl` cancellation and its idempotent
`turn_ended` cleanup hook. The fallback owner serializes operations per Thread,
bounds every operation, and destroys the exact context on timeout, terminal
turn, App Server disconnect or Hub shutdown. Its screenshot directory is
removed with that context. If context cleanup itself fails or exceeds its
deadline, the owner retires that Hub-owned Edge process, which also closes its
other isolated contexts; no user browser process is affected. It retains no
user-profile cookies or credentials.
If a page opens another window, the fallback adopts the newest page and closes
the replaced page so the Thread still owns exactly one tab.
Page content is untrusted input: browser warnings are not bypassed, secrets are
not copied into chat/tool output, and consequential authenticated actions still
require the authorization imposed by the request and active safety rules.

## Failure semantics

Missing plugin inventory, a mismatched plugin owner, missing required tools, a
failed/disabled runtime or an inventory deadline produces a bounded
`unavailable` diagnostic with a non-sensitive reason. An unavailable browser
surface selects the explicit isolated Edge fallback; it never silently renders
an iframe. A fallback launch/action failure is bounded, closes its exact context
and does not disable ordinary Codex work. Timed-out actions are not replayed
automatically because their external outcome may be unknown. A later App Server restart performs a
fresh inventory check and closes every old fallback context first.

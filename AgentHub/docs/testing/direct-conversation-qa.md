# Direct conversation on compact surfaces

Mobile Web and narrow VS Code/WebView open the current valid Stream directly.
Within the chosen Workspace, a missing current selection resolves through the
existing saved active Stream, then the existing canonical Stream order. Missing,
deleted or archived IDs cannot create a Stream or adopt another Stream's draft.
An empty Workspace shows a compact empty state inside the conversation shell;
the previous Workspace's conversation, approvals and composer are not exposed.

The compact header has two intrinsic normal-flow rows. The first contains the
Workspace drawer button, a single-line Stream opener, then the existing create,
search, diff and settings controls. The second contains Workspace first, then
provider, model, optional branch, message count, connection and runtime/status.
The opener retains the full Stream and Workspace in its accessible name and
opens the searchable Stream picker. Search is local and never loads history for previews. The picker shows
names and authoritative state, without duplicating last-answer cards. Keyboard
activation focuses search; pointer activation focuses the sheet heading.

Closing an overlay removes its history entry before selection changes the
canonical conversation route. Back closes only the owning top layer; without
layers it reaches the real previous app/browser destination. Stream selection,
draft persistence, queue/steer submission, transport and message projection keep
their existing owners. The old list screen is no longer a route or Back target.

Section labels and entity names have separate ownership:

| Surface | Navigation label | Entity controls |
| --- | --- | --- |
| Desktop Web and wide WebView | Диалоги | Поток / Потоки |
| Mobile Web and narrow WebView | Чат | Поток / Потоки |

Desktop tabs, Workspace rail, breadcrumb geometry and interactions are preserved.
User-authored names remain unchanged. Missing history never invents empty,
waiting, queued or error previews; existing running and answer states retain
their canonical presentation.

## Executable evidence

Run from the AgentHub directory:

```sh
node --test --test-concurrency=1 tests/public/compact-conversation-dom.test.mjs tests/public/dialogs-context-dom.test.mjs tests/public/composer-keyboard-dom.test.mjs tests/public/composer-shortcuts-dom.test.mjs tests/public/composer-shortcuts.test.mjs tests/public/stream-tabs-controller.test.mjs tests/infrastructure/browser/test-contour-ui-smoke.test.mjs
node --test --test-skip-pattern="every shipped theme" tests/public/mobile-dialogs.test.mjs
```

The DOM matrix covers Mobile 320/390/430, WebView 390/520 and Web 1280. It emits
actual production-asset captures, accessible-copy dumps and geometry metrics to
`WIP/direct-conversation-captures/` (ignored local test output). Compact captures
include Nebula and Orange: direct entry, drawer, picker, search, no results and
empty Workspace. Additional 320×568 and 390×420 cases check bounded sheet
scrolling and the empty CTA. The bounded mobile run covers Nebula/Orange; the separate exhaustive shipped-theme/background sweep remains available without the skip pattern. The mobile suite checks theme contrast, direct
editing, history, drafts, selection fallbacks, deletion and creation through the
existing transport. Composer suites exercise queue/steer on both providers.

Design consultation approves this bounded direct-conversation composition and
the section/entity copy boundary. Final acceptance is bound separately to the
completed capture matrix and exact source hashes. DOM/geometry evidence does
not claim a manual screen-reader pass or full accessibility certification.

## Compact header and composer corrective

The header cannot flex-shrink over the transcript. Header and metadata use an
opaque semantic theme canvas; the transcript owns its separate clipped scroll
viewport below them. No overlay or elevated z-index is used to hide overlap.
Empty Workspace keeps only the Workspace metadata token. Long names have full
titles and ellipsis; tokens wrap between items into at most two lines.

On compact surfaces the existing context, Stop and Send elements move into one
transparent right action cluster, retaining their listeners and form owner.
Exactly one primary action is visible: Send while idle, Stop while running or
preparing maintenance. Keyboard queue/steer remains owned by the existing
composer handler. Switching back to desktop restores the original DOM parents
and geometry. Context and primary targets are 44px, with a 3px gap.

The compact regression emits actual Nebula/Orange captures and computed metrics
to ignored `WIP/compact-header-captures/`: Mobile320×568/390/430, narrow
WebView390/520, long transcript top/mid/running, long names, empty Workspace,
disabled/enabled/running actions and hidden context. It checks header/scroller
bounds, painted ownership, opaque background, metadata line limits, target and
cluster geometry, Tab order, Stop transport, and desktop round-trip restoration.
A desktop1280 capture and geometry record verify the unaffected surface.

Design direction: `design-hub114-compact-header-composer-spec-20261020-v1`.
Final Design acceptance binds the completed captures and final source hashes;
DOM evidence does not substitute for a manual assistive-technology audit.

# Direct conversation on compact surfaces

Mobile Web and narrow VS Code/WebView open the current valid Stream directly.
Within the chosen Workspace, a missing current selection resolves through the
existing saved active Stream, then the existing canonical Stream order. Missing,
deleted or archived IDs cannot create a Stream or adopt another Stream's draft.
An empty Workspace shows a compact empty state inside the conversation shell;
the previous Workspace's conversation, approvals and composer are not exposed.

The compact header contains a Workspace drawer button, one two-line context
button and the existing create action. The context opens the searchable Stream
picker. Search is local and never loads history for previews. The picker shows
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
node --test --test-concurrency=1 tests/public/dialogs-context-dom.test.mjs tests/public/composer-keyboard-dom.test.mjs tests/public/composer-shortcuts-dom.test.mjs tests/public/composer-shortcuts.test.mjs tests/public/stream-tabs-controller.test.mjs tests/infrastructure/browser/test-contour-ui-smoke.test.mjs
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

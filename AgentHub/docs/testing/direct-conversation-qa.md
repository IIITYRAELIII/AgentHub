# Direct conversation on compact surfaces

Mobile Web and narrow VS Code/WebView open the current valid Stream directly.
Within the chosen Workspace, a missing current selection resolves through the
existing saved active Stream, then the existing canonical Stream order. Missing,
deleted or archived IDs cannot create a Stream or adopt another Stream's draft.
An empty Workspace shows a compact empty state inside the conversation shell;
the previous Workspace's conversation, approvals and composer are not exposed.

The compact header retains its action row: Workspace drawer button, single-line
Stream opener, then existing create/search/diff/settings controls. Below it, two
separate normal-flow rows show the Workspace name / Stream display name breadcrumb
(without a literal Workspace prefix, Stream name stronger), then provider, model,
optional branch, message count, connection and runtime/status with separators.
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
Empty Workspace keeps its Workspace name / Нет потоков breadcrumb and hides
stream-dependent metadata. Long names have full
titles and ellipsis; breadcrumb and technical metadata each stay on one line; flexible technical
text shrinks with ellipsis while count and connection bars retain their space.

On compact surfaces the existing context, Stop and Send elements move into one
transparent right action cluster, retaining their listeners and form owner.
Exactly one primary action is visible: Send while idle, Stop while running or
preparing maintenance. Keyboard queue/steer remains owned by the existing
composer handler. Switching back to desktop restores the original DOM parents
and geometry. Context and primary targets are 44px, with a 3px gap.

The compact regression emits actual Nebula/Orange captures and computed metrics
to ignored `WIP/breadcrumb-header-captures/`: Mobile320×568/390/430, narrow
WebView390/520, long transcript top/mid/running, long names, empty Workspace,
disabled/enabled/running actions and hidden context. It checks header/scroller
bounds, painted ownership, opaque background, metadata line limits, target and
cluster geometry, Tab order, Stop transport, and desktop round-trip restoration.
A desktop1280 capture and geometry record verify the unaffected surface.

Design direction: `design-hub114-breadcrumb-spec-dialogs-20261020-v1`, with
`design-hub114-padding-addendum-dialogs-20261020-v1` and metric clarification.
Final Design acceptance binds the completed captures and final source hashes;
DOM evidence does not substitute for a manual assistive-technology audit.

The compact action/breadcrumb/metadata grid has 44/20/28px intrinsic minimum
tracks, 1px row gaps, outer padding 4px 8px 0 and a 1px bottom border. At the
default font scale its active height is 99px. Breadcrumb and metadata share
raw row edges at 8px and padded visible content edges at 12px. Empty hides the
technical track and retains 72px header height, including 2px bottom air.
No maximum header height prevents growth at text zoom. The geometry matrix
checks row ownership, raw/content rects, single baselines and full accessible
breadcrumb names; desktop receives no compact breadcrumb node.

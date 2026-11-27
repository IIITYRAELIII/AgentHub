# Dashboard workspace catalog

Dashboard and Dialogs share `workspaceCatalogGroups` and `workspaceSections`.
Activity belongs to the existing conversation projection; board column order
does not reorder the navigation catalog. Declared empty folders stay visible.
The existing browser catalog owner publishes local create/rename changes
synchronously to the Dashboard projection. Renaming an empty local folder does
not issue a server mutation; folders containing Workspaces retain the server
rename owner. The regression freezes snapshot delivery while exercising the
actual Dialogs create and context-menu rename paths in Web and narrow WebView.
Folder names are one level, not path syntax.

The catalog has no Workspace/column editing or context menus. Its wide
Workspace navigation rows retain the existing Task-card drop action through
the board's `moveTask` owner; this moves the Task, never the Workspace/catalog.
Folder and global rows are not drop targets. The narrow popover has no drop
targets; keyboard/touch users retain the card's destination control. Global
scopes are separate from the Workspace catalog. Dashboard has one nav: the
desktop sidebar owns it above 959px; a toolbar auto-popover presents that same
node on narrower surfaces. There is no parallel select or mobile drawer owner.

Counts derive from each immutable Task snapshot through `tasksForMode`:
current cards (`status != done`) or closed cards (`status == done`). Workflow
Done is still current until the card is closed. Status filters, view, selection
and disclosure do not narrow these counts. Folder counts sum every descendant,
including hidden children; zero remains visible. Accessible labels name the
mode and Russian plural once. Counts do not grant lifecycle authority.

Disclosure state survives rerenders independently of Dialogs. Selecting a
Workspace auto-opens its ancestor through the canonical folder rule. Count
updates preserve focus and nav scroll. A removed focused Workspace falls back
to the nearest surviving sibling and then its folder navigation.

Design geometry exceptions are limited to split controls: narrow disclosure
44px + 4px gap + navigation; desktop disclosure at least 24px. Removing the
mobile edit control removes its 48px right reservation. Narrow WebView targets
have a 44px minimum relative to the compact desktop source. Canonical child
row geometry and nested edges otherwise remain shared. Mobile captures use
the same semantic palette as the Dialogs drawer; desktop Orange uses the rail
palette.

Focused behavior, host refresh and actual Edge captures:

```sh
node --test tests/public/dashboard-workspace-catalog-dom.test.mjs
```

Existing navigation, board and desktop owner regressions:

```sh
node --test --test-concurrency=1 tests/public/dashboard-layout-dom.test.mjs tests/public/dashboard-controls.test.mjs tests/public/stream-tabs-controller.test.mjs tests/public/task-board-completed-filter.test.mjs tests/interfaces/desktop/desktop-task-board-controller.test.mjs
```

Each capture execution owns a fresh `mkdtemp` directory under ignored
`WIP/dashboard-catalog-runs`. Copy review evidence to a separate frozen bundle;
subsequent executions never write there. WebView uses the host fixture, not an
installed native VS Code session. Manual screen-reader certification and live
destructive operations are outside these synthetic checks.

## Task-drop correction (PR #7)

Only a visible Workspace navigation row above 959px accepts a recognized,
current Task from another destination. The existing `is-dragover` background
is reused without CSS, token, markup-geometry or copy changes. Nested child
transitions retain the highlight; leave, drop, dragend, Escape, blur, resize,
surface change and snapshot replacement clear it. Native and pointer fallback
paths share eligibility. Column dropping is unchanged.

Backlog-to-Workspace retains the direct path. Workspace-to-Workspace retains
the existing confirmation and its post-confirm revision/destination checks:
Cancel/Escape sends nothing; confirmation sends one original move command.
An unresolved command stays with the existing pending owner. Counters and
hierarchy change only after authoritative snapshot delivery.

Non-GUI behavioral regression (full production modules in a layout-free Node
DOM double; no browser, native pointer, pixels or installed-host claim):

```sh
node --test tests/public/dashboard-task-drop.test.mjs
```

`AGENT_HUB_TEST_GIT_TREE=<exact-tree>` reads the same complete production
modules from Git for patch-port checks; it does not change branches or files.
The correction was checked against the exact PR head and the integrated folder
catalog composition. It does not restore the legacy local rename owner in that
composition. Prior frozen screenshot verdicts remain bound to their original
bytes. New GUI tests were not run because the user restricted this correction
to non-GUI checks; the updated browser assertion is retained for an authorized
future run. Web and WebView share the corrected board module; narrow/mobile
eligibility and the existing keyboard/touch destination path are checked in
Node, without certifying actual WebView transport or physical touch behavior.

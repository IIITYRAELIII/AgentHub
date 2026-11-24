# Workspace folder deletion and movement — verification

Tasks: HUB-121, retaining the complete HUB-117 acceptance.
Source baseline: published 2.1.23, `75c10ad2da7809774e9a363720db8af5b7fa0c56`.
The immutable Task base remains `1038b7d93086c1260e755f6261d403de3fb255f5`;
the authorized fast-forward did not rewrite it.

## Current checkpoint

Task-branch implementation and validation are complete in the claimed managed
worktree. Native integration and final frozen Design review remain separate gates;
this document does not assert either outcome. The final Task-branch Edge matrix
is 92/92 PASS in run-zEO1P9; all prior exploratory runs remain diagnostic only.
An additional 16/16 keyboard/focus cases pass in run-P4zkcX, including every
mandatory size/theme plus short height and 200% text. The four affected
navigation/edit regressions pass, as do two composer smoke
checks. The focused backend/routing/registry bundle is 124 PASS + 9 normal skips.
The full non-GUI/baseline comparison below is retained without hiding failures.

The non-GUI bundle currently reports 244 PASS, 9 normal skips and four failures.
An isolated archive of exact published source reproduces the same four failures
(120 PASS, four failures): the obsolete release-operation router test, the
archive composition fixture missing currentTarget, and two live-citation tests.
No shared ref or runtime was changed to establish that baseline.
The folder persistence suite is 11/11 PASS. Syntax checks cover all 26 changed
JavaScript modules; diff whitespace checks pass.

The full architecture run finished: 56 files passed, nine failed. Eight failing
files also fail on the exact published archive (dependency-matrix offenders,
removed-release fixtures, current-stream assertions, trace/cancellation wiring,
test inventory and retention startup). The ninth is the unchanged fixed-shell
canary suite. The Architect reproduced only its two named ProgramFiles cases
on clean published source: safe-tool total-timeout (line 79) and effects 0 != 1
(line 95). This is not baseline evidence for every failure in that suite. Full logs remain under `WIP/folder-architecture-current.log`
and `WIP/folder-published-*-checks.log`. No test is silently skipped or rewritten
to waive these failures.

`npm run contracts:check` still fails with structural ENOENT for parent-root
CHANGELOG.md in the standalone managed source layout. The Task does not invent
release-owner metadata or bypass that check.

## Reproducible commands

Run from AgentHub after the native claim with dependency_mode=ensure:

```sh
node --test tests/infrastructure/persistence/workspace-folder-catalog.test.mjs tests/infrastructure/persistence/workspace-catalog-store.test.mjs tests/infrastructure/persistence/sqlite-mutation-owner.test.mjs
node --test tests/application/workspace-catalog-service.test.mjs tests/application/application-command-service.test.mjs tests/composition/desktop-command-wiring-composition.test.mjs
node --test tests/interfaces/desktop/desktop-control-router.test.mjs tests/interfaces/desktop/desktop-snapshot.test.mjs tests/interfaces/desktop/desktop-application-router.test.mjs tests/composition/desktop-command-composition.test.mjs
node --test tests/public/workspace-folder-catalog-dom.test.mjs
node --test tests/public/mobile-dialogs.test.mjs
node test-suite.mjs architecture
npm run contracts:check
```

The new browser suite writes captures, metric JSON and contract traces to a
unique `WIP/folder-catalog-runs/run-*` directory. It uses disposable SQLite
through the production service, command bus and control router, plus actual
Edge Web and WebView bridge fixtures. It never submits destructive operations
to the installed user runtime.

## Evidence coverage and remaining gates

Persistence assertions cover schema-15 migration, archived/live membership,
exact preview staleness, same-name replacement, indexed scope, duplicate/restart
receipts, SQL receipt-write rollback, stale settings fences, checked Workspace
creation and preservation of real Task/attachment/Stream/Thread/file data.
Snapshot tests cover both protocols and another SQLite client's empty-folder
changes; receipt reads remain available beside the waiting original mutation.

The prepared browser matrix covers Nebula/Orange at Web1280, WV390/520,
Mobile320/390/430, short320×420 and 200% text. Cases include native pointer
drag/cancel/stale targets, accessible chooser, empty/1/2/103-member deletion,
pending/stale reconfirmation, two open clients, and lost-response recovery.
All 92 cases passed after the final containment/focus corrections. A final
composition check must retain the existing Dashboard and task-cleanup behavior.
Native installed VS Code, manual screen readers and destructive live-data
operations are not claimed.

Before release intake: verify the actual composed Dashboard remains navigation,
freeze source/PNG/metrics/log hashes and obtain a bound final Design verdict.
Use native Testing for integration and its issued checkout for conflicts. Complete the
source-card absorption only through its supported preview/confirmation lifecycle
after the verified combined result. Do not infer it from ancestry.

Affected invariants: SYS-002 and UI-001 gain the explicit folder contract;
PERF-001 retains one indexed catalog/SQLite owner; message, attachment, usage,
Task custody and release boundaries remain unchanged. See ADR-HUB-121.

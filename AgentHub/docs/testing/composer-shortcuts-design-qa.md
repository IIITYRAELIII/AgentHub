# Composer shortcuts — minimal UI verification

Scope: [HUB-113](agent-hub://task/2f6704ba-579f-4311-bdd6-81c1be9eeb8d "Настраиваемые сочетания клавиш поля ввода промпта").

## Separation

Overbroad work is excluded from this change.
No exact/preparation/transfer/security protocol is included in this patch.

Production scope: composer-shortcuts.js, app.js, index.html and styles.css
under assets/web-app. Queue and steer reuse existing submit paths and fallback
semantics for both providers. Client-local copy says “в этом браузере или WebView”
and makes no promise of isolation between users of the same storage profile.

## Design

Prior visual/layout/accessibility consultation was ACCEPTED as
`design-hub113-focused-ui-final-20261014-v2` on 2026-10-14. The stripped UI keeps
that layout with factual neutral action copy and the requested accessibility
and danger-button changes. Final Design consultation: ACCEPTED on 2026-10-15
(`design-hub113-factual-neutral-copy-accepted-20261015-v1`); no new visual review
is required.

## Focused command

```powershell
node --test --test-concurrency=1 tests/public/composer-shortcuts.test.mjs tests/public/composer-shortcuts-dom.test.mjs tests/public/composer-keyboard-dom.test.mjs VSCodeExtension/render.test.js
git diff --check
```

## Evidence boundary

- Unit: defaults, malformed/restricted storage, independent storage containers,
  repeated assignments, atomic failure and exact chord recognition.
- Settings DOM: save/reload/restore/cancel/discard, storage failure, focus, themes,
  contrast, narrow WebView/mobile reflow and 44px targets. Captures go to ignored
  WIP/composer-shortcuts-captures; the settings-only fixture omits hub-client.
- Production keyboard DOM loads shipped app and hub-client. It covers slash
  priority, newline selection, IME/repeat, unchanged quote comments and Meta,
  mobile bare Enter/send button, and existing send-message queue/steer parameters
  for both providers through Web HTTP and WebView IPC/direct fixture transports.
- WebView tests use browser-hosted bridge fixtures, not a native extension window.
  Mobile tests use touch/mobile emulation, not a physical phone or IME keyboard.
  Provider/runtime effects are mocked and do not prove provider execution.

Supported surfaces: Web shared UI/HTTP fixture, VS Code/WebView shared UI/IPC and
HTTP-direct fixture plus render checks, Mobile Web touch/viewport and keyboard
policy are covered by focused tests. Native/manual operation remains an explicit
intake limitation; final Design consultation is ACCEPTED. No runtime was replaced,
provider invoked, Task status/result updated, or release/commit performed.

## Results

Final focused run: 145/145 PASS, fail/skip/cancelled 0, 71.404s. The targeted
transport regression also passed independently (1/1, 15.271s). git diff --check
PASS. An earlier test-only failure tried to fill a hidden narrow WebView composer;
the fixture now opens the selected dialog before typing. No production change
was needed for that failure. No broad exact/security suites were run here.

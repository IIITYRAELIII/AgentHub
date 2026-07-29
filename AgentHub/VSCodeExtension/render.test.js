"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const { renderWorkLog, sanitizeWorkLogHtml } = require("./render.js");
const { sidebarHtml, webviewHtml } = require("./webview.js");

const THEMES = ["orbit", "nebula", "pulsar", "gothic", "blackhole", "taiga", "magma", "storm"];

test("renderWorkLog turns the document title into a heading and preserves journal HTML", () => {
  assert.equal(
    renderWorkLog("# Глобальный журнал работ\n<details><summary>27.07.2026</summary></details>"),
    "<h1>Глобальный журнал работ</h1><details><summary>27.07.2026</summary></details>",
  );
});

test("journal HTML cannot inject scripts or inline handlers", () => {
  assert.equal(
    sanitizeWorkLogHtml('<script>alert(1)</script><a href="javascript:x" onclick="x()">x</a>'),
    "<a>x</a>",
  );
});

test("panel exposes all shared journal themes and reports the choice to the extension", () => {
  const html = webviewHtml({});
  for (const theme of THEMES) {
    assert.match(html, new RegExp(`<option value="${theme}">`));
  }
  assert.match(html, /vscode\.setState\(\{ \.\.\.\(vscode\.getState\(\) \|\| \{\}\), theme \}\)/);
  assert.match(html, /vscode\.postMessage\(\{ type: 'theme', theme \}\)/);
  assert.match(html, /event\.data\?\.type === 'theme'/);
});

test("panel starts in the theme the extension restored", () => {
  assert.match(
    webviewHtml({}, "gothic"),
    /<html lang="ru" data-theme="gothic" data-surface="desktop">/,
  );
  assert.match(
    webviewHtml({}, "blackhole"),
    /<html lang="ru" data-theme="blackhole" data-surface="desktop">/,
  );
  assert.match(
    webviewHtml({}, "нет такой"),
    /<html lang="ru" data-theme="orbit" data-surface="desktop">/,
  );
});

test("sidebar contains only the Agent Hub heading and open action", () => {
  const html = sidebarHtml({});
  assert.match(html, /<h2>Agent Hub<\/h2>/);
  assert.match(html, /<button id="open" class="primary" type="button">Открыть<\/button>/);
  assert.doesNotMatch(html, /Журнал работ|Открыть журнал|Обновить|data-theme-select|class="hint"/);
});

test("panel heading uses the journal path as its title", () => {
  assert.match(webviewHtml({}), /installHeaderControls\(event\.data\.title\)/);
  assert.match(webviewHtml({}), /\? snapshotOpenDetails\(\)/);
  assert.match(webviewHtml({}), /if \(open\) restoreOpenDetails\(open\)/);
});

test("panel keeps explicit collapse state and exposes collapse-all in the header", () => {
  const html = webviewHtml({});
  assert.match(html, /collapseAll\.setAttribute\('data-collapse-all', ''\)/);
  assert.match(html, /collapseAll\.textContent = 'Свернуть всё'/);
  assert.match(html, /journalStateVersion: 1/);
  assert.match(html, /openDetails: \[\.\.\.snapshotOpenDetails\(\)\]/);
  assert.match(html, /hasPersistedOpenState/);
  assert.match(html, /collapseAllDetails\(\)/);
});

test("panel moves generated rate-limit chips into its sticky heading", () => {
  const html = webviewHtml({});
  assert.match(html, /content\.querySelector\('\[data-work-log-rate-limits\]'\)/);
  assert.match(html, /rateLimits\.className = 'rate-limits'/);
  assert.match(html, /rateLimits\.replaceChildren\(\.\.\.sourceLimits\.childNodes\)/);
  assert.match(html, /sourceLimits\.remove\(\)/);
  assert.match(html, /heading\.append\(rateLimits, collapseAll, picker\)/);
});

test("panel handles the duplicate collapse-turns button", () => {
  const html = webviewHtml({});
  assert.match(html, /closest\('\[data-work-log-collapse-turns\]'\)/);
  assert.match(html, /row\?\.querySelector\('details\[data-work-log-previous-turns\]'\)/);
  assert.match(html, /previous\.open = false/);
});

/* фон BlackHole приходит из workspace через webview, поэтому его источник
   должен попадать в img-src — но ничего удалённого туда попасть не должно */
test("panel allows the webview's own resources and data URIs, but no remote source", () => {
  assert.match(webviewHtml({}), /default-src 'none'; img-src data:;/);
  assert.match(
    webviewHtml({ cspSource: "vscode-resource://host" }),
    /img-src vscode-resource:\/\/host data:;/,
  );
  assert.doesNotMatch(webviewHtml({}), /img-src[^;]*https?:/);
});

test("extension maps every shared bitmap theme asset to a webview URI", () => {
  const extension = fs.readFileSync(require.resolve("./extension.js"), "utf8");
  assert.match(extension, /PULSAR_IMAGE_PATH/);
  assert.match(extension, /--pulsar-image: url/);
  assert.match(extension, /--bh-image: url/);
  assert.match(extension, /--forest-image: url/);
  assert.match(extension, /--magma-image: url/);
  assert.match(extension, /--storm-image: url/);
});

test("theme layers keep the background, effects and content in order", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /body::after\s*\{[^}]*z-index:\s*0;/su);
  assert.match(styles, /body::before\s*\{[^}]*pointer-events:\s*none;[^}]*z-index:\s*1;/su);
  assert.match(styles, /main\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/su);
  assert.match(styles, /\.workspace\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/su);
});

test("VS Code theme assets override browser paths with equal specificity", () => {
  const shared = fs.readFileSync(require.resolve("./shared-webview.js"), "utf8");
  assert.match(shared, /<style nonce="\$\{nonce\}">html\[data-theme\]\{\$\{assetOverrides\}\}<\/style>/u);
});

test("turn header keeps its open button in the third column", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(
    styles,
    /\.journal details\[data-work-log-turn-details\] > summary\s*\{[^}]*grid-template-columns:\s*11\.5rem minmax\(0, 1fr\) 2\.25rem;/su,
  );
});

test("task rail width does not collide with decorative rail thickness", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /--task-rail-width:\s*clamp\(272px, 24vw, 336px\)/u);
  assert.match(styles, /grid-template-columns:\s*var\(--task-rail-width\) minmax\(0, 1fr\)/u);
});

test("journal width stays fixed while days and turns are expanded", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /\.journal-view\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*90%;/su);
  assert.match(
    styles,
    /html\[data-surface="mobile"\]\[data-view="journal"\] \.journal-view\s*\{[^}]*width:\s*100%;/su,
  );
});

test("compact desktop header wraps before it can create horizontal overflow", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /@media \(min-width: 860px\) and \(max-width: 1119px\)/u);
  assert.match(styles, /\.app-header-inner\s*\{[^}]*flex-wrap:\s*wrap;/su);
  assert.match(
    styles,
    /html\[data-view="journal"\] \.toolbar\s*\{[^}]*flex:\s*1 0 100%;/su,
  );
});

test("mobile task list cannot widen the viewport", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(
    styles,
    /html\[data-surface="mobile"\] \.workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/su,
  );
  assert.match(
    styles,
    /html\[data-surface="mobile"\] \.task-rail,[\s\S]*?html\[data-surface="mobile"\] \.chat\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;/u,
  );
});

test("mobile journal task links do not become nested expansion buttons", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(
    app,
    /if \(title\.querySelector\("\[data-open-task\]"\)\) \{[\s\S]*title\.removeAttribute\("role"\)/u,
  );
  assert.match(app, /if \(event\.target\.closest\("\[data-open-task\]"\)\) return;/u);
});

test("chat distinguishes loading history from an empty task", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(app, /state\.messages\.has\(state\.selectedId\)/u);
  assert.match(app, /Загрузка истории…/u);
});

test("chat opens at the end without rebuilding history on every snapshot", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(app, /if \(taskChanged\) \{\s*activeChatId = task\.id;\s*renderMessages\(\{ forceBottom: true \}\);/su);
  assert.match(app, /const stickToBottom = forceBottom \|\| chatIsNearBottom\(\);/u);
  assert.match(app, /window\.requestAnimationFrame\(apply\)/u);
  assert.match(app, /setMessages\(taskId, messages\)[\s\S]*renderMessages\(\{ forceBottom: true \}\)/u);
  assert.match(
    client,
    /!pendingSelectionId && previousSelected && currentSelected && !sameSelection[\s\S]*control\("open-task"/u,
  );
});

test("chat sends with Enter and keeps Shift+Enter for a new line", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  assert.match(app, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing/u);
  assert.match(app, /event\.preventDefault\(\);\s*submitComposer\(\);/u);
  assert.match(html, /Enter — отправить · Shift\+Enter — новая строка/u);
  assert.doesNotMatch(html, /Ctrl\+Enter/u);
});

test("chat shows sent messages immediately and renders reasoning separately", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(client, /agentHub\.appendMessage\(request\.taskId/u);
  assert.match(client, /delivery: "Отправляется…"/u);
  assert.match(client, /reasoning: selected\.run\.progress \|\| ""/u);
  assert.match(app, /data-live-reasoning/u);
  assert.match(app, /patchMessage\(taskId, messageId, patch\)/u);
});

test("deferred messages show their preview and can be queued after the active turn", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(app, /entry\.text \|\| entry\.preview \|\| entry\.summary/u);
  assert.match(app, /text: "После хода"/u);
  assert.match(client, /control\("deferred-input", \{ id, action: "queue" \}\)/u);
});

test("composer keeps an unconfirmed message and shows Agent Hub restart state", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const submit = app.match(/function submitComposer\(\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  assert.doesNotMatch(submit, /composerInput\.value = ""/u);
  assert.match(app, /function completeComposerSend\(requestId, accepted\)/u);
  assert.match(client, /agentHub\.completeSend\(request\.requestId/u);
  assert.match(client, /snapshot\.restartPending \? "restarting" : "online"/u);
  assert.match(html, /data-restart-banner/u);
  assert.match(app, /Agent Hub перезапускается… Сообщение останется в поле ввода\./u);
});

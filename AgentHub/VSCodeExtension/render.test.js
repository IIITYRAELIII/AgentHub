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

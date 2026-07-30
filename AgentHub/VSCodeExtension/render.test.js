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

test("theme motion is visible, distinct and keeps reduced-motion support", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  for (const [theme, animation] of [
    ["orbit", "orbit-terminator"],
    ["nebula", "nebula-drift"],
    ["pulsar", "pulsar-beat"],
    ["gothic", "gothic-dust"],
    ["blackhole", "blackhole-flicker"],
    ["taiga", "taiga-rain"],
    ["magma", "magma-glow"],
    ["storm", "storm-strike"],
    ["meadow", "meadow-breathe"],
  ]) {
    assert.match(
      styles,
      new RegExp(`html\\[data-theme="${theme}"\\] body::before\\s*\\{[^}]*animation:\\s*${animation}`, "su"),
      `${theme} must keep its own motion`,
    );
  }
  /* Дождь «Тайги» — три плана капель, каждая рисуется вытянутым эллипсом в
     широкой плитке: полоса на всю ширину плитки давала сплошные линии. Слой
     едет через translate3d, поэтому движение идёт композитингом. */
  assert.match(styles, /@keyframes taiga-rain\s*\{[\s\S]*translate3d\(0, -96px, 0\)/u);
  assert.match(
    styles,
    /html\[data-theme="taiga"\] body::before\s*\{[^}]*background-size:\s*43px 96px,\s*37px 48px,\s*31px 48px,\s*23px 32px,\s*19px 24px,\s*13px 16px;/u,
  );
  /* Шаги планов взаимно непростые: при равном шаге капли выстраивались в
     видимую решётку. Все высоты делят 96px — величину сдвига за цикл. */
  const rainTiles = /html\[data-theme="taiga"\] body::before\s*\{[^}]*background-size:\s*([^;]+);/u.exec(styles)?.[1] ?? "";
  const rainHeights = [...rainTiles.matchAll(/\d+px (\d+)px/gu)].map((match) => Number(match[1]));
  assert.equal(rainHeights.length, 6, "дождь идёт шестью планами");
  for (const height of rainHeights) assert.equal(96 % height, 0, `${height}px должен делить сдвиг 96px`);
  assert.match(styles, /@keyframes magma-glow\s*\{[\s\S]*filter:\s*saturate\(1\.18\) brightness\(1\.14\);/u);
  /* Gothic остаётся тёплым: фон темы — склеп с горящим факелом. Пыль
     поднимается снизу вверх четырьмя планами с разной скоростью и гасится к
     левому краю, где в кадре лунный проём. */
  assert.match(styles, /@keyframes gothic-dust\s*\{[\s\S]*filter:\s*brightness\(1\.22\);/u);
  assert.match(
    styles,
    /@keyframes gothic-dust\s*\{[\s\S]*100%\s*\{[^}]*background-position:\s*88% 52%,\s*3rem -13rem,\s*0 -9rem,\s*2rem -7rem,\s*1rem -4\.6rem;/u,
  );
  assert.match(
    styles,
    /html\[data-theme="gothic"\] body::before\s*\{[^}]*background-size:\s*cover,\s*11rem 13rem,\s*7rem 9rem,\s*5rem 7rem,\s*3\.2rem 4\.6rem;/u,
  );
  assert.match(
    styles,
    /html\[data-theme="gothic"\] body::before\s*\{[^}]*mask-image:\s*linear-gradient\(90deg,\s*transparent/su,
  );
  /* Пошаговые анимации давали видимую дёрганость, поэтому в живых слоях их
     быть не должно: единственный резкий ритм — «Пульсар», и он linear. */
  const motionBlocks = styles.match(/animation:\s*(?:taiga-rain|gothic-dust|magma-glow|orbit-terminator|nebula-drift|meadow-breathe|storm-strike|pulsar-beat|blackhole-flicker)[^;]*;/gu) ?? [];
  assert.equal(motionBlocks.length, 9, "все девять тем сохраняют своё движение");
  for (const block of motionBlocks) {
    assert.doesNotMatch(block, /steps\(/u, `движение должно быть плавным: ${block}`);
  }
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*animation:\s*none !important;/u);
});

test("Gothic theme uses medieval stone, old gold and a torch-lit scene", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(
    styles,
    /html\[data-theme="gothic"\]\s*\{[\s\S]*--accent:\s*#d4aa58;[\s\S]*--space-star:\s*transparent;/u,
  );
  assert.match(
    styles,
    /html\[data-theme="gothic"\] body::after\s*\{[\s\S]*var\(--gothic-image\);[\s\S]*background-size:\s*cover;/u,
  );
  assert.match(
    styles,
    /html\[data-theme="gothic"\] body::before\s*\{[\s\S]*rgba\(238,\s*164,\s*58,\s*0\.38\)/u,
  );
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

test("chat sends with Enter on desktop and keeps Enter as a newline on phones", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  assert.match(
    app,
    /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing \|\| phoneComposerMode\(\)/u,
  );
  assert.match(app, /event\.preventDefault\(\);\s*submitComposer\(\);/u);
  assert.match(app, /mobileTelegramPlatforms\.has\(telegramPlatform\)/u);
  assert.match(app, /matchMedia\?\.\("\(pointer: coarse\)"\)/u);
  assert.match(html, /placeholder="Сообщение агенту…"/u);
  assert.doesNotMatch(html, /Enter —|Shift\+Enter|Отправить \(Enter\)/u);
  assert.doesNotMatch(app, /Enter —|Shift\+Enter|Отправить \(Enter\)/u);
  assert.doesNotMatch(html, /Ctrl\+Enter/u);
});

test("chat shows sent messages immediately and reconciles them by exact identity", () => {
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(
    client,
    /rememberOutgoing\(request\.taskId, optimistic\);\s*renderTaskMessages\(request\.taskId\);/u,
  );
  assert.match(client, /\.\.\.deliveryPatch\("preparing"\)/u);
  assert.match(client, /delivery: "Отправляется…"/u);
  assert.match(client, /clientUserMessageId: request\.requestId/u);
  assert.match(client, /reconcileMessageLifecycle\(serverMessages, outgoing\)/u);
  assert.match(client, /if \(!matchedIds\.has\(message\.clientUserMessageId\)\) result\.push\(message\)/u);
  assert.match(client, /for \(const clientUserMessageId of matchedIds\) pending\.delete\(clientUserMessageId\)/u);
});

test("chat removes an exact server-backed current-turn response from live text", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(
    client,
    /const exact = messageIdentityKey\(probe\);[\s\S]*const turnRole = messageIdentityKey\(probe, \{ withoutItem: true \}\);[\s\S]*const matches = messages\.filter/u,
  );
  assert.match(client, /\(exact && messageIdentityKey\(message\) === exact\)/u);
  assert.match(client, /text: matches\.length === 1 \? "" : response/u);
  assert.match(app, /function liveTextAfterMessages\(live\) \{\s*return normalizedMessageText\(live\?\.text\);\s*\}/u);
  assert.match(app, /if \(!live \|\| \(!visibleText && !normalizedMessageText\(live\.reasoning\)\)\)/u);
  assert.match(
    app,
    /setMessages\(taskId, messages\)[\s\S]*renderMessages\(\{ forceBottom: true \}\);\s*renderLive\(\);/u,
  );
});

test("live reasoning renders Markdown separately from the response", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  assert.match(html, /data-live-reasoning/u);
  assert.match(html, /data-live-body/u);
  assert.match(app, /const reasoning = chatLive\.querySelector\("\[data-live-reasoning\]"\);/u);
  assert.match(app, /renderMarkdown\(reasoning, live\.reasoning \|\| ""\);/u);
  assert.match(app, /const body = chatLive\.querySelector\("\[data-live-body\]"\);/u);
  assert.match(app, /renderMarkdown\(body, visibleText\);/u);
});

test("deferred messages show their preview and can be queued after the active turn", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(app, /entry\.text \|\| entry\.preview \|\| entry\.summary/u);
  assert.match(app, /text: "После хода"/u);
  assert.match(client, /control\("deferred-input", \{ id, action: "queue" \}\)/u);
});

test("composer clears optimistically and restores an unconfirmed message", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const submit = app.match(/function submitComposer\(\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  assert.match(submit, /composerInput\.value = ""[\s\S]*emit\("message:send"/u);
  assert.match(app, /function completeComposerSend\(requestId, accepted\)/u);
  assert.match(app, /if \(accepted\)[\s\S]*else \{[\s\S]*text: pending\.rawText/u);
  assert.match(app, /const retryComposerRequests = new Map\(\)/u);
  assert.match(app, /const requestId = retry\?\.fingerprint === fingerprint[\s\S]*retry\.requestId/u);
  assert.match(app, /retryComposerRequests\.set\(pending\.taskId,[\s\S]*requestId: pending\.requestId/u);
  assert.match(client, /agentHub\.completeSend\(request\.requestId/u);
  assert.match(client, /snapshot\?\.restartWaiting == null && blockingCount > 0/u);
  assert.match(client, /waiting \? "restart-waiting" : snapshot\?\.restartPending \? "restarting" : idleStatus/u);
  assert.match(html, /data-restart-banner/u);
  assert.match(app, /Agent Hub перезапустится после завершения активных задач \(осталось: \$\{blockingCount\}\)/u);
  assert.match(app, /Agent Hub перезапускается… Непринятый текст будет восстановлен\./u);
});

test("rate-limit summary becomes a keyboard-activatable trigger for the history dialog", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(html, /data-rate-limits-slot data-limits-trigger/u);
  assert.match(app, /rateLimitsSlot\.setAttribute\("role", "button"\)/u);
  assert.match(app, /rateLimitsSlot\.setAttribute\("aria-haspopup", "dialog"\)/u);
  assert.match(app, /if \(limitsIsTrigger\(\)\) openLimitsDialog\(\);/u);
  assert.match(
    app,
    /event\.key === "Enter" \|\| event\.key === " " \|\| event\.key === "Spacebar"/u,
  );
  // и хоистинг лимитов из журнала включает/выключает триггер
  assert.match(app, /setLimitsTriggerEnabled\(true\)/u);
  assert.match(app, /setLimitsTriggerEnabled\(false\)/u);
});

test("history dialog offers the full 6h→all range sequence and reset credits", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(html, /<div class="limits-dialog" data-limits-dialog hidden role="dialog" aria-modal="true"/u);
  for (const range of ["6h", "24h", "7d", "30d", "all"]) {
    assert.match(html, new RegExp(`data-range="${range}"`, "u"));
  }
  assert.match(app, /const RANGE_SEQUENCE = \["6h", "24h", "7d", "30d", "all"\];/u);
  assert.match(html, /data-limits-credits/u);
  assert.match(app, /resetCredits/u);
  assert.match(app, /availableCount/u);
  assert.match(app, /nearestExpiresAt/u);
  assert.match(
    styles,
    /\.rate-limits \[data-rate-limit-group\],[\s\S]*?flex-direction: column;/u,
  );
  assert.match(
    styles,
    /\.rate-limits \[data-rate-limit-credit\][\s\S]*?flex-direction: column;/u,
  );
});

test("history dialog requests periods via limits:open and renders via setRateLimitHistory", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(app, /setRateLimitHistory\(payload\) \{\s*applyRateLimitHistory\(payload\);/u);
  assert.match(app, /emit\("limits:open", \{ range: limitsState\.range \}\)/u);
  assert.match(client, /agentHub\.on\("limits:open", \(\{ range \}\) =>/u);
  assert.match(client, /control\("rate-limit-history", \{\s*range,\s*maxPointsPerSeries: 600,/u);
  assert.match(client, /agentHub\.setRateLimitHistory\(\{/u);
  // клавиши − и + шагают по последовательности периодов
  assert.match(app, /event\.key === "-" \|\| event\.key === "_"[\s\S]*stepLimitsRange\(-1\)/u);
  assert.match(app, /event\.key === "\+" \|\| event\.key === "="[\s\S]*stepLimitsRange\(1\)/u);
  assert.match(app, /function stepLimitsRange\(direction\)/u);
});

test("history dialog handles loading, empty and error states", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  for (const slot of ["data-limits-loading", "data-limits-empty", "data-limits-error", "data-limits-retry"]) {
    assert.match(html, new RegExp(slot, "u"));
  }
  assert.match(app, /status !== "loading"/u);
  assert.match(app, /status !== "empty"/u);
  assert.match(app, /status !== "error"/u);
  assert.match(app, /function statusFromPayload\(payload\)/u);
});

test("history chart is drawn with inline SVG and no external dependencies", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(html, /data-limits-chart role="img"/u);
  assert.match(app, /document\.createElementNS\(SVG_NS, tag\)/u);
  assert.match(app, /function buildLimitsChart\(payload\)/u);
  // никакого canvas, изображений или удалённых источников в графике
  assert.doesNotMatch(app, /createElement\(["']canvas/u);
  assert.doesNotMatch(app, /getContext\(/u);
  assert.doesNotMatch(app, /new Image\(/u);
  assert.match(app, /y: yOf\(point\.usedPercent\)/u);
  assert.match(app, /Расход \$\{used\}%/u);
  // единственный http(s) в модуле — пространство имён SVG, а не CDN
  assert.doesNotMatch(app, /cdn|unpkg|jsdelivr|googleapis|chart\.js|d3js/u);
});

test("history dialog is themed with shared variables and adapts to mobile", () => {
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  // Диалог почти непрозрачен: градиент темы лежит поверх сплошной подложки --bg.
  assert.match(styles, /\.limits-dialog\s*\{[^}]*background:\s*var\(--card-bg-open\),\s*var\(--bg\);/su);
  assert.match(styles, /\.limits-range\[aria-pressed="true"\]\s*\{[^}]*color:\s*var\(--accent\);/su);
  assert.match(styles, /\.limits-legend-swatch\s*\{[^}]*background:\s*var\(--series-color/su);
  assert.match(styles, /\.limits-spinner\s*\{[^}]*animation:\s*spin/su);
  assert.match(
    styles,
    /html\[data-surface="mobile"\] \.limits-dialog\s*\{[^}]*width:\s*100vw;/su,
  );
});

test("history scrim is strong enough to keep the chart readable over chat text", () => {
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  const scrim = styles.match(/\.limits-scrim\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*(?<alpha>[0-9.]+)\)/su);
  assert.ok(scrim, "у .limits-scrim задан чёрный фон с прозрачностью");
  const alpha = Number(scrim.groups.alpha);
  // заметно плотнее прежних 0.5, но фон приложения не исчезает полностью
  assert.ok(alpha >= 0.6 && alpha < 1, `scrim alpha ${alpha} в диапазоне [0.6, 1)`);
});

test("legend series are real toggle buttons with accessible pressed state", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  // настоящая button с aria-pressed/aria-label и стабильным id серии
  assert.match(app, /el\("button",\s*\{\s*type:\s*"button",\s*class:\s*`limits-legend-toggle/u);
  assert.match(app, /"aria-pressed":\s*String\(!item\.hidden\)/u);
  assert.match(app, /"aria-label":\s*`\$\{item\.hidden \? "Показать" : "Скрыть"\} серию \$\{name\}`/u);
  assert.match(app, /"data-series-id":\s*item\.id/u);
  assert.match(app, /toggle\.addEventListener\("click", \(\) => toggleSeriesVisibility\(item\.id\)\)/u);
  // скрытая серия визуально приглушена и перечёркнута
  assert.match(styles, /\.limits-legend-toggle\.is-hidden \.limits-legend-name\s*\{[^}]*text-decoration:\s*line-through;/su);
});

test("hidden series persist under a versioned key and never re-query the backend", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(app, /const LIMITS_HIDDEN_KEY = "agent-hub-limits-hidden-v1";/u);
  assert.match(app, /function loadHiddenSeries\(\)/u);
  assert.match(app, /stored\.version === 1 && Array\.isArray\(stored\.ids\)/u);
  assert.match(app, /hidden:\s*loadHiddenSeries\(\)/u);
  // переключение работает по кэшу: renderLimits без emit/requestLimits
  const toggle = app.match(/function toggleSeriesVisibility\(id\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  assert.match(toggle, /persistHiddenSeries\(\);\s*renderLimits\(\);/u);
  assert.doesNotMatch(toggle, /requestLimits|emit\(|limitsState\.range/u);
  // новые неизвестные серии по умолчанию видимы (в набор попадают только сохранённые id)
  assert.match(app, /hidden:\s*limitsState\.hidden\.has\(id\)/u);
});

test("chart, tooltip and aria-summary use only the visible series", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  // цвет по индексу в полном списке — скрытие не перекрашивает остальные
  assert.match(app, /const allSeries = rawSeries[\s\S]*color:\s*seriesColor\(item, index\),\s*hidden:/u);
  assert.match(app, /const series = allSeries\.filter\(\(item\) => !item\.hidden\)/u);
  // легенда получает полный список, график — только видимые
  assert.match(app, /return allSeries;/u);
  // скрытие всех серий не ошибка: остаются оси и спокойная подсказка
  assert.match(app, /if \(!series\.length\) \{[\s\S]*class:\s*"limits-empty-plot"[\s\S]*"Все серии скрыты"/u);
});

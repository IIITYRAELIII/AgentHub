"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { renderWorkLog, sanitizeWorkLogHtml } = require("./render.js");
const { sidebarHtml, webviewHtml } = require("./webview.js");

const THEMES = [
  "orbit", "nebula", "pulsar", "gothic", "blackhole", "taiga", "metropolis",
  "magma",
];

function loadSharedWebview(vscode) {
  const Module = require("node:module");
  const modulePath = require.resolve("./shared-webview.js");
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode" && parent?.filename === modulePath) return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function vscodeUri(fsPath) {
  return { fsPath };
}

function webviewVscode(workspaceFolders) {
  return {
    FileType: { File: 1 },
    Uri: {
      joinPath(uri, ...segments) {
        return vscodeUri(path.join(uri.fsPath, ...segments));
      },
    },
    workspace: {
      workspaceFolders: workspaceFolders.map((fsPath) => ({ uri: vscodeUri(fsPath) })),
      fs: {
        async stat(uri) {
          return { type: fs.statSync(uri.fsPath).isFile() ? 1 : 2 };
        },
        async readFile(uri) {
          return fs.readFileSync(uri.fsPath);
        },
      },
    },
  };
}

test("shared webview never loads assets shadowed by a workspace folder", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-webview-assets-"));
  const shadowRoot = path.join(root, "shadow");
  const extensionRoot = path.join(root, "extension");
  const shadowAssets = path.join(shadowRoot, "Utilities", "AgentHub", "assets", "mini-app");
  const extensionAssets = path.join(extensionRoot, "media", "mini-app");
  const required = [
    "app.js", "metropolis-glass.js", "storm-glass.js", "message-lifecycle.js", "hub-client.js",
    "styles.css",
  ];
  try {
    fs.mkdirSync(shadowAssets, { recursive: true });
    fs.mkdirSync(extensionAssets, { recursive: true });
    fs.writeFileSync(path.join(shadowAssets, "index.html"), '<meta charset="utf-8">shadow<script src="/app.js" defer></script>');
    fs.writeFileSync(path.join(extensionAssets, "index.html"), '<meta charset="utf-8">trusted<script src="/app.js" defer></script>');
    for (const file of required) {
      fs.writeFileSync(path.join(shadowAssets, file), "");
      fs.writeFileSync(path.join(extensionAssets, file), "");
    }
    fs.writeFileSync(path.join(shadowRoot, "Utilities", "AgentHub", "work-log.css"), "");
    fs.mkdirSync(path.join(shadowRoot, "Utilities", "AgentHub", "VSCodeExtension"), { recursive: true });
    fs.writeFileSync(path.join(shadowRoot, "Utilities", "AgentHub", "VSCodeExtension", "vscode-bootstrap.js"), "");
    fs.mkdirSync(path.join(extensionRoot, "media"), { recursive: true });
    fs.writeFileSync(path.join(extensionRoot, "media", "work-log.css"), "");
    fs.writeFileSync(path.join(extensionRoot, "vscode-bootstrap.js"), "");
    const { sharedWebviewHtml } = loadSharedWebview(webviewVscode([shadowRoot]));
    const webview = {
      cspSource: "vscode-webview://test",
      asWebviewUri: (uri) => `vscode-webview-resource:${uri.fsPath}`,
    };
    const result = await sharedWebviewHtml(webview, vscodeUri(extensionRoot));
    assert.match(result.html, /trusted/u);
    assert.doesNotMatch(result.html, /shadow/u);
    assert.ok(result.roots.every((uri) => uri.fsPath.startsWith(extensionRoot)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension bundles every shared webview asset", () => {
  const extensionRoot = path.dirname(require.resolve("./package.json"));
  const bundled = [
    ["../assets/mini-app/index.html", "media/mini-app/index.html"],
    ["../assets/mini-app/app.js", "media/mini-app/app.js"],
    ["../assets/mini-app/metropolis-glass.js", "media/mini-app/metropolis-glass.js"],
    ["../assets/mini-app/storm-glass.js", "media/mini-app/storm-glass.js"],
    ["../assets/mini-app/message-lifecycle.js", "media/mini-app/message-lifecycle.js"],
    ["../assets/mini-app/hub-client.js", "media/mini-app/hub-client.js"],
    ["../assets/mini-app/styles.css", "media/mini-app/styles.css"],
    ["../work-log.css", "media/work-log.css"],
    ["../assets/mini-app/pulsar-beams.png", "media/mini-app/pulsar-beams.png"],
    ["../assets/mini-app/blackhole-blue.png", "media/mini-app/blackhole-blue.png"],
    ["../assets/mini-app/rainforest-night.png", "media/mini-app/rainforest-night.png"],
    ["../assets/mini-app/magma-crust.png", "media/mini-app/magma-crust.png"],
    ["../assets/mini-app/metropolis-night.png", "media/mini-app/metropolis-night.png"],
    ["../assets/mini-app/storm-sea.png", "media/mini-app/storm-sea.png"],
    ["../assets/mini-app/storm-flash.png", "media/mini-app/storm-flash.png"],
    ["../assets/mini-app/meadow-sun.png", "media/mini-app/meadow-sun.png"],
    ["../assets/mini-app/lake-summer.jpg", "media/mini-app/lake-summer.jpg"],
    ["../assets/mini-app/orbit-earth.png", "media/mini-app/orbit-earth.png"],
    ["../assets/mini-app/nebula-veil.png", "media/mini-app/nebula-veil.png"],
    ["../assets/mini-app/gothic-concrete.png", "media/mini-app/gothic-concrete.png"],
  ];
  for (const [sourcePath, bundledPath] of bundled) {
    const source = fs.readFileSync(path.join(extensionRoot, sourcePath));
    const bundledAsset = fs.readFileSync(path.join(extensionRoot, bundledPath));
    assert.deepEqual(bundledAsset, source, bundledPath);
  }
  assert.ok(fs.statSync(path.join(extensionRoot, "vscode-bootstrap.js")).isFile());
});

test("missing bundled resources fail closed without workspace-derived fallback", () => {
  const extension = fs.readFileSync(require.resolve("./extension.js"), "utf8");
  assert.match(extension, /this\.sharedPanel = "unavailable"/u);
  assert.match(extension, /Ресурсы Agent Hub повреждены/u);
  assert.doesNotMatch(extension, /catch \(error\) \{\s*panel\.webview\.html = webviewHtml/u);
});

test("webview resource roots exclude every workspace folder", () => {
  const extension = fs.readFileSync(require.resolve("./extension.js"), "utf8");
  assert.match(
    extension,
    /localResourceRoots:\s*\[\s*this\.context\.extensionUri,\s*vscode\.Uri\.file\(/u,
  );
  assert.doesNotMatch(extension, /localResourceRoots:\s*\[[^\]]*workspaceFolders\(/u);
});

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
    webviewHtml({}, "metropolis"),
    /<html lang="ru" data-theme="metropolis" data-surface="desktop">/,
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

test("grouped Claude work keeps the latest turn visible and collapses previous turns", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(app, /function replaceCollapsedTurnList\(list, entries\)/u);
  assert.match(app, /data-work-log-previous-turns-closed/u);
  assert.match(app, /Показать предыдущие ходы/u);
  assert.match(app, /replaceCollapsedTurnList\(list, entries\)/u);
  assert.doesNotMatch(app, /if \(list\) list\.replaceChildren\(\.\.\.entries\)/u);
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
  const shared = fs.readFileSync(require.resolve("./shared-webview.js"), "utf8");
  assert.match(extension, /const THEMES = new Set\(\[[\s\S]*"stormglass"/u);
  assert.match(extension, /PULSAR_IMAGE_PATH/);
  assert.match(extension, /--pulsar-image: url/);
  assert.match(extension, /--bh-image: url/);
  assert.match(extension, /--forest-image: url/);
  assert.match(extension, /--metropolis-image: url/);
  assert.match(extension, /html\[data-theme="metropolis"\]/);
  assert.match(extension, /--magma-image: url/);
  assert.match(shared, /\["--stormglass-image", assets\.stormglass\]/u);
  assert.match(
    shared,
    /<script src="\$\{resource\(webview, assets\.stormGlass\)\}" defer><\/script>/u,
  );
});

test("theme layers keep the background, effects and content in order", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /body::after\s*\{[^}]*z-index:\s*0;/su);
  assert.match(styles, /body::before\s*\{[^}]*pointer-events:\s*none;[^}]*z-index:\s*1;/su);
  assert.match(styles, /\.theme-atmosphere\s*\{[^}]*pointer-events:\s*none;[^}]*z-index:\s*1;/su);
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
    ["blackhole", "blackhole-flicker"],
    ["magma", "magma-glow"],
    ["meadow", "meadow-breathe"],
    ["lake", "lake-shimmer"],
  ]) {
    assert.match(
      styles,
      new RegExp(`html\\[data-theme="${theme}"\\] body::before\\s*\\{[^}]*animation:\\s*${animation}`, "su"),
      `${theme} must keep its own motion`,
    );
  }
  /* Дождь «Тайги» больше не плитка: три попытки сделать его через
     background-repeat читались как текстура — палки, жалюзи, затем ровные
     дорожки. Капли создаёт app.js, у каждой своя длина, толщина, яркость и
     скорость, поэтому регулярности нет. Слой обязан лежать над фоном темы
     (z-index 0) и под рабочей областью (z-index 2). */
  assert.match(
    styles,
    /@keyframes rain-fall\s*\{[\s\S]*translate3d\(-1vw, -18vh, 0\)[\s\S]*translate3d\(3vw, 128vh, 0\)/u,
  );
  assert.match(styles, /\.rain\s*\{[^}]*z-index:\s*1;/u);
  assert.match(styles, /\.rain > span\s*\{[^}]*animation:\s*rain-fall var\(--dur\) linear infinite;/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*\.rain\s*\{[^}]*display:\s*none;/u);
  const client = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(client, /function buildRainDrop\(heavy = false\)/u);
  /* «Storm» берёт тот же слой капель, но плотнее и быстрее: ливень, а не
     дождь тайги. */
  assert.match(client, /stormglass: "downpour"/u);
  assert.match(styles, /@keyframes downpour-fall/u);
  assert.match(client, /prefers-reduced-motion: reduce/u);
  for (const property of ["--x", "--len", "--thickness", "--alpha", "--dur", "--delay"]) {
    assert.ok(client.includes(`"${property}"`), `капля задаёт ${property}`);
  }
  assert.match(styles, /@keyframes magma-glow\s*\{[\s\S]*filter:\s*saturate\(1\.18\) brightness\(1\.14\);/u);
  /* Gothic остаётся тёплым: фон темы — склеп с горящим факелом. Пыль ушла из
     плитки в отдельные элементы, на фоновом слое остался только блик. */
  assert.match(styles, /@keyframes gothic-fire\s*\{[\s\S]*filter:\s*brightness\(1\.22\);/u);
  assert.match(styles, /@keyframes mote-rise\s*\{[\s\S]*translate3d\(0, -106vh, 0\)/u);
  assert.match(styles, /\.motes\s*\{[^}]*z-index:\s*1;/u);
  assert.match(styles, /\.motes > span\s*\{[^}]*animation:\s*mote-rise var\(--dur\) linear infinite;/u);
  assert.match(client, /function buildMote\(\)/u);
  assert.match(
    client,
    /PARTICLE_THEMES = \{ taiga: "rain", stormglass: "downpour", gothic: "motes" \}/u,
  );
  /* Гасить к лунному проёму теперь должен слой пыли, а не блик факела. */
  assert.match(
    styles,
    /\.motes\s*\{[^}]*mask-image:\s*linear-gradient\(90deg,\s*transparent/su,
  );
  /* Пошаговые анимации давали видимую дёрганость, поэтому в живых слоях их
     быть не должно: единственный резкий ритм — «Пульсар», и он linear. */
  const motionBlocks = styles.match(/animation:\s*(?:gothic-fire|magma-glow|orbit-terminator|nebula-drift|meadow-breathe|lake-shimmer|pulsar-beat|blackhole-flicker)[^;]*;/gu) ?? [];
  assert.equal(motionBlocks.length, 8, "живой слой остаётся у восьми тем; «Rain», «Storm» и «Gothic» рисуют частицы");
  for (const block of motionBlocks) {
    assert.doesNotMatch(block, /steps\(/u, `движение должно быть плавным: ${block}`);
  }
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*animation:\s*none !important;/u);
});

test("Rain keeps its stored key and is named consistently", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const webview = fs.readFileSync(require.resolve("./webview.js"), "utf8");
  assert.match(html, /<option value="taiga">Rain<\/option>/u);
  assert.match(webview, /<option value="taiga">Rain<\/option>/u);
});

test("one settings panel owns interface and task controls", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.doesNotMatch(html, /data-panel-open="view"/u);
  assert.ok((html.match(/data-panel-open="settings"/gu) ?? []).length >= 2);
  assert.match(html, /data-token-breakdown-toggle/u);
  assert.match(html, /data-claude-group-toggle/u);
  assert.match(html, /<option value="week">По неделям<\/option>/u);
  assert.match(html, /<option value="month">По месяцам<\/option>/u);
  assert.match(html, /data-usage-unit="rub">₽<\/button>/u);
  assert.match(html, /data-usage-unit="pte"/u);
  assert.match(html, /data-exchange-rate-hint/u);
  assert.match(app, /agent-hub-token-breakdown/u);
  assert.match(app, /agent-hub-group-claude/u);
  assert.match(app, /agent-hub-usage-unit/u);
  assert.match(html, /data-toggle="includeClaudeUsage"/u);
  assert.match(html, /data-trusted-device-list/u);
  assert.match(app, /setTrustedDevices/u);
  assert.match(app, /const CREDITS_PER_USD = 25;/u);
  assert.match(app, /const PTE_PER_CREDIT = 8_000;/u);
  assert.match(app, /const dollars = value \/ CREDITS_PER_USD;/u);
  assert.match(app, /spacedNumber\(dollars, dollars < 1 \? 2 : 1\)/u);
  assert.match(app, /const rubles = \(value \/ CREDITS_PER_USD\) \* usdRubRate;/u);
  assert.match(app, /spacedNumber\(rubles, rubles < 1 \? 2 : 1\)/u);
  assert.match(app, /formatScaledUsage\(value \* PTE_PER_CREDIT, "ПТЭ"\)/u);
  assert.ok(
    app.indexOf("const RANGE_LABELS") < app.indexOf("selectUsageUnit(savedUsageUnit())"),
    "подписи диапазонов должны быть инициализированы до первого рендера единиц расхода",
  );
});

test("the active Agent Hub tab survives a page reload", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(app, /const NAVIGATION_TAB_KEY = "agent-hub-navigation-tab-v1";/u);
  assert.match(app, /localStorage\.getItem\(NAVIGATION_TAB_KEY\)/u);
  assert.match(app, /localStorage\.setItem\(NAVIGATION_TAB_KEY, currentNavigationTab\(\)\)/u);
  assert.match(app, /const initialNavigationTab = storedNavigationTab\(\);/u);
  assert.match(
    app,
    /setView\(initialNavigationTab, \{ persist: false, activate: false \}\)/u,
  );
  assert.match(app, /setPane\(initialNavigationTab, \{ persist: false \}\)/u);
  assert.match(
    app,
    /window\.addEventListener\("DOMContentLoaded", \(\) => activateView\(currentNavigationTab\(\)\)/u,
  );
  assert.doesNotMatch(
    app,
    /renderOptions\(\);\s*setView\("chat"\);\s*setPane\("tasks"\);/u,
  );
});

test("task list keeps active duration live and metadata badges readable", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(client, /startedAt:\s*running\s*\?\s*task\.run\?\.startedAt/u);
  assert.match(app, /function formatRunningDuration\(/u);
  assert.match(app, /data-task-started-at/u);
  assert.match(app, /setInterval\(refreshTaskDurations,\s*1_000\)/u);
  assert.match(styles, /\.task-agent\s*\{[^}]*flex:\s*0 0 auto;/su);
  assert.match(styles, /\.task-runtime\s*\{[^}]*background:\s*var\(--accent-soft\);[^}]*color:\s*var\(--accent\);/su);
});

test("Metropolis uses a fogged-glass WebGL plane with refracted moving drops", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  const glass = fs.readFileSync(require.resolve("../assets/mini-app/metropolis-glass.js"), "utf8");
  assert.match(html, /<option value="metropolis">Мегаполис<\/option>/u);
  assert.match(html, /<canvas data-metropolis-glass><\/canvas>/u);
  assert.match(html, /<script src="\/metropolis-glass\.js" defer><\/script>/u);
  assert.match(styles, /html\[data-theme="metropolis"\] body::after\s*\{[\s\S]*var\(--metropolis-image\)/u);
  assert.match(styles, /backdrop-filter:\s*blur\(6px\) saturate\(68%\) brightness\(0\.82\)/u);
  assert.match(glass, /vec4 rainLayer\(/u);
  assert.match(glass, /float drop = smoothstep\(0\.03,\s*0\.02/u);
  assert.match(glass, /float clearTrail = smoothstep\(-0\.05,\s*0\.05/u);
  assert.match(glass, /uViewport\.x \/ max\(uViewport\.y,\s*1\.0\)/u);
  assert.match(glass, /vec2 refraction = drop \* dropPosition/u);
  assert.match(glass, /vec2 refractedUv = imageUv \+ drops\.xy \* 1\.65/u);
  assert.match(glass, /uniform sampler2D uFogImage/u);
  assert.match(glass, /vec4 fogged = texture2D\(uFogImage,\s*imageUv\)/u);
  assert.match(glass, /function createFogTexture\(image\)/u);
  assert.match(glass, /filter: "blur\(4px\) saturate\(82%\) brightness\(88%\)"/u);
  assert.doesNotMatch(glass, /for \(int index = 0; index < 32/u);
  assert.doesNotMatch(glass, /condensation|glassHighlight/u);
  assert.match(glass, /prefers-reduced-motion: reduce/u);
});

test("Storm keeps the photo backdrop and adds only lightning", () => {
  const shader = fs.readFileSync(require.resolve("../assets/mini-app/metropolis-glass.js"), "utf8");
  const storm = fs.readFileSync(require.resolve("../assets/mini-app/storm-glass.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  /* Стекло с каплями уместно там, где за ним огни: на ночном море оно
     читалось мутью, поэтому «Storm» обходится фоном и грозой. */
  assert.doesNotMatch(shader, /stormglass/u);
  assert.match(styles, /html\[data-theme="stormglass"\] \.theme-atmosphere \[data-metropolis-glass\]/u);
  assert.match(styles, /html\[data-theme="stormglass"\] body::after\s*\{[\s\S]*?var\(--stormglass-image\)/u);

  /* Оживает сама сцена: вода дышит по маске горизонта, небо медленно плывёт,
     а разряд подсвечивает кадр вторым снимком той же сцены. */
  assert.match(styles, /--stormglass-flash: url\("\/storm-flash\.png"\)/u);
  assert.match(storm, /uniform sampler2D uFlash/u);
  assert.match(storm, /uniform float uHorizon/u);
  assert.match(storm, /const HORIZON = 0\.6/u);
  assert.match(storm, /mix\(calm, lit, clamp\(uStrike, 0\.0, 1\.0\)\)/u);
  assert.match(storm, /float water = pow\(depth, 1\.35\)/u);
  // канал молнии готовится в буфер один раз за удар и уходит текстурой
  assert.match(storm, /function drawBolt\(\)/u);
  assert.match(storm, /uniform sampler2D uBolt/u);
  assert.match(storm, /nextLightningAt = now \+ random\(9_000,\s*24_000\)/u);
  // канал гаснет вместе со вспышкой, иначе висит на экране до следующего удара
  assert.match(storm, /bolt\.rgb \* bolt\.a \* clamp\(uStrike/u);
  assert.doesNotMatch(storm, /spawnDrop|dropPath|trackTrail|function lens\(/u);
  assert.doesNotMatch(styles, /stormglass-bolt|data-storm-strike/u);
  assert.match(storm, /prefers-reduced-motion: reduce/u);
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

test("task-grouped journal pages large histories without per-row Metropolis blur", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(app, /const TASK_GROUP_TURN_PAGE_SIZE = 30/u);
  assert.match(app, /const taskGroupTurns = new WeakMap\(\)/u);
  assert.match(app, /function appendTaskGroupTurnPage\(details, \{ nextPage = false \} = \{\}\)/u);
  assert.match(app, /Показать ещё \(\$\{turns\.length - next\}\)/u);
  assert.match(app, /details\[data-work-log-task-group\]\[open\][\s\S]*appendTaskGroupTurnPage/u);
  assert.match(
    styles,
    /html\[data-theme="metropolis"\]\[data-grouping="task"\][\s\S]*details\[data-work-log-turn-details\][\s\S]*backdrop-filter:\s*none/u,
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

test("chat refreshes selected external runs without moving the reader", () => {
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(client, /const EXTERNAL_HISTORY_REFRESH_MS = 2_500/u);
  assert.match(client, /const externalLive = sameSelection[\s\S]*currentSelected\.running[\s\S]*executionOwner/u);
  assert.match(client, /refreshExternalHistory[\s\S]*control\("open-task"[\s\S]*preserveScroll: true/u);
  assert.match(client, /const answerChanged = sameSelection/u);
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

test("dispatching deferred messages leave the queue and reappear in the active conversation", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(app, /\.filter\(\(entry\) => entry\.state !== "dispatching"\)/u);
  assert.match(app, /Date\.parse\(left\.createdAt \|\| 0\)/u);
  assert.match(client, /\.filter\(\(item\) => item\.state !== "dispatching"\)/u);
  assert.match(client, /deferred\.state === "dispatching"\s*\?\s*"sending"/u);
  assert.match(client, /item\.state !== "dispatching"/u);
});

test("message attachments keep timestamps, thumbnails and an explicit open action", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const extension = fs.readFileSync(require.resolve("./extension.js"), "utf8");
  assert.match(client, /time:\s*message\.time \?\?/u);
  assert.match(client, /attachments:\s*attachmentViews\(message\.attachments\)/u);
  assert.match(client, /agentHub\.on\("attachment:open"/u);
  assert.match(app, /emit\("attachment:open",\s*\{\s*attachment:\s*item\s*\}\)/u);
  assert.match(extension, /decorateAttachmentUrls/u);
  assert.match(extension, /action === "open-attachment"/u);
  assert.match(app, /Файл изображения недоступен/u);
  assert.match(app, /disabled:\s*missing/u);
  assert.match(app, /\(!source && !item\.id\)/u);
  assert.match(client, /control\("open-attachment", \{ id \}\)/u);
  assert.match(client, /agentHub\.openAttachmentViewer/u);
  assert.doesNotMatch(client, /window\.open\(url, "_blank"/u);
});

test("mobile navigation backs out from image to chat and from chat to tasks", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const android = fs.readFileSync(
    require.resolve("../AndroidApp/app/src/main/java/app/agenthub/mobile/MainActivity.java"),
    "utf8",
  );
  assert.match(html, /data-attachment-viewer[\s\S]*data-attachment-viewer-close/u);
  assert.match(app, /function navigateBack\(\)[\s\S]*closeAttachmentViewer\(\)[\s\S]*setPane\("tasks"\)/u);
  assert.match(app, /dx < 72[\s\S]*attachmentViewerOpen[\s\S]*setPane\("tasks"\)/u);
  assert.match(android, /window\.AgentHub\.navigateBack/u);
});

test("annotation button clearly quotes selected agent text", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(html, /data-action="annotate"[\s\S]*Цитировать выделенный текст ответа/u);
  assert.match(html, /data-phosphor-icon="quotes"/u);
  assert.match(app, /showToast\("Выделите фрагмент ответа агента\."\)/u);
  assert.match(html, /data-action="annotate"[\s\S]*aria-disabled="true"/u);
});

test("composer send and desktop settings stay pinned to the right edge", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/mini-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /\.toolbar \.view-settings\s*\{[^}]*margin-left:\s*auto;/su);
  assert.match(
    styles,
    /html\[data-surface="mobile"\] \.composer-send\s*\{[^}]*grid-column:\s*-2 \/ -1;[^}]*justify-self:\s*end;/su,
  );
});

test("Telegram mobile chat disables the host vertical collapse gesture", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.match(app, /telegram\?\.expand\(\);\s*telegram\?\.disableVerticalSwipes\?\.\(\);/u);
});

test("chat loads older pages from a button and a cancellable mobile pull gesture", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(html, /data-history-loader[\s\S]*data-history-load/u);
  assert.match(app, /const HISTORY_PULL_THRESHOLD = 84;/u);
  assert.match(app, /touchmove[\s\S]*historyPull\.armed = damped >= HISTORY_PULL_THRESHOLD/u);
  assert.match(app, /touchend[\s\S]*if \(shouldLoad\) requestOlderHistory\(\)/u);
  assert.match(app, /emit\("history:load-older", \{ taskId: state\.selectedId \}\)/u);
  assert.match(app, /function captureChatAnchor\(\)[\s\S]*function restoreChatAnchor\(anchor\)/u);
  assert.match(client, /control\("task-history", \{[\s\S]*before: page\.nextBefore,[\s\S]*limit: 20/u);
  assert.match(client, /prependOlderHistory[\s\S]*preserveScroll: true/u);
  assert.match(styles, /html\[data-surface="mobile"\] \.chat-history-loader\[data-pulling\]/u);
});

test("chat keeps an active response only in the live card after task switching", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const lifecycle = fs.readFileSync(require.resolve("../assets/mini-app/message-lifecycle.js"), "utf8");
  assert.match(
    lifecycle,
    /function visibleConversationMessages\(messages,[\s\S]*const liveTurnRole = identityKey\(liveProbe, \{ withoutItem: true \}\);[\s\S]*identityKey\(message, \{ withoutItem: true \}\) !== liveTurnRole/u,
  );
  assert.match(client, /liveProbeByTask\.set\(taskIdValue, nextProbe\)/u);
  assert.match(client, /liveProbe: liveProbeByTask\.get\(taskIdValue\) \?\? null/u);
  assert.match(client, /text: response/u);
  assert.match(app, /function liveTextAfterMessages\(live\) \{\s*return normalizedMessageText\(live\?\.text\);\s*\}/u);
  assert.match(app, /!normalizedMessageText\(live\.stage\)/u);
  assert.match(
    app,
    /setMessages\(taskId, messages\)[\s\S]*renderMessages\(\{ forceBottom: true \}\);\s*renderLive\(\);/u,
  );
});

test("unfinished commentary never becomes a normal historical answer card", () => {
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(
    client,
    /const visibleAgent = item\.completed[\s\S]*\?\s*agentMessages\.findLast[\s\S]*:\s*null;/u,
  );
  assert.match(client, /item\.completed && item\.answer/u);
});

test("manual context compaction reports completion and stays on the fast refresh loop", () => {
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(client, /requestedContextCompactions/u);
  assert.match(client, /Свёртка контекста завершена/u);
  assert.match(client, /Началась автосвёртка контекста/u);
  assert.match(client, /compactionContextLabel\(context\)/u);
  assert.match(client, /task\.running \|\| task\.context\?\.compacting/u);
  assert.match(app, /context\.compacting \? "↻" : context\.usagePending \? "…"/u);
  assert.match(app, /toggleAttribute\("data-compacting"/u);
  assert.match(styles, /context-compaction-spin/u);
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

test("shared chat Markdown renders GFM tables responsively", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(app, /function markdownTableCells\(line\)/u);
  assert.match(app, /\^:\?-\{3,\}:\?\$/u);
  assert.match(app, /renderMarkdownTable\(table\)/u);
  assert.match(app, /el\("table", \{ class: "markdown-table" \}/u);
  assert.match(styles, /\.markdown-table-scroll[\s\S]*overflow-x: auto;/u);
  assert.match(styles, /\.markdown-table[\s\S]*border-collapse: collapse;/u);
});

test("deferred messages show their preview and can be queued after the active turn", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const lifecycle = fs.readFileSync(require.resolve("../assets/mini-app/message-lifecycle.js"), "utf8");
  assert.match(app, /entry\.text \|\| entry\.preview \|\| entry\.summary/u);
  assert.match(app, /text: "После хода"/u);
  assert.match(client, /control\("deferred-input", \{ id, action: "queue" \}\)/u);
  assert.match(client, /deferredClientUserMessageIds = new Set\(/u);
  assert.match(
    lifecycle,
    /message\?\.role === "user"[\s\S]*deferredIds\.has\(String\(message\?\.clientUserMessageId/u,
  );
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
  assert.match(client, /reusableAttachmentPaths\([\s\S]*\{ remote: !vscode \}/u);
  assert.match(client, /if \(isConnectionFailure\(error\)\) applySnapshotConnection/u);
  assert.match(client, /deliveryPatch\(isConnectionFailure\(error\) \? "unconfirmed" : "rejected"\)/u);
  assert.match(client, /snapshot\?\.restartWaiting == null && blockingCount > 0/u);
  assert.match(client, /waiting \? "restart-waiting" : snapshot\?\.restartPending \? "restarting" : idleStatus/u);
  assert.match(html, /data-restart-banner/u);
  assert.match(app, /Agent Hub ожидает завершения активных задач: \$\{blockingCount\}\./u);
  assert.match(app, /restarting: "Agent Hub перезапускается…"/u);
  assert.match(app, /offline: "Нет связи с Agent Hub\."/u);
  assert.doesNotMatch(
    app,
    /Текст в поле ввода сохранён|Непринятый текст будет восстановлен|Неотправленное сообщение сохранено/u,
  );
});

test("chat retries an initial history load after the connection recovers", () => {
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(client, /selectedHistoryMissing/u);
  assert.match(client, /selectedHistoryMissing[\s\S]*control\("open-task"/u);
});

test("current limits live in settings and statistics instead of the compact header", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  assert.doesNotMatch(html, /data-rate-limits-slot/u);
  assert.equal(html.match(/data-current-limits=/gu)?.length, 2);
  assert.match(html, /data-current-limits="statistics"/u);
  assert.match(html, /data-current-limits="settings"/u);
  assert.match(app, /function currentLimitSeries\(payload\)/u);
  assert.match(app, /pickCodex\("codex"\)/u);
  assert.match(app, /pickCodex\("spark"\)/u);
  assert.match(app, /id === "claude:week"/u);
  assert.match(app, /journal\.querySelector\("\[data-work-log-rate-limits\]"\)\?\.remove\(\)/u);
});

test("statistics page offers local usage and full limit history", () => {
  const html = fs.readFileSync(require.resolve("../assets/mini-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(html, /data-view-button="statistics"/u);
  assert.match(html, /data-usage-chart/u);
  assert.match(html, /data-limits-chart/u);
  for (const range of ["6h", "24h", "7d", "30d", "all"]) {
    assert.match(html, new RegExp(`data-range="${range}"`, "u"));
  }
  assert.match(app, /const RANGE_SEQUENCE = \["6h", "24h", "7d", "30d", "all"\];/u);
  assert.match(html, /data-limits-credits/u);
  assert.match(app, /resetCredits/u);
  assert.match(app, /availableCount/u);
  assert.match(app, /nearestExpiresAt/u);
  assert.match(app, /emit\("usage:open", \{ range: usageState\.range \}\)/u);
  assert.match(app, /function formatUsageValue\(credits, unit = usageUnit\)/u);
  assert.match(client, /control\("usage-history", \{\s*range,\s*maxPoints: 600,/u);
  assert.match(styles, /\.current-limits-row\s*\{[^}]*flex-wrap:\s*nowrap;/su);
  assert.match(styles, /\.current-limits-row\s*\{[^}]*overflow-x:\s*auto;/su);
});

test("local usage chart keeps its range and labels every calendar day", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(app, /agent-hub:usage-range:v1/u);
  assert.match(app, /localStorage\.setItem\(USAGE_RANGE_KEY, usageState\.range\)/u);
  assert.match(app, /payload\?\.bucket === "day"/u);
  assert.match(app, /usage-axis-day/u);
  assert.match(styles, /\.usage-chart\s*\{[^}]*overflow-x:\s*auto;/su);
});

test("history dialog requests periods via limits:open and renders via setRateLimitHistory", () => {
  const app = fs.readFileSync(require.resolve("../assets/mini-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/mini-app/hub-client.js"), "utf8");
  assert.match(app, /setRateLimitHistory\(payload\) \{\s*applyRateLimitHistory\(payload\);/u);
  assert.match(app, /emit\("limits:open", \{ range: limitsState\.range \}\)/u);
  assert.match(client, /agentHub\.on\("limits:open", \(\{ range \}\) =>/u);
  assert.match(client, /control\("rate-limit-history", \{\s*range: requestedRange,\s*maxPointsPerSeries: 600,/u);
  assert.match(client, /agentHub\.setRateLimitHistory\(\{/u);
  assert.match(client, /window\.setInterval\(\(\) => \{[\s\S]*refreshRateLimitHistory\(\);[\s\S]*5 \* 60_000/u);
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
  const styles = fs.readFileSync(require.resolve("../assets/mini-app/styles.css"), "utf8");
  assert.match(html, /data-limits-chart role="img"/u);
  assert.match(app, /document\.createElementNS\(SVG_NS, tag\)/u);
  assert.match(app, /function buildLimitsChart\(payload\)/u);
  // никакого canvas, изображений или удалённых источников в графике
  assert.doesNotMatch(app, /createElement\(["']canvas/u);
  assert.doesNotMatch(app, /getContext\(/u);
  assert.doesNotMatch(app, /new Image\(/u);
  assert.match(app, /y: yOf\(point\.usedPercent\)/u);
  assert.match(app, /function limitsMarkerPoints\(points, minimumSpacing = 11\)/u);
  assert.match(app, /const markerPoints = limitsMarkerPoints\(points\)/u);
  assert.match(
    styles,
    /details\[data-work-log-task-group\]:not\(\[open\]\)\s*>\s*:not\(summary\)\s*\{\s*display:\s*none\s*!important;/u,
  );
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

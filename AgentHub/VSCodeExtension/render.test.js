"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { renderWorkLog, sanitizeWorkLogHtml } = require("./render.js");
const { webviewHtml } = require("./webview.js");
const { loadThemeRegistry } = require("../theme-registry.cjs");

const WEB_APP_ROOT = path.resolve(__dirname, "..", "assets", "web-app");
const THEME_REGISTRY = loadThemeRegistry(WEB_APP_ROOT);
const THEMES = THEME_REGISTRY.themes.map((theme) => theme.id);
const WEBVIEW_THEMES = THEME_REGISTRY.themes.map(({ id, name }) => ({ id, name }));

function themeFile(theme, file = "theme.css") {
  return fs.readFileSync(path.join(WEB_APP_ROOT, "themes", theme, file), "utf8");
}

function allStyles() {
  return [
    fs.readFileSync(path.join(WEB_APP_ROOT, "styles.css"), "utf8"),
    ...THEMES.map((theme) => themeFile(theme)),
  ].join("\n");
}

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

function loadExtension(vscode) {
  const Module = require("node:module");
  const modulePath = require.resolve("./extension.js");
  const originalLoad = Module._load;
  delete require.cache[modulePath];
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function loadJournalView() {
  const source = fs.readFileSync(path.join(WEB_APP_ROOT, "journal-view-controller.js"), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubJournalView;
}

function loadVscodeBootstrap({ animations = [], hidden = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, "vscode-bootstrap.js"), "utf8");
  const listeners = new Map();
  const documentListeners = new Map();
  const messages = [];
  const timeoutDelays = [];
  const animationFrames = [];
  let mutationCallback = null;
  let nativeFetchCalls = 0;
  const trackedSetTimeout = (callback, delay) => {
    timeoutDelays.push(delay);
    return setTimeout(callback, delay);
  };
  const window = {
    location: { href: "https://agent-hub.vscode-webview.test/" },
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    fetch: async () => {
      nativeFetchCalls += 1;
      return new Response("native");
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    requestAnimationFrame: (callback) => {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    clearTimeout,
    setTimeout: trackedSetTimeout,
  };
  const document = {
    body: {},
    hidden,
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    getAnimations: () => animations,
  };
  class MutationObserver {
    constructor(callback) { mutationCallback = callback; }
    observe() {}
    disconnect() {}
  }
  vm.runInNewContext(source, {
    AbortController,
    Headers,
    MutationObserver,
    Response,
    URL,
    clearTimeout,
    document,
    setTimeout: trackedSetTimeout,
    window,
  });
  return {
    animationFrames,
    documentListeners,
    listeners,
    messages,
    mutationCallback: (records) => mutationCallback(records),
    nativeFetchCalls: () => nativeFetchCalls,
    timeoutDelays,
    window,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function providerContext() {
  return {
    extensionUri: { fsPath: "D:/extension" },
    globalState: { get: () => "orbit", update: async () => {} },
    subscriptions: [],
  };
}

function panelHarness() {
  const handlers = {};
  const messages = [];
  return {
    handlers,
    messages,
    panel: {
      title: "",
      webview: {
        onDidReceiveMessage(handler) { handlers.message = handler; },
        postMessage: async (message) => { messages.push(message); },
      },
      onDidDispose(handler) { handlers.dispose = handler; },
      onDidChangeViewState(handler) { handlers.viewState = handler; },
    },
  };
}

test("file targets separate line and column from Windows paths", () => {
  const { editorFileTarget } = loadExtension({ FileType: { File: 1 } });
  assert.deepEqual(editorFileTarget("D:/work/extension.js:23"), {
    file: "D:/work/extension.js",
    line: 23,
    column: 0,
  });
  assert.deepEqual(editorFileTarget("D:/work/extension.js:23:7"), {
    file: "D:/work/extension.js",
    line: 23,
    column: 7,
  });
});

test("VS Code bootstrap routes runtime health through the extension bridge", async () => {
  const harness = loadVscodeBootstrap();
  const responsePromise = harness.window.fetch("/health", { cache: "no-store" });
  await Promise.resolve();
  assert.equal(harness.nativeFetchCalls(), 0);
  assert.equal(harness.messages.length, 2);
  assert.equal(harness.messages[0].type, "agenthub:session");
  assert.equal(harness.messages[1].type, "agenthub:control");
  assert.equal(harness.messages[1].action, "runtime-health");
  assert.ok(harness.timeoutDelays.some((delay) => delay > 10_000));
  harness.listeners.get("message")({
    data: {
      type: "agenthub:control-result",
      id: harness.messages[1].id,
      ok: true,
      result: { ready: false, startup: { operations: [] } },
    },
  });
  assert.equal((await responsePromise).status, 200);
});

test("VS Code direct transport waits for the in-flight local session", async () => {
  const harness = loadVscodeBootstrap();
  assert.equal(harness.window.__agentHubDirectTransport.ready(), false);
  assert.equal(harness.window.__agentHubDirectTransport.warmup(), undefined);
  let settled = false;
  const available = harness.window.__agentHubDirectTransport.available().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].type, "agenthub:session");

  harness.listeners.get("message")({
    data: {
      type: "agenthub:session-result",
      id: harness.messages[0].id,
      ok: true,
      result: {
        baseUrl: "http://127.0.0.1:8787",
        token: "temporary-webview-token",
        expiresAt: Date.now() + 300_000,
      },
    },
  });
  assert.equal(await available, true);
  assert.equal(await harness.window.__agentHubDirectTransport.available(), true);
  assert.equal(harness.window.__agentHubDirectTransport.ready(), true);
  assert.equal(harness.nativeFetchCalls(), 0);
  const nativeFetchCalls = harness.nativeFetchCalls();
  const healthResponse = harness.window.__agentHubIpcRuntimeHealth();
  await Promise.resolve();
  const healthMessage = harness.messages.at(-1);
  assert.equal(healthMessage.type, "agenthub:control");
  assert.equal(healthMessage.action, "runtime-health");
  assert.equal(harness.nativeFetchCalls(), nativeFetchCalls);
  harness.listeners.get("message")({
    data: {
      type: "agenthub:control-result",
      id: healthMessage.id,
      ok: true,
      result: { ready: true },
    },
  });
  assert.equal((await healthResponse).status, 200);
  harness.listeners.get("pagehide")();
});

test("file target lookup rejects missing candidates", async () => {
  const vscode = {
    FileType: { File: 1 },
    workspace: {
      fs: {
        stat: async () => { throw new Error("missing"); },
      },
    },
  };
  const { firstExisting } = loadExtension(vscode);
  assert.equal(await firstExisting([{ fsPath: "D:/missing.js" }]), null);
});

test("absolute file links keep their real location outside the open Workspace", async () => {
  const vscode = {
    FileType: { File: 1 },
    Uri: { file: (fsPath) => ({ fsPath }) },
    workspace: {
      fs: {
        stat: async (uri) => {
          if (uri.fsPath.replaceAll("\\", "/") === "D:/other/repo/file.js") {
            return { type: 1 };
          }
          throw new Error("missing");
        },
      },
    },
  };
  const { resolveFileLink } = loadExtension(vscode);
  const result = await resolveFileLink(
    "D:/other/repo/file.js:42",
    [{ uri: { fsPath: "D:/work" } }],
  );
  assert.equal(result.fsPath.replaceAll("\\", "/"), "D:/other/repo/file.js");
});

test("stale workspace-rooted paths resolve by one exact path suffix", async () => {
  const found = { fsPath: "D:/work/Utilities/AgentHub/VSCodeExtension/extension.js" };
  const vscode = {
    FileType: { File: 1 },
    Uri: { file: (fsPath) => ({ fsPath }) },
    RelativePattern: class RelativePattern {
      constructor(folder, pattern) {
        this.folder = folder;
        this.pattern = pattern;
      }
    },
    workspace: {
      fs: {
        stat: async () => { throw new Error("missing"); },
      },
      findFiles: async (pattern) => {
        assert.equal(pattern.pattern, "**/extension.js");
        return [found];
      },
    },
  };
  const { resolveAbsoluteWorkspaceFile } = loadExtension(vscode);
  const folder = { uri: { fsPath: "D:/work" } };
  assert.equal(
    await resolveAbsoluteWorkspaceFile("D:/work/VSCodeExtension/extension.js", [folder]),
    found,
  );
});

function vscodeUri(fsPath) {
  return { fsPath };
}

function webviewVscode(workspaceFolders) {
  return {
    FileType: { File: 1 },
    Uri: {
      file(fsPath) {
        return vscodeUri(fsPath);
      },
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

test("shared webview loads the active runtime, never a workspace shadow", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-webview-assets-"));
  const shadowRoot = path.join(root, "shadow");
  const extensionRoot = path.join(root, "extension");
  const runtimeRoot = path.join(root, "runtime", "releases", "current");
  const shadowAssets = path.join(shadowRoot, "Utilities", "AgentHub", "assets", "web-app");
  const runtimeAssets = path.join(runtimeRoot, "assets", "web-app");
  const required = ["messages/disclosure.js", "message-view-controller.js", "chat-scroll-controller.js", "chat-surface-preference.js", "navigation-tabs-controller.js", "stream-tabs-controller.js", "approval-form.js", "runtime-reload-controller.js", "journal-view-controller.js", "statistics-controls.js", "attachments/interactions.js", "future-runtime-module.js", "rate-limit-series.js", "task-board.js", "app.js", "messages/lifecycle.js", "messages/send-transaction.js", "hub-client.js", "styles.css", "backgrounds.css", "stream-status.css", "stream-status-visibility.mjs", "agent-hub-mark.png"];
  try {
    fs.mkdirSync(shadowAssets, { recursive: true });
    fs.mkdirSync(runtimeAssets, { recursive: true });
    fs.writeFileSync(path.join(shadowAssets, "index.html"), '<meta charset="utf-8">shadow<script src="/app.js" defer></script>');
    fs.writeFileSync(path.join(runtimeAssets, "index.html"), `<meta charset="utf-8">runtime
      <link rel="icon" href="/agent-hub-mark.png"><link rel="stylesheet" href="/work-log.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/backgrounds.css">
      <img data-app-mark src="/agent-hub-mark.png" alt="">
      <!-- agent-hub-theme-styles --><select data-theme-select></select>
      <!-- agent-hub-theme-markup --><!-- agent-hub-theme-catalog -->
      <script src="/browser-device-auth.js" defer></script><script src="/messages/disclosure.js" defer></script><script src="/message-view-controller.js" defer></script><script src="/chat-scroll-controller.js" defer></script><script src="/chat-surface-preference.js" defer></script><script src="/navigation-tabs-controller.js" defer></script><script src="/stream-tabs-controller.js" defer></script><script src="/approval-form.js" defer></script><script src="/runtime-reload-controller.js" defer></script><script src="/journal-view-controller.js" defer></script><script src="/statistics-controls.js" defer></script><script src="/attachments/interactions.js" defer></script><script src="/future-runtime-module.js" defer></script><script src="/rate-limit-series.js" defer></script><script src="/task-board.js" defer></script>
      <script src="/app.js" defer></script><!-- agent-hub-theme-scripts -->
      <script src="/messages/lifecycle.js" defer></script><script src="/messages/send-transaction.js" defer></script><script src="/hub-client.js" defer></script>`);
    for (const file of required) {
      fs.mkdirSync(path.dirname(path.join(shadowAssets, file)), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(runtimeAssets, file)), { recursive: true });
      fs.writeFileSync(path.join(shadowAssets, file), "");
      fs.writeFileSync(path.join(runtimeAssets, file), "");
    }
    fs.cpSync(path.join(WEB_APP_ROOT, "themes"), path.join(runtimeAssets, "themes"), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "..", "theme-registry.cjs"), path.join(runtimeRoot, "theme-registry.cjs"));
    fs.copyFileSync(path.resolve(__dirname, "..", "client-assets.cjs"), path.join(runtimeRoot, "client-assets.cjs"));
    fs.writeFileSync(path.join(shadowRoot, "Utilities", "AgentHub", "work-log.css"), "");
    fs.writeFileSync(path.join(runtimeRoot, "work-log.css"), "");
    fs.mkdirSync(extensionRoot, { recursive: true });
    fs.writeFileSync(path.join(extensionRoot, "vscode-bootstrap.js"), "");
    const { markTestContourDocument, sharedWebviewHtml } = loadSharedWebview(webviewVscode([shadowRoot]));
    const webview = {
      cspSource: "vscode-webview://test",
      asWebviewUri: (uri) => `vscode-webview-resource:${uri.fsPath}`,
    };
    const result = await sharedWebviewHtml(webview, {
      runtimeUri: vscodeUri(runtimeRoot),
      extensionUri: vscodeUri(extensionRoot),
    });
    assert.match(result.html, /runtime/u);
    assert.equal(result.html.includes(shadowRoot), false);
    assert.match(result.html, /vscode-webview-resource:.*agent-hub-mark\.png/u);
    assert.doesNotMatch(result.html, /(?:href|src)="\/agent-hub-mark\.png"/u);
    assert.match(result.html, /vscode-webview-resource:.*task-board\.js/u);
    assert.doesNotMatch(result.html, /src="\/task-board\.js"/u);
    assert.match(result.html, /vscode-webview-resource:.*journal-view-controller\.js/u);
    assert.doesNotMatch(result.html, /src="\/journal-view-controller\.js"/u);
    assert.match(result.html, /vscode-webview-resource:.*chat-surface-preference\.js/u);
    assert.doesNotMatch(result.html, /src="\/chat-surface-preference\.js"/u);
    assert.match(result.html, /vscode-webview-resource:.*attachments[\\/]interactions\.js/u);
    assert.doesNotMatch(result.html, /src="\/attachments\/interactions\.js"/u);
    assert.match(result.html, /vscode-webview-resource:.*future-runtime-module\.js/u);
    assert.doesNotMatch(result.html, /src="\/future-runtime-module\.js"/u);
    assert.match(result.html, /<style data-agent-hub-theme="pulsar" nonce="[^"]+">/u);
    assert.match(result.html, /url\("vscode-webview-resource:.*themes[\\/]pulsar[\\/]pulsar-beams\.jpg"\)/u);
    assert.doesNotMatch(result.html, /url\(["']?\.\/pulsar-beams\.jpg/u);
    assert.match(result.html, /style-src vscode-webview:\/\/test 'nonce-[^']+'/u);
    assert.doesNotMatch(result.html, /browser-device-auth\.js/u);
    assert.ok(result.roots.every((uri) => (
      uri.fsPath.startsWith(runtimeRoot) || uri.fsPath.startsWith(extensionRoot)
    )));
    const marked = markTestContourDocument('<html><head></head><body><main>Hub</main></body></html>');
    assert.match(marked, /<html data-test-contour="">/u);
    assert.match(marked, /href="\/test-contour-watermark\.css"/u);
    assert.match(marked, /<div class="test-contour-watermark" aria-hidden="true">ТЕСТ<\/div>/u);
    assert.equal(markTestContourDocument(marked), marked);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("extension keeps its shell synchronized with the active runtime", () => {
  const extension = fs.readFileSync(require.resolve("./extension.js"), "utf8");
  const shared = fs.readFileSync(require.resolve("./shared-webview.js"), "utf8");
  assert.match(shared, /rewriteRuntimeAssetReferences/u);
  assert.match(extension, /refreshPanelShellIfReleaseChanged/u);
  assert.match(extension, /agenthub:runtime-changed/u);
  assert.match(extension, /subscribeRuntime/u);
  assert.match(
    extension,
    /async refresh\(force = false\)[\s\S]*await this\.refreshPanelShellIfReleaseChanged\(\)/u,
  );
  assert.match(extension, /runtimeUri,\s*\n\s*extensionUri: this\.context\.extensionUri/u);
  assert.doesNotMatch(shared, /media", "mini-app/u);
});

test("VS Code ignores rendering and HTTP results for a disposed panel", async () => {
  const harness = panelHarness();
  const vscode = {
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => harness.panel },
  };
  const { WorkLogViewProvider } = loadExtension(vscode);
  const provider = new WorkLogViewProvider(providerContext());
  const rendering = deferred();
  provider.renderPanelShell = () => rendering.promise;
  provider.scheduleRefresh = () => assert.fail("disposed panel must not schedule a refresh");

  const opening = provider.openPanel();
  harness.handlers.dispose();
  rendering.resolve();
  await opening;
  assert.equal(provider.panel, null);
  assert.equal(provider.sharedPanel, false);

  const response = deferred();
  provider.bridge = { http: () => response.promise };
  const formerPanel = harness.panel;
  const pendingResponse = provider.handleHttpMessage({ id: "request" }, formerPanel);
  response.resolve({ status: 200, headers: {}, body: "ok" });
  await pendingResponse;
  assert.deepEqual(harness.messages, []);
});

test("VS Code forces a retained journal refresh when its panel becomes visible", async () => {
  const harness = panelHarness();
  const vscode = {
    ViewColumn: { Active: 1 },
    window: { createWebviewPanel: () => harness.panel },
  };
  const { WorkLogViewProvider } = loadExtension(vscode);
  const provider = new WorkLogViewProvider(providerContext());
  const refreshes = [];
  provider.renderPanelShell = async () => {};
  provider.scheduleRefresh = (...args) => { refreshes.push(args); };

  await provider.openPanel();
  refreshes.length = 0;
  harness.handlers.viewState({ webviewPanel: { visible: false } });
  harness.handlers.viewState({ webviewPanel: { visible: true } });
  assert.deepEqual(refreshes, [[0, true]]);
});

test("manual journal refresh queues one forced announced request behind an active load", async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const refresh = loadJournalView().createQueuedJournalRefresh((options) => {
    calls.push(options);
    return calls.length === 1 ? first.promise : second.promise;
  });

  const active = refresh.refresh();
  const forced = refresh.refresh({ force: true, announce: true });
  assert.notEqual(forced, active);
  let forcedResolved = false;
  void forced.then(() => { forcedResolved = true; });
  first.resolve(true);
  await active;
  await Promise.resolve();
  assert.equal(forcedResolved, false);
  assert.deepEqual(calls.map(({ force, announce }) => [force, announce]), [
    [false, false],
    [true, true],
  ]);
  second.resolve(true);
  await forced;
});

test("VS Code resumes paused theme animations after WebView load", () => {
  let infinitePlayCalls = 0;
  let finitePlayCalls = 0;
  const harness = loadVscodeBootstrap({
    animations: [
      {
        effect: { getTiming: () => ({ iterations: Infinity }) },
        playState: "paused",
        play: () => { infinitePlayCalls += 1; },
      },
      {
        effect: { getTiming: () => ({ iterations: 1 }) },
        playState: "paused",
        play: () => { finitePlayCalls += 1; },
      },
    ],
  });

  assert.equal(infinitePlayCalls, 0);
  harness.listeners.get("load")();
  assert.equal(infinitePlayCalls, 1);
  assert.equal(finitePlayCalls, 1);
});

test("VS Code resumes animations created after asynchronous Stream rendering", () => {
  let playCalls = 0;
  const animations = [];
  const harness = loadVscodeBootstrap({ animations });
  animations.push({ playState: "paused", play: () => { playCalls += 1; } });

  harness.mutationCallback([{
    type: "childList",
    addedNodes: [{ matches: () => true }],
  }]);
  assert.equal(playCalls, 0);
  assert.equal(harness.animationFrames.length, 1);
  harness.animationFrames.shift()();
  assert.equal(playCalls, 1);
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
    /localResourceRoots:\s*\[\s*this\.context\.extensionUri,\s*runtimeUri,/u,
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
  const html = webviewHtml({}, "orbit", WEBVIEW_THEMES);
  for (const theme of THEMES) {
    assert.match(html, new RegExp(`option value=\\\\"${theme}\\\\"`));
  }
  assert.match(html, /vscode\.setState\(\{ \.\.\.\(vscode\.getState\(\) \|\| \{\}\), theme \}\)/);
  assert.match(html, /vscode\.postMessage\(\{ type: 'theme', theme \}\)/);
  assert.match(html, /event\.data\?\.type === 'theme'/);
});

test("panel starts in the theme the extension restored", () => {
  assert.match(
    webviewHtml({}, "gothic", WEBVIEW_THEMES),
    /<html lang="ru" data-theme="gothic" data-surface="desktop">/,
  );
  assert.match(
    webviewHtml({}, "blackhole", WEBVIEW_THEMES),
    /<html lang="ru" data-theme="blackhole" data-surface="desktop">/,
  );
  assert.match(
    webviewHtml({}, "metropolis", WEBVIEW_THEMES),
    /<html lang="ru" data-theme="metropolis" data-surface="desktop">/,
  );
  assert.match(
    webviewHtml({}, "нет такой", WEBVIEW_THEMES),
    /<html lang="ru" data-theme="orbit" data-surface="desktop">/,
  );
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
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  const workLogStyles = fs.readFileSync(require.resolve("../work-log.css"), "utf8");
  assert.match(app, /function replaceCollapsedTurnList\(list, entries\)/u);
  assert.match(app, /data-work-log-previous-turns-closed/u);
  assert.match(app, /Показать предыдущие ходы/u);
  assert.match(app, /replaceCollapsedTurnList\(list, entries\)/u);
  assert.doesNotMatch(app, /if \(list\) list\.replaceChildren\(\.\.\.entries\)/u);
  assert.match(styles, /details\[data-work-log-previous-turns\] \{[\s\S]*?display: block;/u);
  assert.match(workLogStyles, /details\[data-work-log-previous-turns\] \{[\s\S]*?display: block;/u);
});

test("chat controls live in the shared composer without a chat header", () => {
  const index = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(path.join(WEB_APP_ROOT, "styles.css"), "utf8");
  assert.doesNotMatch(index, /class="chat-head"|data-mobile-chat-actions|class="chat-actions"|class="overflow"/u);
  assert.match(index, /class="chat-overlay-actions"[\s\S]*?data-action="task-diff"[\s\S]*?data-action="task-settings"/u);
  assert.doesNotMatch(index, /data-chat-(?:title|subtitle|provider-dot|running)/u);
  assert.doesNotMatch(app, /buildSubtitleChips|chatProviderDot|chatSubtitle|chatTitle|chatRunning|syncChatActionsPlacement|mobileChatActions|chatHead/u);
  assert.match(styles, /\.chat-pane\s*\{[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\);/u);
  assert.match(styles, /\.chat-scroll\s*\{[\s\S]*?grid-row:\s*1;/u);
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

test("extension discovers theme assets from the active runtime catalog", () => {
  const extension = fs.readFileSync(require.resolve("./extension.js"), "utf8");
  const shared = fs.readFileSync(require.resolve("./shared-webview.js"), "utf8");
  assert.doesNotMatch(extension, /const THEMES = new Set/u);
  assert.match(extension, /this\.themes = new Set\(shell\.themeIds\)/u);
  assert.doesNotMatch(extension, /PULSAR_IMAGE_PATH|WORK_LOG\.md/u);
  assert.match(shared, /require\(path\.join\(runtimeUri\.fsPath, "theme-registry\.cjs"\)\)/u);
  assert.match(shared, /registryTools\.loadThemeRegistry\(path\.join\(runtimeUri\.fsPath, \.\.\.ASSET_ROOT\)\)/u);
  assert.match(shared, /renderThemeHtml\(html, themeRegistry/u);
  assert.match(shared, /themeRegistry\.resources/u);
  assert.doesNotMatch(shared, /--stormglass-image|stormGlass|ashen-reliquary/u);
});

test("background choice is remembered independently for every theme", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(app, /const backgroundStorageKey = \(theme\) => `\$\{LEGACY_BACKGROUND_STORAGE_KEY\}:\$\{theme\}`/u);
  assert.match(app, /applyTheme\(theme,[\s\S]*populateBackgroundOptions\(selected\);\s*applyBackground\(savedBackground\(selected\)\)/u);
  assert.match(app, /sessionBackgrounds\.set\(root\.dataset\.theme, selected\)/u);
  assert.match(app, /localStorage\.setItem\(backgroundStorageKey\(root\.dataset\.theme\), selected\)/u);
});

test("theme layers keep the background, effects and content in order", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /body::after\s*\{[^}]*z-index:\s*0;/su);
  assert.match(styles, /body::before\s*\{[^}]*pointer-events:\s*none;[^}]*z-index:\s*1;/su);
  assert.match(styles, /\.theme-atmosphere\s*\{[^}]*pointer-events:\s*none;[^}]*z-index:\s*1;/su);
  assert.match(styles, /main\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/su);
  assert.match(styles, /\.workspace\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*2;/su);
});

test("theme motion is visible, distinct and keeps reduced-motion support", () => {
  const styles = allStyles();
  for (const [theme, animation] of [
    ["orbit", "orbit-tracking-pass"],
    ["nebula", "nebula-spectrum-breathe"],
    ["pulsar", "pulsar-beat"],
    ["blackhole", "blackhole-lensing"],
    ["magma", "magma-glow"],
    ["meadow", "meadow-breathe"],
    ["lake", "lake-sun-path"],
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
  const client = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(client, /function buildRainDrop\(heavy = false\)/u);
  /* «Storm» берёт тот же слой капель, но плотнее и быстрее: ливень, а не
     дождь тайги. */
  assert.equal(THEME_REGISTRY.themes.find((theme) => theme.id === "stormglass")
    .backgrounds[0].particles, "downpour");
  assert.match(styles, /@keyframes downpour-fall/u);
  assert.match(client, /prefers-reduced-motion: reduce/u);
  for (const property of ["--x", "--len", "--thickness", "--alpha", "--dur", "--delay"]) {
    assert.ok(client.includes(`"${property}"`), `капля задаёт ${property}`);
  }
  assert.match(styles, /@keyframes magma-glow\s*\{[\s\S]*opacity:\s*0\.34;[\s\S]*transform:\s*scale\(1\.035\);/u);
  /* Gothic остаётся тёплым: фон темы — склеп с горящим факелом. Пыль ушла из
     плитки в отдельные элементы, на фоновом слое остался только блик. */
  assert.match(styles, /@keyframes gothic-fire\s*\{[\s\S]*filter:\s*brightness\(1\.22\);/u);
  assert.match(styles, /@keyframes mote-rise\s*\{[\s\S]*translate3d\(0, -106vh, 0\)/u);
  assert.match(styles, /\.motes\s*\{[^}]*z-index:\s*1;/u);
  assert.match(styles, /\.motes > span\s*\{[^}]*animation:\s*mote-rise var\(--dur\) linear infinite;/u);
  assert.match(client, /function buildMote\(\)/u);
  assert.match(client, /background\.particles/u);
  /* Гасить к лунному проёму теперь должен слой пыли, а не блик факела. */
  assert.match(
    styles,
    /\.motes\s*\{[^}]*mask-image:\s*linear-gradient\(90deg,\s*transparent/su,
  );
  /* Пошаговые анимации давали видимую дёрганость, поэтому в живых слоях их
     быть не должно: единственный резкий ритм — «Пульсар», и он linear. */
  const motionBlocks = styles.match(/animation:\s*(?:gothic-fire|magma-glow|orbit-tracking-pass|nebula-spectrum-breathe|meadow-breathe|lake-sun-path|pulsar-beat|blackhole-lensing)[^;]*;/gu) ?? [];
  assert.equal(motionBlocks.length, 8, "живой слой остаётся у восьми тем; «Rain», «Storm» и «Gothic» рисуют частицы");
  for (const block of motionBlocks) {
    assert.doesNotMatch(block, /steps\(/u, `движение должно быть плавным: ${block}`);
  }
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*animation:\s*none !important;/u);
});

test("Rain keeps its stored key and is named consistently", () => {
  const manifest = THEME_REGISTRY.themes.find((theme) => theme.id === "taiga");
  const webview = fs.readFileSync(require.resolve("./webview.js"), "utf8");
  assert.equal(manifest.name, "Rain");
  assert.match(webview, /availableThemes\.map\(\(item\) => `<option value="\$\{item\.id\}">\$\{escapeHtml\(item\.name\)\}<\/option>`\)/u);
});

test("Windows file objects use an STA clipboard process without interpolating the path", async () => {
  const { copyWindowsFileObject } = loadExtension({ FileType: { File: 1 } });
  let invocation = null;
  await copyWindowsFileObject("D:/work/file with spaces.txt", {
    platform: "win32",
    execFileImpl(command, args, options, callback) {
      invocation = { command, args, options };
      callback(null);
    },
  });
  assert.equal(invocation.command, "powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]);
  assert.equal(invocation.options.env.AGENT_HUB_CLIPBOARD_FILE, path.resolve("D:/work/file with spaces.txt"));
  assert.equal(invocation.args.includes(invocation.options.env.AGENT_HUB_CLIPBOARD_FILE), false);
  assert.equal(invocation.options.windowsHide, true);
});

test("file object clipboard rejects unsupported operating systems", () => {
  const { copyWindowsFileObject } = loadExtension({ FileType: { File: 1 } });
  assert.throws(
    () => copyWindowsFileObject("/tmp/file.txt", { platform: "linux" }),
    /поддерживается только в Windows/u,
  );
});

test("Magma packages three Obsidian Forge scenes without legacy lava textures", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "magma");
  assert.deepEqual(
    theme.backgrounds.map(({ id, name, asset }) => [id, name, asset]),
    [
      ["magma", "Лавовый колодец", "magma-lava-well.jpg"],
      ["magma-fissure", "Центральный разлом", "magma-fissure.jpg"],
      ["magma-forge-heart", "Сердце горна", "magma-forge-heart.jpg"],
    ],
  );
  assert.equal(theme.backgrounds[0].preload, true);
  assert.equal(theme.resources.some((resource) => resource.pathname.endsWith("/magma-crust.jpg")), false);
  assert.equal(theme.resources.some((resource) => resource.pathname.endsWith("/magma-flow.jpg")), false);
});

test("general settings and current-dialog settings stay separate", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.doesNotMatch(html, /data-panel-open="view"/u);
  assert.equal((html.match(/data-panel-open="settings"/gu) ?? []).length, 1);
  assert.match(html, /data-dialog-settings-toggle/u);
  assert.match(html, /data-dialog-settings/u);
  assert.match(html, /data-dialog-agent/u);
  assert.doesNotMatch(html, /data-dialog-options="agent"/u);
  assert.match(html, /data-dialog-options="model"/u);
  assert.match(html, /data-dialog-options="reasoning"/u);
  assert.match(html, /data-dialog-options="mode"/u);
  assert.match(html, /data-dialog-working-directory/u);
  assert.doesNotMatch(html, /data-dialog-options="project"/u);
  assert.match(app, /chatPane\.toggleAttribute\("data-dialog-settings-open", visible\)/u);
  assert.doesNotMatch(html, /data-token-breakdown-toggle/u);
  assert.match(html, /data-claude-group-toggle/u);
  assert.match(html, /data-usage-unit="rub">₽<\/button>/u);
  assert.match(html, /data-usage-unit="pte"/u);
  assert.match(html, /data-exchange-rate-hint/u);
  /* Формулы единиц занимают несколько строк, поэтому лежат в свёрнутой справке. */
  assert.match(html, /<details class="setting-note">\s*<summary>Как считается расход<\/summary>/u);
  assert.doesNotMatch(html, /<details class="setting-note" open>/u);
  assert.match(html, /<b>cr<\/b> — официальные «кредиты» Codex, ПТЭ \/ 16000\./u);
  assert.match(
    html,
    /База = входные токены \+\s+кэшированный вход × 0,1 \+ выходные токены × 6 \+ токены рассуждений × 6;/u,
  );
  assert.match(html, /<li>GPT-5\.5 и GPT-5\.6-Sol — База ×2;<\/li>/u);
  assert.match(html, /<li>GPT-5\.4-mini — База ×0,3;<\/li>/u);
  /* fastModeCreditMultiplier не трогает 5.4-mini, поэтому подсказка называет
     обе ставки Fast и исключение. */
  assert.match(
    html,
    /режим Fast дополнительно увеличивает расход в 2,5 раза для GPT-5\.5 и всех\s+GPT-5\.6 и в 2 раза для GPT-5\.4; на GPT-5\.4-mini не влияет;/u,
  );
  /* Порядок чипов повторяет порядок строк справки: ПТЭ → cr → $ → ₽. */
  assert.match(
    html,
    /data-usage-unit="pte">ПТЭ<\/button>[\s\S]*?data-usage-unit="cr">cr<\/button>[\s\S]*?data-usage-unit="\$">\$<\/button>[\s\S]*?data-usage-unit="rub">₽<\/button>/u,
  );
  assert.match(app, /`курс ЦБ РФ \$\{spacedNumber\(usdRubRate, 4\)\} за \$1/u);
  assert.doesNotMatch(app, /agent-hub-token-breakdown/u);
  assert.match(app, /agent-hub-group-claude/u);
  assert.match(app, /agent-hub-usage-unit/u);
  assert.match(html, /data-toggle="includeClaudeUsage"/u);
  assert.match(html, /data-trusted-device-list/u);
  assert.match(app, /setTrustedDevices/u);
  assert.match(app, /const CREDITS_PER_USD = 25;/u);
  assert.match(app, /const PTE_PER_CREDIT = 16_000;/u);
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
  const source = fs.readFileSync(
    require.resolve("../assets/web-app/navigation-tabs-controller.js"),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  for (const tab of ["tasks", "chat", "dashboard", "journal", "statistics", "background", "server"]) {
    assert.equal(
      window.AgentHubNavigationTabs.storedNavigationTab({ getItem: () => tab }, "tab-key"),
      tab,
    );
  }
});

test("task list keeps active duration live and metadata badges readable", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(client, /startedAt:\s*running\s*\?\s*task\.run\?\.startedAt/u);
  assert.match(app, /function formatRunningDuration\(/u);
  assert.match(app, /data-task-started-at/u);
  assert.match(app, /setInterval\(refreshTaskDurations,\s*1_000\)/u);
  assert.match(styles, /\.task-agent\s*\{[^}]*flex:\s*0 0 auto;/su);
  assert.match(styles, /\.task-runtime\s*\{[^}]*background:\s*var\(--accent-soft\);[^}]*color:\s*var\(--accent\);/su);
  assert.match(app, /function shortModelLabel\(value\)/u);
  assert.match(app, /\["terra", "Terra"\][\s\S]*\["sonnet", "Sonnet"\]/u);
  assert.match(app, /\["spark", "Spark"\]/u);
  assert.match(app, /class: "task-agent task-model"[\s\S]*text: shortModelLabel\(task\.modelLabel\)/u);
  assert.match(
    client,
    /modelLabel:\s*task\.run\?\.model\s*\?\?\s*task\.model\s*\?\?\s*\(serverSelected\s*\?\s*snapshot\.selected\?\.model\s*:\s*""\)/u,
  );
  assert.match(app, /task\.statusLabel[\s\S]*task\.runtimeLabel/u);
  assert.match(styles, /\.task-meta\s*\{[^}]*flex:\s*1 1 auto;/su);
  assert.match(styles, /\.task-runtime\s*\{[^}]*margin-left:\s*auto;/su);
});

test("rename targets the emitted Thread and upgrades to its Workspace when present", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /task:rename", \(\{ id, title \}\)/u);
  assert.match(client, /const targetId = id \|\| selectedTaskId;/u);
  assert.match(client, /taskId\(candidate\.provider, candidate\.threadId, candidate\.streamId\) === targetId/u);
  assert.match(client, /task\?\.workspaceId \? "rename-workspace" : "rename-task"/u);
  assert.match(client, /task\?\.workspaceId \? \{ workspaceId: task\.workspaceId, name: title \} : \{ \.\.\.identity, title \}/u);
});

test("web clients reload after any Hub runtime identity change", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /snapshot\?\.server\?\.process/u);
  assert.match(client, /runtimeIdentityTransition/u);
  assert.match(client, /transition\.reloadRequired/u);
  assert.match(client, /instanceChanged[\s\S]*notifyAndroidAboutRelease/u);
  assert.match(client, /reloadForPublishedRuntime\(\)/u);
  assert.match(client, /AgentHubAndroid\?\.onHubRestarted/u);
  assert.match(client, /prepareForRuntimeReload/u);
  assert.match(client, /window\.location\.reload\(\)/u);
});

test("shared VS Code webview removes public browser pairing", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const shared = fs.readFileSync(require.resolve("./shared-webview.js"), "utf8");
  assert.match(html, /<script src="\/browser-device-auth\.js" defer><\/script>/u);
  assert.match(shared, /browser-device-auth/u);
});

test("Metropolis uses a fogged-glass WebGL plane with refracted moving drops", () => {
  const styles = themeFile("metropolis");
  const glass = themeFile("metropolis", "metropolis-glass.js");
  const markup = themeFile("metropolis", "theme.html");
  const manifest = THEME_REGISTRY.themes.find((theme) => theme.id === "metropolis");
  assert.equal(manifest.name, "Мегаполис");
  assert.deepEqual(manifest.scripts, ["metropolis-glass.js"]);
  assert.match(markup, /<canvas data-metropolis-glass><\/canvas>/u);
  assert.match(styles, /html\[data-theme="metropolis"\] body::after\s*\{[\s\S]*var\(--metropolis-image\)/u);
  assert.match(styles, /backdrop-filter:\s*blur\(6px\) saturate\(68%\) brightness\(0\.82\)/u);
  assert.match(glass, /vec4 rainLayer\(/u);
  assert.match(glass, /float drop = 1\.0 - smoothstep\(0\.02,\s*0\.03/u);
  assert.match(glass, /float clearTrail = smoothstep\(-0\.05,\s*0\.05/u);
  assert.match(glass, /uViewport\.x \/ max\(uViewport\.y,\s*1\.0\)/u);
  assert.match(glass, /vec2 refraction = drop \* dropPosition/u);
  assert.match(glass, /vec2 refractedUv = imageUv \+ drops\.xy \* 1\.65/u);
  assert.match(glass, /uniform sampler2D uFogImage/u);
  assert.match(glass, /vec4 fogged = texture2D\(uFogImage,\s*imageUv\)/u);
  assert.match(glass, /function createFogTexture\(image\)/u);
  assert.match(glass, /filter: "blur\(4px\) saturate\(82%\) brightness\(88%\)"/u);
  assert.match(glass, /webglcontextlost[\s\S]*reset\(\{ contextLost: true \}\)/u);
  assert.match(glass, /webglcontextrestored[\s\S]*syncTheme/u);
  assert.match(glass, /window\.addEventListener\("focus", syncTheme\)/u);
  assert.doesNotMatch(glass, /for \(int index = 0; index < 32/u);
  assert.doesNotMatch(glass, /condensation|glassHighlight/u);
  assert.match(glass, /prefers-reduced-motion: reduce/u);
});

test("Storm keeps the photo backdrop and adds only lightning", () => {
  const shader = themeFile("metropolis", "metropolis-glass.js");
  const storm = themeFile("stormglass", "storm-glass.js");
  const styles = themeFile("stormglass");
  /* Стекло с каплями уместно там, где за ним огни: на ночном море оно
     читалось мутью, поэтому «Storm» обходится фоном и грозой. */
  assert.doesNotMatch(shader, /stormglass/u);
  assert.match(styles, /html\[data-theme="stormglass"\] \.theme-atmosphere \[data-metropolis-glass\]/u);
  assert.match(styles, /html\[data-theme="stormglass"\] body::after\s*\{[\s\S]*?var\(--stormglass-image\)/u);

  /* Оживает сама сцена: вода дышит по маске горизонта, небо медленно плывёт,
     а разряд подсвечивает кадр вторым снимком той же сцены. */
  assert.match(styles, /--stormglass-flash: url\("\.\/storm-flash\.jpg"\)/u);
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
  assert.match(storm, /webglcontextlost[\s\S]*context = null/u);
  assert.match(storm, /webglcontextrestored[\s\S]*sync/u);
  assert.match(storm, /window\.addEventListener\("focus", sync\)/u);
});

test("Gothic theme packages the Old Camp banner with its Sleeper-temple palette", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "gothic");
  const styles = themeFile("gothic");
  const banner = theme.resources.find((resource) => resource.pathname.endsWith("/gothic-old-camp-banner.png"));
  const ironTexture = theme.resources.find((resource) => resource.pathname.endsWith("/gothic-iron-texture.png"));
  const ironFrame = theme.resources.find((resource) => resource.pathname.endsWith("/gothic-iron-frame.jpg"));
  const forgedFrame = theme.resources.find((resource) => resource.pathname.endsWith("/gothic-forged-frame.png"));
  const matteForgedFrame = theme.resources.find((resource) => resource.pathname.endsWith("/gothic-forged-frame-matte.png"));
  const xardasTower = theme.resources.find((resource) => resource.pathname.endsWith("/gothic-xardas-tower.jpg"));
  /* Знамя — самостоятельный ресурс пакета темы. Это проверяет фактическую
     доступность во Worker и webview вместо снимка конкретных CSS-деклараций.
     Кованая оболочка так же обязана доехать как растровые ресурсы темы. */
  assert.equal(theme.color, "#100d0b");
  assert.ok(banner);
  assert.equal(banner.contentType, "image/png");
  assert.equal(banner.immutable, true);
  assert.ok(fs.statSync(banner.file).size > 100_000);
  assert.ok(ironTexture);
  assert.equal(ironTexture.contentType, "image/png");
  assert.equal(ironTexture.immutable, true);
  assert.ok(fs.statSync(ironTexture.file).size > 100_000);
  assert.ok(ironFrame);
  assert.equal(ironFrame.contentType, "image/jpeg");
  assert.equal(ironFrame.immutable, true);
  assert.ok(fs.statSync(ironFrame.file).size > 10_000);
  assert.ok(forgedFrame);
  assert.equal(forgedFrame.contentType, "image/png");
  assert.equal(forgedFrame.immutable, true);
  assert.ok(fs.statSync(forgedFrame.file).size > 50_000);
  assert.ok(matteForgedFrame);
  assert.equal(matteForgedFrame.contentType, "image/png");
  assert.equal(matteForgedFrame.immutable, true);
  assert.ok(fs.statSync(matteForgedFrame.file).size > 50_000);
  assert.ok(xardasTower);
  assert.equal(xardasTower.contentType, "image/jpeg");
  assert.equal(xardasTower.immutable, true);
  assert.ok(fs.statSync(xardasTower.file).size > 80_000);
  assert.match(styles, /--radius-lg:\s*0;/u);
});

test("«Gothic» offers ten night scenes, each with its own light", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "gothic");
  const backgrounds = themeFile("gothic");
  assert.deepEqual(theme.backgrounds.map((background) => background.id), [
    "gothic", "gothic-old-camp", "gothic-swamp-camp", "gothic-new-camp", "gothic-xardas-tower",
    "gothic-sleeper-temple", "gothic-innos-monastery", "gothic-sun-circle", "gothic-irdorath", "gothic-adanos-temple",
  ]);
  for (const [background, image] of [
    ["gothic", "gothic-khorinis-harbor\\.jpg"],
    ["gothic-old-camp", "gothic-old-camp\\.jpg"],
    ["gothic-swamp-camp", "gothic-swamp-camp\\.jpg"],
    ["gothic-new-camp", "gothic-new-camp\\.jpg"],
    ["gothic-xardas-tower", "gothic-xardas-tower\\.jpg"],
    ["gothic-sleeper-temple", "gothic-sleeper-temple\\.jpg"],
    ["gothic-innos-monastery", "gothic-innos-monastery\\.jpg"],
    ["gothic-sun-circle", "gothic-sun-circle\\.jpg"],
    ["gothic-irdorath", "gothic-irdorath\\.jpg"],
    ["gothic-adanos-temple", "gothic-adanos-temple\\.jpg"],
  ]) {
    assert.match(
      backgrounds,
      new RegExp(`\\[data-background="${background}"\\][^\\n]*${image}`, "u"),
      background,
    );
    /* Общий слой над чужой сценой выключён, поэтому каждая сцена включает его
       обратно с собственным источником света. */
    assert.match(
      backgrounds,
      new RegExp(`\\[data-background="${background}"\\] body::before \\{[^}]*animation: gothic-scene-`, "su"),
      `${background} motion`,
    );
  }
  assert.equal(theme.backgrounds[0].name, "Гавань Хориниса");
  assert.equal(theme.backgrounds[0].particles, "rain");
  assert.match(backgrounds, /@keyframes gothic-scene-fog/u);
  assert.match(backgrounds, /@keyframes gothic-scene-glow/u);
  for (const [image, revision] of [
    ["gothic-khorinis-harbor.jpg", "1f41339934cb"],
    ["gothic-old-camp.jpg", "7699c09177ec"],
    ["gothic-swamp-camp.jpg", "f8876864b8ba"],
    ["gothic-new-camp.jpg", "f193f6efa8d6"],
    ["gothic-xardas-tower.jpg", "86928a4c8b38"],
    ["gothic-sleeper-temple.jpg", "fdd63e9f6fd6"],
    ["gothic-innos-monastery.jpg", "77863edab3d8"],
    ["gothic-sun-circle.jpg", "083a89ad257a"],
    ["gothic-irdorath.jpg", "1ea92b3428f7"],
    ["gothic-adanos-temple.jpg", "7f3365e4a6e6"],
  ]) {
    assert.match(backgrounds, new RegExp(`${image.replace(".", "\\.")}\\?v=${revision}`, "u"), image);
  }
});

test("large Gothic scenes are decoded before replacing the visible background", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "gothic");
  assert.deepEqual(
    theme.backgrounds.filter((background) => background.preload).map((background) => background.id),
    ["gothic-old-camp", "gothic-swamp-camp", "gothic-new-camp", "gothic-xardas-tower", "gothic-sleeper-temple", "gothic-innos-monastery", "gothic-sun-circle", "gothic-irdorath", "gothic-adanos-temple"],
  );
  assert.match(client, /image\.decode\(\)\.then\(\(\) => finish\(true\)/u);
  assert.match(client, /if \(requestId !== backgroundRequestId\) return;/u);
  assert.match(client, /if \(loaded\) \{ commitBackground\(selected, persist\); return; \}/u);
});

test("«Озеро» keeps after-rain, summer-evening and watercolor scenes", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "lake");
  const backgrounds = themeFile("lake");
  for (const [background, image] of [
    ["lake", "lake-after-rain.jpg"],
    ["lake-summer", "lake-summer.jpg"],
    ["lake-watercolor", "lake-watercolor.jpg"],
  ]) {
    assert.equal(theme.backgrounds.find((item) => item.id === background).asset, image, background);
    assert.match(
      backgrounds,
      new RegExp(`\\[data-background="${background}"\\][^\\n]*${image.replace(".", "\\.")}`, "u"),
      background,
    );
  }
  assert.deepEqual(theme.backgrounds.map((background) => [background.id, background.name]), [
    ["lake", "После дождя"],
    ["lake-summer", "Летний вечер"],
    ["lake-watercolor", "Акварель"],
  ]);
  /* Блок фона специфичнее подмены из панели VS Code, поэтому путь к рисованным
     кадрам берётся через var с запасным значением, а не объявляется заново. */
  assert.match(backgrounds, /--lake-image:\s*url\("\.\/lake-after-rain\.jpg"\)/u);
  assert.match(backgrounds, /--lake-corners-image:\s*url\("\.\/lake-corners\.png"\)/u);
  assert.match(backgrounds, /--lake-mark-image:\s*url\("\.\/lake-mark\.png"\)/u);
  assert.match(backgrounds, /--lake-settings-image:\s*url\("\.\/lake-settings\.png"\)/u);
  assert.match(backgrounds, /\.toolbar \.view-settings\s*\{[\s\S]*border-radius:\s*5px/u);
  assert.match(backgrounds, /@keyframes lake-ripple/u);
  for (const variable of ["--lake-summer-image", "--lake-watercolor-image"]) {
    assert.match(backgrounds, new RegExp(`var\\(${variable},\\s*url\\(`, "u"), variable);
    assert.doesNotMatch(backgrounds, new RegExp(`${variable}:\\s*url\\(`, "u"), variable);
  }
});

test("BlackHole keeps three scenes around the selected Focus Deck", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "blackhole");
  const styles = themeFile("blackhole");
  assert.deepEqual(
    theme.backgrounds.map(({ id, name, asset }) => [id, name, asset]),
    [
      ["blackhole", "Сингулярность", "blackhole-blue.jpg"],
      ["blackhole-photon", "Фотонное кольцо", "blackhole-photon.jpg"],
      ["blackhole-disk", "Аккреционный поток", "blackhole-disk.jpg"],
    ],
  );
  assert.equal(theme.backgrounds[0].preload, true);
  for (const [background, image] of [
    ["blackhole-photon", "blackhole-photon.jpg"],
    ["blackhole-disk", "blackhole-disk.jpg"],
  ]) {
    assert.match(
      styles,
      new RegExp(`\\[data-background="${background}"\\][\\s\\S]*?${image.replace(".", "\\.")}`, "u"),
      background,
    );
  }
  /* У BlackHole активный Stream становится центром палубы, а первый соседний
     уходит влево. Прямоугольная рамка не обрезает действия в верхнем углу. */
  assert.match(styles, /\.stream-chat-columns\[data-multi-stream\]\s*\{[\s\S]*display:\s*flex/u);
  assert.match(styles, /> \.chat-pane\s*\{[^}]*border-radius:\s*0;/su);
  assert.doesNotMatch(styles, /> \.chat-pane\s*\{[^}]*clip-path:/su);
  assert.match(
    styles,
    /\.stream-chat-columns > \.chat-pane\[data-active-stream\]\s*\{[^}]*background:\s*linear-gradient\(180deg, rgb\(0 4 10 \/ 90%\), rgb\(0 2 7 \/ 94%\)\)/su,
  );
  assert.match(styles, /\.stream-chat-preview:first-of-type\s*\{[\s\S]*order:\s*-1 !important/u);
  assert.match(styles, /\.msg-user\s*\{[^}]*border:\s*1px solid rgb\(134 195 248 \/ 52%\)/su);
  /* В одиночном чате панель ввода совпадает с границами ленты сообщений,
     а правила Focus Deck ниже по каскаду по-прежнему сужают её до колонки. */
  assert.match(
    styles,
    /\.composer\s*\{[^}]*width:\s*min\(54rem, calc\(100% - var\(--gutter-left\) - var\(--gutter-right\)\)\)/su,
  );
  assert.match(styles, /:has\(\.stream-chat-preview:nth-of-type\(3\)\) \.composer\s*\{[^}]*width:\s*40%/su);
  assert.match(styles, /@keyframes blackhole-lensing/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("Bespin keeps the three selected Cloud City scenes", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "bespin");
  assert.deepEqual(
    theme.backgrounds.map(({ id, name, asset }) => [id, name, asset]),
    [
      ["bespin", "Облачный город", "bespin-city.jpg"],
      ["bespin-lounge", "Золотой салон", "bespin-lounge.jpg"],
      ["bespin-skybridge", "Небесная галерея", "bespin-skybridge.jpg"],
    ],
  );
  assert.deepEqual(theme.backgrounds.map(({ preload }) => preload), [true, true, true]);
  for (const background of theme.backgrounds) {
    assert.ok(
      theme.resources.some((resource) => resource.pathname.endsWith(`/${background.asset}`)),
      background.asset,
    );
  }
});

test("Kashyyyk packages forest scenes and its physical panel materials", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "kashyyyk");
  const styles = themeFile("kashyyyk");
  assert.deepEqual(
    theme.backgrounds.map(({ id, name, asset }) => [id, name, asset]),
    [
      ["kashyyyk", "Древо Истока", "kashyyyk-origin-tree.jpg"],
      ["kashyyyk-village", "Ночная деревня", "kashyyyk-canopy-village.jpg"],
      ["kashyyyk-refinery", "Заброшенный завод", "kashyyyk-refinery.jpg"],
    ],
  );
  assert.deepEqual(theme.backgrounds.map(({ preload }) => preload), [true, true, true]);
  for (const background of theme.backgrounds) {
    assert.ok(
      theme.resources.some((resource) => resource.pathname.endsWith(`/${background.asset}`)),
      background.asset,
    );
  }
  for (const asset of [
    "kashyyyk-dark-wood.webp",
    "kashyyyk-panel-frame.webp",
    "kashyyyk-side-rail.webp",
    "kashyyyk-panel-moss.webp",
  ]) {
    assert.ok(
      theme.resources.some((resource) => resource.pathname.endsWith(`/${asset}`)),
      asset,
    );
  }
  const settingsRules = [...styles.matchAll(/[^{}]*\.settings-panel[^{}]*\{([^{}]*)\}/gu)];
  assert.ok(settingsRules.length > 0);
  for (const [, declarations] of settingsRules) {
    assert.doesNotMatch(declarations, /\b(?:overflow|position)\s*:/u);
  }
});

test("Verdant keeps its signal sweep across three environment scenes", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "verdant");
  const styles = themeFile("verdant");
  assert.deepEqual(
    theme.backgrounds.map(({ id, asset }) => [id, asset]),
    [
      ["verdant", "verdant-ruins.jpg"],
      ["verdant-canopy", "verdant-canopy.jpg"],
      ["verdant-sanctum", "verdant-sanctum.jpg"],
    ],
  );
  for (const background of ["verdant-canopy", "verdant-sanctum"]) {
    assert.match(styles, new RegExp(`\\[data-background="${background}"\\] \\{`, "u"), background);
    assert.match(
      styles,
      new RegExp(`\\[data-background="${background}"\\] body::before`, "u"),
      `${background} signal sweep`,
    );
  }
  assert.match(styles, /@keyframes verdant-signal-sweep/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("Orbit fills the viewport with one translucent cartography console", () => {
  const theme = THEME_REGISTRY.themes.find((item) => item.id === "orbit");
  const styles = themeFile("orbit");
  assert.deepEqual(
    theme.backgrounds.map(({ id, asset }) => [id, asset]),
    [
      ["orbit", "orbit-cartography.jpg"],
      ["orbit-limb", "orbit-limb.jpg"],
      ["orbit-aurora", "orbit-aurora.jpg"],
      ["orbit-earthrise", "orbit-earthrise.jpg"],
    ],
  );
  /* В отличие от Verdant чат занимает всю оставшуюся колонку, а свободная
     картографическая сцена просвечивает внутри общей рабочей поверхности. */
  assert.match(styles, /--content-width:\s*100vw/u);
  assert.match(styles, /--task-rail-width:\s*clamp\(252px, 16vw, 304px\)/u);
  assert.match(styles, /grid-template-columns:\s*var\(--task-rail-width\) minmax\(0, 1fr\)/u);
  assert.match(styles, /\.chat \{[\s\S]*background:\s*rgb\(2 11 22 \/ 18%\)/u);
  assert.match(styles, /\.chat-log \{[\s\S]*max-width:\s*min\(72%, 68rem\)/u);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("Verdant turns the wide chat into two floating field-console panels", () => {
  const styles = themeFile("verdant");
  /* На телефоне остаётся штатная навигация, а концептная композиция включается
     только там, где справа действительно помещается открытая сцена. */
  assert.match(styles, /@media \(min-width: 1120px\)/u);
  assert.match(styles, /--task-rail-width:\s*19\.2vw/u);
  assert.match(styles, /grid-template-columns:\s*\n\s*var\(--task-rail-width\)\s*\n\s*minmax\(620px, 42vw\)/u);
  assert.match(styles, /\.task-rail,\s*\n[^{}]*\.chat \{/u);
  assert.match(styles, /border: 1px solid rgba\(131, 237, 165, 0\.28\)/u);
  assert.match(styles, /\.msg-agent \{\s*\n\s*background-color: transparent/u);
  assert.match(styles, /--verdant-corner-mark:\s*rgba\(156, 255, 190, 0\.7\)/u);
  assert.match(styles, /\.task-rail::after,\s*\n[^{}]*\.chat::after \{/u);
  assert.match(styles, /left top \/ 12px 1px no-repeat/u);
  assert.match(styles, /background:\s*linear-gradient\(180deg, rgba\(2, 22, 18, 0\.5\), rgba\(1, 15, 13, 0\.62\)\)/u);
  assert.match(styles, /:not\(\[data-surface="mobile"\]\)/u);
});

test("select popups use the active theme instead of the operating-system menu", () => {
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(styles, /\.themed-select-menu \{[\s\S]*var\(--surface-1\)[\s\S]*var\(--accent\)/u);
  assert.match(styles, /\.themed-select-option\[aria-selected="true"\] \{[\s\S]*var\(--accent-soft\)/u);
  assert.match(app, /function enhanceThemedSelect\(select\)/u);
  assert.match(app, /select\.dispatchEvent\(new Event\("change", \{ bubbles: true \}\)\)/u);
  assert.match(app, /role", "listbox"/u);
  assert.match(app, /select\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(app, /state\.destroy = \(\) =>/u);
  assert.match(app, /const optionTop = option\.offsetTop/u);
  assert.match(app, /event\.target !== openThemedSelect\?\.menu/u);
});

test("VS Code resolves each self-contained theme resource without CSS overrides", () => {
  const shared = fs.readFileSync(require.resolve("./shared-webview.js"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const reliquary = themeFile("reliquary");
  assert.match(shared, /themeResourceUrls = new Map/u);
  assert.match(shared, /vscode\.Uri\.file\(item\.file\)/u);
  assert.doesNotMatch(shared, /assetOverrides/u);
  assert.match(reliquary, /url\("\.\/forgotten-waypoint\.webp"\)/u);
  assert.match(app, /root\.style\.setProperty\(`--\$\{background\}-image`, cssBackgroundUrl\(url\)\)/u);
});

test("turn header keeps its actions in the trailing columns", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  /* Действий стало два — значок субагентов и «Открыть ход», — поэтому под них
     отводятся две автоколонки вместо одной фиксированной. */
  assert.match(
    styles,
    /\.journal details\[data-work-log-turn-details\] > summary\s*\{[^}]*grid-template-columns:\s*11\.5rem minmax\(0, 1fr\) auto auto;/su,
  );
});

test("subagent responses render collapsed with a readable title", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(app, /el\(subagent \? "details" : "article"/u);
  assert.match(app, /"data-subagent-response": true/u);
  assert.match(app, /function subagentResponseTitle\(message\)/u);
  assert.match(styles, /\.msg-subagent\[open\] \.msg-subagent-chevron-icon/u);
});

test("task rail width does not collide with decorative rail thickness", () => {
  const dialogArea = fs.readFileSync(
    require.resolve("../assets/web-app/dialog-area.css"),
    "utf8",
  );
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  assert.match(dialogArea, /--task-rail-width:\s*clamp\(230px, 16vw, 280px\)/u);
  assert.match(styles, /grid-template-columns:\s*var\(--task-rail-width\) minmax\(0, 1fr\)/u);
});

test("journal width stays fixed while days and turns are expanded", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /\.journal-view\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*90%;/su);
  assert.match(
    styles,
    /html\[data-surface="mobile"\]\[data-view="journal"\] \.journal-view\s*\{[^}]*width:\s*100%;/su,
  );
});

test("journal keeps explicit Workspace and Stream grouping modes", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  assert.match(
    styles,
    /\.journal details\[data-work-log-workspace\]\s*\{[^}]*border:\s*1px solid var\(--line\);[^}]*overflow:\s*hidden;/su,
  );
  assert.match(
    styles,
    /\.journal summary\[data-work-log-workspace-header\]\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*1rem 17\.5rem minmax\(0, 1fr\);/su,
  );
  assert.match(
    styles,
    /\.journal details\[data-work-log-stream\]\[open\]\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*17\.5rem minmax\(0, 1fr\);/su,
  );
  assert.match(styles, /\.journal span\[data-work-log-turn-stream\]\s*\{[^}]*border-radius:\s*999px;/su);
  assert.match(styles, /\.journal summary\[data-work-log-stream-summary\]\s*\{[^}]*cursor:\s*pointer;[^}]*display:\s*grid;/su);
  assert.match(app, /function upgradeLegacyWorkspaceGroups\(scope = journal\)/u);
  assert.match(app, /function decorateLegacyStreamTurns\(scope = journal\)/u);
  assert.doesNotMatch(app, /function flattenWorkspaceStreams\(scope = journal\)/u);
  assert.doesNotMatch(app, /function applyStreamCollapse\(value,/u);
  assert.doesNotMatch(app, /function setStreamsCollapsed\(collapsed,/u);
  assert.match(app, /agent-hub-collapse-streams/u);
  assert.doesNotMatch(styles, /data-work-log-streams-collapsed/u);
  assert.match(app, /taskGroupsFrom\(source, \{ hierarchy: mode \}\)/u);
  assert.match(
    app,
    /text: `\$\{workspaceTitle\} - \$\{streamTitle\}`/u,
  );
  assert.match(
    app,
    /journalGroupSection\(group, groups, \{ showStreams: mode !== "stream" \}\)/u,
  );
  assert.match(app, /JournalView\.groupIdentity/u);
  assert.doesNotMatch(
    styles,
    /\[data-journal-ledger-title\]::before\s*\{[^}]*mask:/su,
  );
  assert.match(styles, /span\[data-work-log-duration-summary\][\s\S]*?grid-column:\s*1 \/ -1;/u);
  assert.match(
    styles,
    /details\[data-work-log-collapsed-workspace-usage-details\][\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\) auto auto;[\s\S]*?> span\[data-work-log-duration-summary\][\s\S]*?display:\s*contents;/u,
  );
  assert.match(styles, /\.journal div\[data-work-log-task-content\]:empty\s*\{[^}]*display:\s*none;/su);
});

test("task-grouped journal pages large histories without per-row Metropolis blur", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = themeFile("metropolis");
  assert.match(app, /const TASK_GROUP_TURN_PAGE_SIZE = 30/u);
  assert.match(app, /const taskGroupTurns = new WeakMap\(\)/u);
  assert.match(app, /function appendTaskGroupTurnPage\(details, \{ nextPage = false \} = \{\}\)/u);
  assert.match(app, /Показать ещё \(\$\{turns\.length - next\}\)/u);
  assert.match(app, /details\[data-work-log-task-group\]\[open\][\s\S]*appendTaskGroupTurnPage/u);
  assert.match(
    styles,
    /html\[data-theme="metropolis"\]:is\(\[data-grouping="stream"\], \[data-grouping="workspace"\]\)[\s\S]*details\[data-work-log-turn-details\][\s\S]*backdrop-filter:\s*none/u,
  );
});

test("day-grouped journal uses Workspace cards and plain credit values", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  assert.match(app, /function workspaceGroupsFrom\(day\)/u);
  assert.match(app, /taskGroupsFrom\(day, \{ workspace \}\)/u);
  assert.doesNotMatch(app, /holder\.append\(day\.cloneNode\(true\)\)/u);
  assert.match(app, /data-work-log-collapsed-workspace-usage-details/u);
  assert.match(app, /journalLedgerSummary\(total, \{ label: dateLabel, showStreams: false \}\)/u);
  assert.match(app, /data-journal-day-picker-turns/u);
  const lazyDayBody = app.slice(
    app.indexOf("async function loadLazyDay"),
    app.indexOf("async function loadLazyTurn"),
  );
  assert.doesNotMatch(lazyDayBody, /setStreamsCollapsed\(collapseStreams, replacement\)/u);
  assert.match(
    styles,
    /\.journal-ledger \.journal span\[data-kilo-usage\][\s\S]*?background:\s*transparent;[\s\S]*?box-shadow:\s*none;/u,
  );
});

test("compact desktop header wraps before it can create horizontal overflow", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  assert.match(styles, /@media \(min-width: 860px\) and \(max-width: 1119px\)/u);
  assert.match(styles, /\.app-header-inner\s*\{[^}]*flex-wrap:\s*wrap;/su);
  assert.match(
    styles,
    /html\[data-view="journal"\] \.toolbar\s*\{[^}]*flex:\s*1 0 100%;/su,
  );
});

test("desktop themes share one shell-owned top-panel anchor", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  assert.match(
    styles,
    /\.app-header\s*\{[^}]*padding:[^;]+!important;[^}]*position:\s*sticky\s*!important;[^}]*top:\s*0\s*!important;/su,
  );
  assert.match(
    styles,
    /html\[data-view="chat"\]:not\(\[data-surface="mobile"\]\) body > \.workspace\s*\{[^}]*padding-top:\s*var\(--shell-workspace-padding-top,\s*0\.72rem\)\s*!important;/su,
  );
});

test("mobile task list cannot widen the viewport", () => {
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
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

test("narrow desktop measures the document viewport before host window width", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const resolver = app.match(
    /function layoutViewportWidth\(\) \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction resolveSurface\(\) \{[\s\S]*?\r?\n\}/u,
  )?.[0];
  assert.ok(resolver, "surface resolver is present");
  assert.doesNotMatch(resolver, /return window\.innerWidth < compactSurfaceWidth/u);

  const surfaceFor = ({ documentWidth, windowWidth }) => vm.runInNewContext(`
    const telegramMode = false;
    const telegramPlatform = "";
    const mobileTelegramPlatforms = new Set(["android", "ios"]);
    const compactSurfaceWidth = 860;
    ${resolver}
    resolveSurface();
  `, {
    document: { documentElement: { clientWidth: documentWidth } },
    window: { innerWidth: windowWidth },
  });

  /* Edge Web App can expose the host width through window.innerWidth while
     the actual webview is much narrower. The compact CSS then keeps the
     workspace in one column, so it cannot create a horizontal page overflow. */
  assert.equal(surfaceFor({ documentWidth: 380, windowWidth: 545 }), "mobile");
  assert.equal(surfaceFor({ documentWidth: 920, windowWidth: 545 }), "desktop");
});

test("mobile journal task links do not become nested expansion buttons", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(
    app,
    /if \(title\.querySelector\("\[data-open-task\]"\)\) \{[\s\S]*title\.removeAttribute\("role"\)/u,
  );
  assert.match(app, /if \(event\.target\.closest\("\[data-open-task\]"\)\) return;/u);
});

test("chat distinguishes loading history from an empty task", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(app, /const historyLoaded = state\.messages\.has\(taskId\)/u);
  assert.match(app, /MessageView\.claimKeyedChildrenOwner\(chatLog, taskId\)/u);
  assert.match(app, /Загрузка истории…/u);
});

test("chat refreshes every visible external run without rebuilding a second snapshot", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const refresh = client.match(
    /async function refresh\([^)]*\) \{(?<body>[\s\S]*?)\r?\n\}\r?\n\r?\nagentHub\.on\("connection:retry"/u,
  )?.groups?.body ?? "";
  assert.match(client, /const EXTERNAL_HISTORY_REFRESH_MS = 2_500/u);
  assert.match(client, /let visibleStreamTaskIds = new Set\(\)/u);
  assert.match(client, /async function refreshVisibleTaskHistories[\s\S]*Promise\.all\(\[\.\.\.visibleIds\]/u);
  assert.match(client, /const externalLive = currentTask\.running[\s\S]*executionOwner/u);
  assert.match(client, /refreshExternalHistory[\s\S]*enqueueTaskHistoryLoad\(id, identity/u);
  assert.match(client, /function enqueueTaskHistoryLoad[\s\S]*control\("task-history"[\s\S]*skipSnapshot: true/u);
  assert.match(client, /includeActive: false[\s\S]*knownVersion: historyPageByTask/u);
  assert.match(refresh, /void refreshVisibleTaskHistories\(previousSnapshot, snapshot\)\.catch/u);
  assert.doesNotMatch(refresh, /await refreshVisibleTaskHistories\(previousSnapshot, snapshot\)/u);
  assert.doesNotMatch(refresh, /control\("open-task"/u);
});

test("completed chat keeps probing briefly for late generated images", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const refresh = client.match(
    /async function refresh\([^)]*\) \{(?<body>[\s\S]*?)\r?\n\}\r?\n\r?\nagentHub\.on\("connection:retry"/u,
  )?.groups?.body ?? "";
  assert.match(client, /const HISTORY_ATTACHMENT_REFRESH_MS = 10_000/u);
  assert.match(client, /const HISTORY_ATTACHMENT_SETTLE_TIMEOUT_MS = 120_000/u);
  assert.match(client, /function scheduleHistoryAttachmentSettle\(taskIdValue\)/u);
  assert.match(client, /if \(answerTransition\) \{[\s\S]*scheduleHistoryAttachmentSettle\(id\)[\s\S]*historyCatchUpDeadlines\.set/u);
  assert.match(client, /refreshSettlingAttachments[\s\S]*enqueueTaskHistoryLoad\(id, identity/u);
});

test("opening a task settles generated images without delaying the cached history", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /if \(selectTask && !result\.focusedTurn\)[\s\S]*void settleOpenedTaskHistory/u);
  assert.match(
    client,
    /async function settleOpenedTaskHistory[\s\S]*enqueueTaskHistoryLoad\(id, identity,[\s\S]*refreshSource: true/u,
  );
  assert.match(client, /pending\.onlyWhenSelected && selectedTaskId !== id/u);
});

test("background history refresh cannot switch the task or reorder a completed turn", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /selectTask = true/u);
  assert.match(client, /if \(selectTask\) rememberSelectedTaskId\(id\)/u);
  assert.match(client, /if \(selectTask\) agentHub\.selectTask\(id\)/u);
  assert.match(client, /preserveScroll: pending\.preserveScroll,\s*skipSnapshot: true,\s*selectTask: false/su);
  assert.doesNotMatch(client, /incomingStartedAtMs|new Date\(incomingStartedAtMs - 1\)/u);
  assert.match(client, /time: run\.lastActivityAt \?\? run\.startedAt \?\? null/u);
});

test("chat sends with Enter on desktop and keeps Enter as a newline on phones", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
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
    const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
    const lifecycle = fs.readFileSync(require.resolve("../assets/web-app/messages/lifecycle.js"), "utf8");
    assert.match(client, /rememberOutgoing\(request\.taskId, optimistic\);/u);
    assert.match(client, /const queuesOptimistically = request\.followUpMode === "queue"/u);
    assert.match(client, /optimisticDeferredClientUserMessageIds\.add\(request\.requestId\)/u);
  assert.match(client, /\.\.\.deliveryPatch\(queuesOptimistically \? "sending" : steersOptimistically \? "steering" : "preparing"\)/u);
  assert.match(client, /delivery: "Отправляется…"/u);
  assert.match(client, /clientUserMessageId: request\.requestId/u);
  assert.match(client, /reconcileMessageLifecycle\(serverMessages, outgoing\)/u);
  assert.match(client, /if \(!matchedIds\.has\(message\.clientUserMessageId\)\) result\.push\(message\)/u);
  assert.match(client, /confirmedOutgoingMessageIds\(durableMessages, outgoing\)/u);
  assert.match(client, /for \(const clientUserMessageId of confirmedMatchedIds\) pending\.delete\(clientUserMessageId\)/u);
  assert.match(client, /function promoteLiveCompletion\(taskIdValue, selected, incomingTurnId/u);
  assert.match(client, /completionOverlaysByTask\.set\(taskIdValue, overlays\)/u);
  assert.match(client, /completedConversationTurnVisible\(durableMessages/u);
  assert.match(client, /const visible = visibleConversationMessages\(result\.map\(normalizedUserMessage\)/u);
  assert.match(client, /chronologicalMessages\(projectCanonicalMessages\(visible\)\)/u);
  assert.match(lifecycle, /historicalAgentResponseVisible\(item\)/u);
  assert.match(client, /historyOrder:\s*\(historyStart \+ itemIndex\) \* 1_000 \+ messageIndex/u);
});

test("chat short-polls commands and skips only unchanged loaded history renders", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /const REMOTE_WAIT_MS = 0;/u);
  assert.match(client, /control\/result\?id=.*waitMs=.*REMOTE_WAIT_MS[\s\S]*REMOTE_RESULT_FALLBACK_POLL_MS/su);
  assert.doesNotMatch(client, /REMOTE_RESULT_LONG_POLL_MS/u);
  assert.match(client, /async function probeSnapshotTransport\(\)[\s\S]*method: "HEAD"/u);
  assert.match(client, /vscode \? probeVscodeRuntimeHealth\(\) : probeSnapshotTransport\(\)/u);
  assert.match(client, /control\(\s*"snapshot",\s*window\.AgentHubSnapshotTransport\.requestParams\(lastSnapshot\),\s*\)/u);
  assert.match(client, /window\.AgentHubSnapshotTransport\.materialize\(lastSnapshot, snapshotResult\)/u);
  assert.match(client, /applySnapshot\(snapshot, \{ materialized: true \}\)/u);
  assert.match(client, /if \(!materialized\) snapshot = window\.AgentHubSnapshotTransport\.materialize/u);
  assert.equal((client.match(/applySnapshotConnection\(snapshot\);/gu) ?? []).length, 2);
  assert.match(client, /window\.AgentHubSnapshotTransport\.isBaselineError\(error\)/u);
  assert.match(client, /window\.AgentHubSnapshotTransport\.requestParams\(null\)/u);
  assert.match(app, /setMessages\(taskId, messages\) \{[\s\S]*state\.messages\.has\(taskId\) && sameData\(state\.messages\.get\(taskId\), next\)[\s\S]*return/u);
  assert.match(app, /setMessagesPreservingScroll\(taskId, messages\) \{[\s\S]*const previous = state\.messages\.get\(taskId\) \?\? \[\][\s\S]*state\.messages\.has\(taskId\) && sameData\(previous, next\)[\s\S]*return/u);
  assert.match(app, /function taskNavigationData\(task\)[\s\S]*lastActivity: task\.running \? task\.startedAt/u);
  assert.match(app, /const navigationChangedIds = changedTaskIds\(previousTasks, nextTasks, taskNavigationData\)/u);
  assert.match(app, /state\.visibleStreamTaskIds\.includes\(task\.id\)[\s\S]*chatChangedIds\.has\(task\.id\)/u);
  assert.match(app, /setConnection\(status, details = \{\}\)[\s\S]*if \(unchanged\) return;[\s\S]*renderConnectionQuality\(\)/u);
  assert.match(app, /setServerStatus\(payload\)[\s\S]*root\.dataset\.view === "server"/u);
});

test("Sync controls use the shared text dialog in VS Code webviews", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.doesNotMatch(app, /window\.prompt/u);
  assert.match(app, /await askText\(\{ title: "Никнейм этого устройства для Sync"/u);
  assert.match(app, /await askText\(\{ title: "Код подключения Sync для другого устройства"/u);
  assert.match(app, /await askText\(\{ title: "Введите код подключения Sync"/u);
});

  test("dispatching deferred messages leave the queue and reappear in the active conversation", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(app, /\.filter\(\(entry\) => entry\.state !== "dispatching" && entry\.state !== "steering"\)/u);
  assert.match(app, /Date\.parse\(left\.createdAt \|\| 0\)/u);
    assert.match(
      client,
      /function deferredEntriesForTask[\s\S]*item\.state !== "dispatching"[\s\S]*item\.state !== "steering"/u,
    );
    assert.match(client, /deferred\.state === "dispatching" \|\| deferred\.state === "steering"\s*\?\s*"sending"/u);
});

test("message attachments keep timestamps, previews and an explicit open action", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const extension = fs.readFileSync(require.resolve("./extension.js"), "utf8");
  assert.match(client, /time:\s*message\.time \?\?/u);
  assert.match(client, /attachments:\s*attachmentViews\(message\.attachments\)/u);
  assert.match(client, /agentHub\.on\("attachment:open"/u);
  assert.match(app, /emit\("attachment:open",\s*\{\s*attachment:\s*item,\s*gallery,\s*index:/u);
  assert.match(extension, /decorateAttachmentUrls/u);
  assert.match(extension, /\["open-attachment", "copy-attachment", "save-attachment"\]\.includes\(action\)/u);
  assert.match(app, /Файл недоступен/u);
  assert.match(app, /disabled:\s*missing/u);
  assert.match(app, /\(!source && !item\.id\)/u);
  assert.match(client, /control\("open-attachment", \{ id \}\)/u);
  assert.match(client, /agentHub\.openAttachmentViewer/u);
  assert.match(client, /agentHub\.on\("attachment:load"/u);
  assert.match(html, /data-resource-context-menu[\s\S]*data-resource-action="open"[\s\S]*data-resource-action="copy"[\s\S]*data-resource-action="save"/u);
  assert.match(client, /agentHub\.on\("resource:copy"[\s\S]*agentHub\.on\("resource:save"/u);
  assert.match(client, /value\.url = `\/api\/message-attachment\/\$\{encodeURIComponent\(id\)\}`/u);
  assert.doesNotMatch(client, /window\.open\(url, "_blank"/u);
});

test("background navigation is empty and settings expose the bug report flow", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(html, /data-view-button="background"[\s\S]*?<span>Ничё<\/span>/u);
  assert.match(html, /<main class="background-view" data-background-view aria-label="Фон"><\/main>/u);
  assert.match(html, /data-bug-report-toggle[\s\S]*data-phosphor-icon="bug"[\s\S]*Сообщить о баге\./u);
  assert.match(html, /<input[^>]*multiple[^>]*data-bug-report-files/u);
  assert.match(html, /Скриншот можно вставить из буфера: Ctrl\+V\./u);
  assert.match(app, /document\.addEventListener\("paste"/u);
  assert.match(app, /event\.clipboardData\?\.items/u);
  assert.match(app, /item\.getAsFile\(\)/u);
  assert.match(app, /void readBugReportFiles\(screenshots\)/u);
  assert.match(app, /emit\("bug-report:submit"/u);
  assert.match(client, /control\("submit-bug-report"/u);
  assert.match(app, /if \(bugReportForm\) bugReportForm\.hidden = next\.formHidden/u);
  assert.match(app, /bugReportToggle\?\.setAttribute\("aria-expanded", String\(next\.expanded\)\)/u);
  assert.match(client, /LONG_CONTROL_ACTIONS = new Set\(\["rotate-stream", "submit-bug-report"\]\)/u);
  assert.match(client, /LONG_CONTROL_ACTIONS\.has\(action\) \? LONG_CONTROL_TIMEOUT_MS/u);
});

test("Codex file citations render as compact local links", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(app, /function codexFileCitation\(raw\)/u);
  assert.match(app, /token\.startsWith\(":codex-file-citation\{"\)/u);
  assert.match(app, /link\.dataset\.agentHubLocalLink = targetLink\.localPath/u);
  assert.match(styles, /\.file-citation\s*\{/u);
});

test("composer accepts documents and renders downloadable file cards", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(html, /data-file-input/u);
  assert.doesNotMatch(html, /data-file-input[^>]*accept=["']image\/\*/u);
  assert.match(app, /async function readAttachmentFiles\(files\)/u);
  assert.match(app, /file\.size <= 20 \* 1024 \* 1024/u);
  assert.match(app, /attachment-file-card/u);
  assert.match(client, /X-Agent-Hub-File-Name/u);
  assert.match(client, /async function saveBlob\(blob, name\)/u);
  assert.match(client, /downloadBlob\(blob, name\)/u);
});

test("mobile navigation backs out from image to chat and from chat to tasks", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const android = fs.readFileSync(
    require.resolve("../AndroidApp/app/src/main/java/app/agenthub/mobile/MainActivity.java"),
    "utf8",
  );
  assert.match(html, /data-attachment-viewer[\s\S]*data-attachment-viewer-close/u);
  assert.match(html, /data-attachment-viewer-previous[\s\S]*data-attachment-viewer-next/u);
  assert.match(app, /function navigateBack\(\)[\s\S]*closeAttachmentViewer\(\)[\s\S]*setPane\("tasks"\)/u);
  assert.match(app, /event\.key === "ArrowLeft"[\s\S]*event\.key === "ArrowRight"/u);
  assert.match(app, /dx < EDGE_SWIPE_DISTANCE[\s\S]*navigateBack\(\);/u);
  assert.match(android, /window\.AgentHub\.navigateBack/u);
});

test("annotation actions preserve native selection and keep per-quote comments", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const android = fs.readFileSync(
    require.resolve("../AndroidApp/app/src/main/java/app/agenthub/mobile/MainActivity.java"),
    "utf8",
  );
  assert.doesNotMatch(html, /data-action="annotate"/u);
  assert.match(app, /showToast\("Выделите фрагмент сообщения или рассуждения\."\)/u);
  assert.match(html, /data-annotation-context-menu[\s\S]*Цитировать выделение/u);
  assert.match(app, /function addAnnotation\(value\)/u);
  assert.match(app, /data-annotation-comment-index/u);
  assert.match(app, /pointer: coarse/u);
  assert.match(app, /function handleAnnotationContextMenu\(event\)[\s\S]*openAnnotationContextMenu\(event, quote\)/u);
  assert.match(app, /document\.addEventListener\("contextmenu", handleAnnotationContextMenu, \{ capture: true \}\)/u);
  assert.match(app, /selectedQuotableSelection\(\)\?\.quote \|\| lastAnnotationSelection\?\.quote/u);
  assert.match(android, /MENU_ANNOTATE_SELECTION[\s\S]*"Цитировать"/u);
  assert.match(android, /SHOW_AS_ACTION_ALWAYS \| MenuItem\.SHOW_AS_ACTION_WITH_TEXT/u);
  assert.match(android, /ActionMode\.Callback2[\s\S]*onGetContentRect/u);
});

test("lost command results reconcile by durable message receipt without duplicate draft", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /function applyMessageReceipts\(snapshot\)[\s\S]*agentHub\.completeSend\(clientUserMessageId, \{ accepted \}\)/u);
  assert.match(client, /const rejected = messageSendDefinitelyRejected\(error\)[\s\S]*deliveryPatch\(rejected \? "rejected" : "unconfirmed"\)/u);
});

test("queue actions are single-flight and steer uses the dedicated server action", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(app, /case "queue-steer":[\s\S]*emit\("queue:steer"/u);
  assert.match(app, /entry\.optimistic[\s\S]*queue-optimistic"[\s\S]*entry\.delivery[\s\S]*Ожидает подтверждения Hub/u);
  assert.match(client, /queueActionsInFlight\.has\(key\)/u);
  assert.match(client, /optimisticQueueSteerIds\.add[\s\S]*deliveryPatch\("steering"\)[\s\S]*renderTaskQueue/u);
  assert.match(client, /control\("deferred-input", \{ id, action: "steer" \}\)/u);
});

test("journal preserves recursive subagent trees in date and task groupings", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  const workLogStyles = fs.readFileSync(require.resolve("../work-log.css"), "utf8");
  assert.match(app, /function isRootTurnEntry\(entry\)/u);
  assert.match(app, /if \(isRootTurnEntry\(entry\)\) group\.turns\.push/u);
  assert.match(styles, /\.journal div\[data-work-log-turn-children\]/u);
  assert.match(workLogStyles, /div\[data-work-log-turn-children\]/u);
  assert.match(app, /subagents: \[\.\.\.journal\.querySelectorAll\("details\[data-work-log-turn-children-details\]\[open\]"\)\]/u);
  assert.match(app, /openState\.subagents \?\? \[\]/u);
  assert.match(app, /collapseAllButton\.addEventListener\("click",[\s\S]*querySelectorAll\("details\[open\]"\)/u);
  assert.match(styles, /details\[data-work-log-turn-children-details\] > summary/u);
  assert.match(workLogStyles, /details\[data-work-log-turn-children-details\] > summary/u);
});

test("response annotations render as quote cards without the service envelope", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  const lifecycle = fs.readFileSync(require.resolve("../assets/web-app/messages/lifecycle.js"), "utf8");
  assert.match(lifecycle, /function embeddedResponseAnnotations\(value\)/u);
  assert.match(lifecycle, /text: embedded \|\| annotations\.length \? request/u);
  assert.match(client, /responseAnnotations: message\.responseAnnotations/u);
  assert.match(client, /return responseAnnotationPrompt\(text, annotations\);/u);
  assert.match(app, /function renderResponseAnnotations\(body, message\)/u);
  assert.match(app, /class: "msg-annotation-quote"/u);
  assert.match(app, /class: "msg-annotation-request"/u);
  assert.match(styles, /\.msg-annotation-content\s*\{[^}]*border-left:\s*3px solid var\(--accent-line\);/su);
});

test("focused journal turn reuses the task thread without duplicating its prompt", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /!focusedTurnAlreadyVisible\(history, messages, focusedTurn\)/u);
  assert.match(client, /const focusedThreadId = focusedTurnTaskThreadId\(focusedTurn\)/u);
  assert.doesNotMatch(
    client,
    /message\.threadId === \(focusedTurn\.turnThreadId \?\? focusedTurn\.taskThreadId\)/u,
  );
});

test("desktop settings stay available with the mobile composer layout", () => {
  const html = fs.readFileSync(
    require.resolve("../assets/web-app/index.html"),
    "utf8",
  );
  const styles = fs.readFileSync(
    require.resolve("../assets/web-app/styles.css"),
    "utf8",
  );
  assert.match(html, /data-panel-open="settings"[^>]*aria-label="Настройки Agent Hub"/su);
  assert.doesNotMatch(html, /view-settings-label/u);
  assert.match(
    styles,
    /html\[data-surface="mobile"\] \.composer-send\s*\{[^}]*grid-column:\s*-2 \/ -1;[^}]*justify-self:\s*end;/su,
  );
});

test("Telegram mobile chat disables the host vertical collapse gesture", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(app, /telegram\?\.expand\(\);\s*telegram\?\.disableVerticalSwipes\?\.\(\);/u);
});

test("composer drafts survive mobile navigation, reconnects and WebView recreation", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(app, /const DRAFT_STORAGE_VERSION = "agent-hub:composer-drafts:v1";/u);
  assert.match(app, /function draftStorageSurface\(\)[\s\S]*window\.AgentHubAndroid[\s\S]*return "android";/u);
  assert.match(app, /function restorePersistedDrafts\(\)[\s\S]*localStorage\.getItem\(draftStorageKey\(\)\)/u);
  assert.match(app, /function persistDrafts\(\)[\s\S]*localStorage\.setItem\(draftStorageKey\(\), JSON\.stringify\(persisted\)\)/u);
  assert.match(app, /function saveDraft\(\)[\s\S]*persistDrafts\(\);/u);
  assert.match(app, /restorePersistedDrafts\(\);[\s\S]*pagehide[\s\S]*saveDraft\(\);/u);
  assert.match(app, /visibilitychange[\s\S]*document\.visibilityState === "hidden"[\s\S]*saveDraft\(\)/u);
});

test("left-edge swipe uses in-app back and prevents browser history navigation", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(app, /const EDGE_SWIPE_ZONE = 32;/u);
  assert.match(app, /fromLeftEdge: touch\.clientX <= EDGE_SWIPE_ZONE/u);
  assert.match(app, /\.markdown-table-scroll/u);
  assert.match(app, /touchmove[\s\S]*swipeStart\?\.fromLeftEdge[\s\S]*event\.preventDefault\(\)/u);
  assert.match(app, /if \(!fromLeftEdge \|\| dx < EDGE_SWIPE_DISTANCE[\s\S]*navigateBack\(\);/u);
  assert.match(app, /function navigateBack\(\) \{\s*saveDraft\(\);[\s\S]*root\.dataset\.view !== "chat"[\s\S]*setPane\("tasks"\)/u);
});

test("task list no longer exposes legacy Project groups", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.doesNotMatch(app, /const hasProject = visible\.some/u);
  assert.doesNotMatch(app, /function renderTaskProjectGroup\(/u);
  assert.doesNotMatch(styles, /\.task-project-heading\s*\{/u);
});

test("new Workspace Thread becomes the selected chat before its title is applied", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /control\("new-task"[\s\S]*const created = \(snapshot\.tasks \?\? \[\]\)\.find\(\(task\) => task\.selected\)/u);
  assert.match(client, /workspaceName: title \|\| undefined/u);
  assert.match(client, /pendingSelectionId = taskId\(created\.provider, created\.threadId, created\.streamId\)/u);
  assert.match(client, /agentHub\.showSelectedTask\(\)/u);
  assert.match(app, /showSelectedTask\(\) \{\s*setView\("chat"\);\s*setPane\("chat"\);/u);
  assert.match(client, /replaceRoute\(`#\/chat\//u);
});

test("metropolis uses square pixel rain cells on mobile", () => {
  const shader = fs.readFileSync(
    require.resolve("../assets/web-app/themes/metropolis/metropolis-glass.js"),
    "utf8",
  );
  assert.match(shader, /cell:\s*\[0, 112\]/u);
  assert.match(shader, /uCellPx > 0\.5[\s\S]*uv0 \* \(uViewport \/ uCellPx\)/u);
  assert.doesNotMatch(shader, /smoothstep\(0\.03, 0\.02/u);
  assert.doesNotMatch(shader, /smoothstep\(0\.02, 0\.015/u);
  assert.doesNotMatch(shader, /smoothstep\(0\.5, y/u);
  assert.doesNotMatch(shader, /smoothstep\(0\.026, 0\.012/u);
  assert.match(shader, /1\.0 - smoothstep\(0\.02, 0\.03, length\(dropPosition\)\)/u);
  assert.match(shader, /1\.0 - smoothstep\(y, 0\.5, cellUv\.y\)/u);
});

test("chat loads older pages from a button and a cancellable mobile pull gesture", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(html, /data-history-loader[\s\S]*data-history-load/u);
  assert.match(app, /const HISTORY_PULL_THRESHOLD = 84;/u);
  assert.match(app, /touchmove[\s\S]*historyPull\.armed = damped >= HISTORY_PULL_THRESHOLD/u);
  assert.match(app, /touchend[\s\S]*if \(shouldLoad\) requestOlderHistory\(\)/u);
  assert.match(app, /emit\("history:load-older", \{ taskId: state\.selectedId \}\)/u);
  assert.match(app, /function captureChatAnchor\(\)[\s\S]*function restoreChatAnchor\(anchor\)/u);
  assert.match(client, /const requestedBefore = Number\(page\.nextBefore\)[\s\S]*control\("task-history", \{[\s\S]*before: requestedBefore,[\s\S]*limit: 20/u);
  assert.match(client, /returnedEnd > requestedBefore[\s\S]*returnedStart >= requestedBefore/u);
  assert.match(client, /prependOlderHistory[\s\S]*preserveScroll: true/u);
  assert.match(styles, /html\[data-surface="mobile"\] \.chat-history-loader\[data-pulling\]/u);
});

test("chat keeps an active response only in the live card after task switching", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const lifecycle = fs.readFileSync(require.resolve("../assets/web-app/messages/lifecycle.js"), "utf8");
  assert.match(
    lifecycle,
    /function visibleConversationMessages\(messages,[\s\S]*const liveTurnRole = identityKey\(liveProbe, \{ withoutItem: true \}\);[\s\S]*identityKey\(message, \{ withoutItem: true \}\) !== liveTurnRole/u,
  );
  assert.match(client, /liveProbeByTask\.set\(taskIdValue, nextProbe\)/u);
  assert.match(client, /liveProbe: liveProbeByTask\.get\(taskIdValue\) \?\? null/u);
  assert.match(client, /text: response/u);
  assert.match(app, /function liveCardHasContent\(live\)[\s\S]*normalizedMessageText\(live\.stage\)/u);
  assert.match(
    app,
    /setMessages\(taskId, messages\)[\s\S]*renderMessages\(\{ preserveTop: true \}\);\s*renderLive\(\);/u,
  );
});

test("active commentary stays live while interrupted commentary remains in history", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const lifecycle = fs.readFileSync(require.resolve("../assets/web-app/messages/lifecycle.js"), "utf8");
  assert.match(
    lifecycle,
    /const visibleAgent = historicalAgentResponseVisible\(item\)[\s\S]*\?\s*parentAgents\.findLast[\s\S]*:\s*null;/u,
  );
  assert.match(lifecycle, /historicalAgentResponseVisible\(item\) && String\(item\?\.answer/u);
  assert.match(
    lifecycle,
    /function historicalAgentResponseVisible\(turn\) \{\s*return turn\?\.completed === true \|\| turn\?\.active !== true;/u,
  );
});

test("manual context compaction reports completion and stays on the fast refresh loop", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(client, /requestedContextCompactions/u);
  assert.match(client, /Свёртка завершена успешно/u);
  assert.match(client, /Началась автосвёртка контекста/u);
  assert.match(client, /Свёртка контекста…/u);
  assert.match(client, /Автосвёртка контекста…/u);
  assert.match(client, /Замер контекста…/u);
  assert.match(client, /Ротация контекста…/u);
  assert.match(client, /activeMaintenanceByTask/u);
  assert.match(client, /rememberMaintenanceEvent/u);
  assert.match(client, /task\.running \|\| task\.context\?\.compacting \|\| task\.maintenance/u);
  assert.match(app, /message\.kind === "maintenance"/u);
  assert.match(styles, /\.msg-maintenance \.msg-body/u);
  assert.match(app, /contextLabel\.textContent = context\.compacting[\s\S]*\? "свёртка…"[\s\S]*context\.usagePending \? "обновление…"/u);
  assert.match(app, /context\.compaction\?\.stage === "cleaning-images"/u);
  assert.match(app, /Удаляются дубликаты изображений/u);
  assert.match(app, /toggleAttribute\("data-compacting"/u);
  assert.match(styles, /context-compaction-spin/u);
});

test("live reasoning renders Markdown separately from the response", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  assert.match(html, /data-live-reasoning/u);
  assert.match(html, /data-live-body/u);
  assert.match(app, /const reasoning = node\.querySelector\("\[data-live-reasoning\]"\);/u);
  assert.match(app, /const body = node\.querySelector\("\[data-live-body\]"\);/u);
});

test("shared chat Markdown renders GFM tables responsively", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(app, /function markdownTableCells\(line\)/u);
  assert.match(app, /\^:\?-\{3,\}:\?\$/u);
  assert.match(app, /el\("table", \{ class: "markdown-table" \}/u);
  assert.match(styles, /\.markdown-table-scroll[\s\S]*overflow-x: auto;/u);
  assert.match(styles, /\.markdown-table[\s\S]*border-collapse: collapse;/u);
  assert.match(styles, /\.markdown-table[\s\S]*table-layout: fixed;[\s\S]*width: 100%;/u);
  assert.match(styles, /\.markdown-table th,[\s\S]*overflow-wrap: anywhere;/u);
  assert.match(styles, /\.markdown-table tr > :first-child:nth-last-child\(2\)[\s\S]*width: clamp\(9rem, 30%, 18rem\);/u);
});

test("active chat input stays in the manual queue until an explicit action", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const lifecycle = fs.readFileSync(require.resolve("../assets/web-app/messages/lifecycle.js"), "utf8");
  assert.match(app, /const entryAnnotations = Array\.isArray\(entry\.annotations\)/u);
  assert.match(app, /class: "queue-annotation-quote"/u);
  assert.match(app, /class: "queue-annotation-comment"/u);
  assert.match(app, /\(entryAnnotations\.length && annotationEnvelope\.test\(rawText\)\)/u);
  assert.match(app, /data-action": "queue-steer"/u);
  assert.match(app, /data-action": "queue-edit"/u);
  assert.match(app, /followUpMode: MessageView\.composerFollowUpMode\(task, \{ steerWhileRunning \}\)/u);
  assert.match(app, /deferWhileRunning: task\?\.running === true && !steerWhileRunning/u);
  assert.doesNotMatch(app, /followUpModeButton|renderFollowUpMode|Изменить ход/u);
  assert.doesNotMatch(html, /data-follow-up-mode/u);
  assert.match(client, /control\("deferred-input", \{ id, action: "queue" \}\)/u);
  assert.match(client, /control\("deferred-input", \{ id, action: "steer" \}\)/u);
  assert.match(client, /control\("deferred-input", \{ id, action: "edit", text \}\)/u);
  assert.match(client, /request\.deferWhileRunning === true/u);
  assert.match(client, /deferredClientUserMessageIds = new Set\(/u);
  assert.doesNotMatch(client, /if \(result\?\.duplicate\)[\s\S]*outgoingMessages\(request\.taskId\)\.delete/u);
  assert.match(client, /function optimisticDeferredEntries\(taskIdValue, serverEntries = \[\]\)/u);
  assert.match(client, /mergeDeferredQueueEntries\(\s*serverEntries,/u);
  assert.match(lifecycle, /function mergeDeferredQueueEntries\(serverEntries, clientEntries\)/u);
  assert.doesNotMatch(
    lifecycle,
    /message\?\.role === "user"[\s\S]*deferredIds\.has\(String\(message\?\.clientUserMessageId/u,
  );
});

test("composer restores definite rejection but keeps an ambiguous delivery single", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const connectionBanner = fs.readFileSync(
    require.resolve("../assets/web-app/connection-banner.js"),
    "utf8",
  );
  const submit = app.match(
    /function submitComposer\(\{ steerWhileRunning = false \} = \{\}\) \{(?<body>[\s\S]*?)\n\}/u,
  )?.groups?.body ?? "";
  assert.match(submit, /composerInput\.value = ""[\s\S]*emit\("message:send"/u);
  assert.match(app, /function completeComposerSend\(requestId, accepted\)/u);
  assert.match(app, /if \(accepted\)[\s\S]*else \{[\s\S]*text: pending\.rawText/u);
  assert.match(app, /const retryComposerRequests = new Map\(\)/u);
  assert.match(app, /const requestId = retry\?\.fingerprint === fingerprint[\s\S]*retry\.requestId/u);
  assert.match(app, /retryComposerRequests\.set\(pending\.taskId,[\s\S]*requestId: pending\.requestId/u);
  assert.match(client, /agentHub\.completeSend\(request\.requestId/u);
  assert.match(client, /reusableAttachmentPaths\([\s\S]*\{ remote: !vscode \}/u);
  assert.match(client, /if \(isConnectionFailure\(error\)\) recordTransientConnectionFailure/u);
  assert.match(client, /const rejected = messageSendDefinitelyRejected\(error\)/u);
  assert.match(client, /deliveryPatch\(rejected \? "rejected" : "unconfirmed"\)/u);
  assert.match(client, /AgentHubConnectionBanner\.snapshotConnectionState\(snapshot, idleStatus\)/u);
  assert.match(connectionBanner, /snapshot\?\.restartWaiting === true \|\| blockingCount > 0/u);
  assert.match(html, /data-restart-banner/u);
  assert.match(connectionBanner, /Agent Hub ожидает завершения блокирующей работы: \$\{count\}\./u);
  assert.match(app, /restarting: "Agent Hub перезапускается…"/u);
  assert.match(app, /offline: "Нет связи с Agent Hub\."/u);
  assert.doesNotMatch(
    app,
    /Текст в поле ввода сохранён|Непринятый текст будет восстановлен|Неотправленное сообщение сохранено/u,
  );
});

test("chat retries an initial history load after the connection recovers", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /const historyMissing = Boolean\(previousTask\) && !historyPageByTask\.has\(id\)/u);
  assert.match(client, /historyMissing[\s\S]*enqueueTaskHistoryLoad\(id, identity/u);
});

test("one transient control failure does not mark the whole Hub offline", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /CONNECTION_OFFLINE_FAILURES = 3/u);
  assert.match(client, /CONNECTION_OFFLINE_GRACE_MS = 6_000/u);
  assert.match(client, /function recordTransientConnectionFailure\(\)/u);
  assert.match(client, /transientFailureDecision\(\{[\s\S]*failureCount: connectionFailureCount/u);
  assert.match(client, /if \(decision === "connecting"\) applySnapshotConnection/u);
  assert.match(client, /function applySnapshot\(snapshot, \{ materialized = false \} = \{\}\)[\s\S]*resetConnectionFailures\(\)/u);
  assert.doesNotMatch(client, /catch \(error\) \{\s*if \(isConnectionFailure\(error\)\) applySnapshotConnection/u);
});

test("chat keeps refreshing until the ready answer reaches task history", () => {
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(client, /function updateHistoryCatchUp\(taskIdValue, history, task\)/u);
  assert.match(
    client,
    /historyContainsLatestAnswer\(history, task, \{\s*expectedTurnId: historyCatchUpTurnIds\.get\(taskIdValue\),\s*\}\)/u,
  );
  assert.match(client, /refreshCaughtUpHistory/u);
  assert.match(client, /\|\| historyNeedsCatchUp\(selectedTaskId\)/u);
  assert.doesNotMatch(client, /\n\s*markAnswerSeen\(task\);\n\}/u);
});

test("current limits live in settings and statistics instead of the compact header", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.doesNotMatch(html, /data-rate-limits-slot/u);
  assert.equal(html.match(/data-current-limits=/gu)?.length, 2);
  assert.match(html, /data-current-limits="statistics"/u);
  assert.match(html, /data-current-limits="settings"/u);
  assert.match(app, /function currentLimitSeries\(payload\)/u);
  assert.match(app, /return selectCurrentLimitSeries\(payload\);/u);
  assert.match(app, /journal\.querySelector\("\[data-work-log-rate-limits\]"\)\?\.remove\(\)/u);
});

test("server navigation uses a readable rack icon instead of a CPU", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  assert.match(
    html,
    /data-view-button="server"[\s\S]*?data-phosphor-icon="hard-drives"[\s\S]*?<span>Сервер<\/span>/u,
  );
});

test("statistics page offers local usage and full limit history", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(html, /data-view-button="statistics"/u);
  assert.match(html, /data-usage-chart/u);
  assert.match(html, /data-limits-chart/u);
  assert.match(html, /data-limits-mode="usage"/u);
  assert.match(html, /data-limits-mode="speed"/u);
  assert.match(html, /data-limits-speed-note/u);
  assert.match(html, /data-limits-speed-summary/u);
  assert.match(app, /function limitsSpeedPath\(/u);
  assert.match(app, /снизьте темп/u);
  assert.match(app, /Ровный темп · 14,3%\/сутки/u);
  assert.match(app, /Ровный темп · 0,6%\/час/u);
  assert.match(app, /function burnRatePolicyForRange\(/u);
  assert.match(styles, /\.limits-burn-normal-line/u);
  for (const range of ["6h", "24h", "7d", "15d", "30d", "all"]) {
    assert.match(html, new RegExp(`data-range="${range}"`, "u"));
  }
  assert.equal(html.match(/data-range="15d"/gu)?.length, 3);
  assert.match(html, /data-limits-credits/u);
  assert.match(app, /resetCredits/u);
  assert.match(app, /availableCount/u);
  assert.match(app, /nearestExpiresAt/u);
  assert.match(app, /emit\("usage:open", \{ range: usageState\.range, accountKey, turnTimeMode \}\)/u);
  assert.match(app, /function formatUsageValue\(credits, unit = usageUnit\)/u);
  assert.match(app, /const LIMITS_MODE_KEY = "agent-hub-limits-mode-v1";/u);
  assert.match(app, /function weeklyBurnRatePoints\(series,/u);
  assert.match(app, /Math\.max\(0, point\.remainingPercent\) \/ remainingMs \* WEEK_MILLISECONDS/u);
  assert.match(app, /class: `limits-burn-rate-segment \$\{right\.overTarget/u);
  assert.match(styles, /\.limits-burn-rate-segment\.is-over-target\s*\{[^}]*stroke:\s*var\(--danger/su);
  assert.match(styles, /\.limits-burn-rate-segment\.is-safe\s*\{[^}]*stroke:\s*var\(--ok\);/su);
  assert.match(client, /readHistoryWithRangeCompatibility\("usage-history", range, \{\s*maxPoints: 600,\s*accountKey: String\(accountKey \|\| ""\),\s*turnTimeMode,/u);
  assert.match(client, /function trimHistoryToFifteenDays\(payload\)/u);
  assert.match(styles, /\.current-limits-row\s*\{[^}]*flex-wrap:\s*nowrap;/su);
  assert.match(styles, /\.current-limits-row\s*\{[^}]*overflow-x:\s*auto;/su);
});

test("settings choose one turn timestamp for every local usage chart", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  for (const mode of ["start", "middle", "end"]) {
    assert.match(html, new RegExp(`data-turn-time-mode="${mode}"`, "u"));
  }
  assert.match(app, /TURN_TIME_MODE_KEY = "agent-hub:turn-time-mode:v1"/u);
  assert.match(app, /requestUsageHistory\(usageState\.range, \{ force: true \}\)/u);
  assert.match(app, /requestUsageComparison\(comparisonState\.range, \{ force: true \}\)/u);
  assert.match(client, /agentHub\.on\("comparison:open", \(\{ range, seriesId, accountKey, turnTimeMode \}\)/u);
  assert.match(styles, /\.turn-time-options\s*\{[^}]*repeat\(3,/su);
});

test("statistics compares one independently selected limit and tracks its price", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(html, /id="comparison-chart-title">Корреляция расхода</u);
  assert.match(html, /data-comparison-chart role="img"/u);
  assert.match(html, /r — корреляция Пирсона,[\s\S]*?цена — расход лимита в п\.п\. на 1 kcr/u);
  assert.match(app, /function pearsonCorrelation\(left, right\)/u);
  assert.match(app, /agent-hub:comparison-series:v2/u);
  assert.equal((html.match(/data-statistics-account-select/gu) ?? []).length, 2);
  assert.match(app, /function selectStatisticsAccount\(accountKey\)/u);
  assert.match(app, /function comparisonLimitPrice\(localValues, apiValues, buckets\)/u);
  assert.match(app, /function selectComparisonSeries\(id\)/u);
  assert.match(app, /function comparisonSeriesPicker\(model\)/u);
  assert.match(app, /"data-comparison-series-select": ""/u);
  assert.match(app, /select\.addEventListener\("change", \(\) => selectComparisonSeries\(select\.value\)\)/u);
  assert.match(
    app,
    /const entries = \[\s*comparisonSeriesPicker\(model\),\s*comparisonLegendItem\("Учётный расход"/u,
  );
  assert.match(app, /seriesId: comparisonState\.seriesId/u);
  assert.match(app, /class: "comparison-deviation-line"/u);
  assert.match(app, /class: "comparison-cost-line"/u);
  assert.match(app, /class: "comparison-local-line"/u);
  assert.match(app, /class: "limits-series-line comparison-api-line"/u);
  const limitsToggle = app.slice(
    app.indexOf("function toggleSeriesVisibility(id)"),
    app.indexOf("function clampNumber", app.indexOf("function toggleSeriesVisibility(id)")),
  );
  assert.doesNotMatch(limitsToggle, /renderUsageComparison/u);
  const comparisonModel = app.slice(
    app.indexOf("function buildUsageComparisonModel(payload)"),
    app.indexOf("function comparisonPath", app.indexOf("function buildUsageComparisonModel(payload)")),
  );
  assert.doesNotMatch(comparisonModel, /limitsState\.hidden/u);
  const comparisonChart = app.slice(
    app.indexOf("function buildUsageComparisonChart(model)"),
    app.indexOf("function comparisonUsageUnitLabel", app.indexOf("function buildUsageComparisonChart(model)")),
  );
  assert.doesNotMatch(comparisonChart, /svgEl\("rect"/u);
  assert.match(client, /agentHub\.on\("comparison:open"/u);
  assert.match(client, /const resolvedAccountKey = allAccounts[\s\S]*?limits\?\.currentAccount\?\.key/u);
  assert.match(client, /const provider = "codex"/u);
  assert.match(client, /readHistoryWithRangeCompatibility\("usage-history", requestedRange, \{[\s\S]*?provider,[\s\S]*?accountKey: allAccounts \? "" : resolvedAccountKey/u);
  assert.match(client, /agentHub\.setUsageComparison\(\{/u);
  assert.match(app, /data-statistics-account-select/u);
  assert.match(app, /ALL_STATISTICS_ACCOUNTS = "all"/u);
  assert.match(app, /text: "Все"/u);
  assert.match(app, /function statisticsSeriesPoints/u);
  assert.match(app, /accountKey: resolvedStatisticsAccountKey\(\)/u);
  assert.match(styles, /\.comparison-local-line\s*\{[^}]*stroke:\s*var\(--comparison-local\);/su);
  assert.match(styles, /\.comparison-deviation-line\s*\{[^}]*stroke:\s*var\(--comparison-deviation\);/su);
  assert.match(styles, /\.comparison-cost-line\s*\{[^}]*stroke:\s*var\(--comparison-cost\);/su);
  assert.match(styles, /\.comparison-series-picker\s*\{[^}]*border-radius:\s*var\(--radius-chip\);/su);
  assert.doesNotMatch(app, /class: `limits-legend-toggle\$\{selected/u);
});

test("statistics switches between combined and split comparison charts", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(html, /data-comparison-view-mode="combined"[^>]*>Общая</u);
  assert.match(html, /data-comparison-view-mode="split"[^>]*>Раздельно</u);
  assert.match(html, /data-comparison-local-chart[\s\S]*?data-comparison-api-chart/u);
  assert.match(html, /data-comparison-scatter-chart[\s\S]*?data-comparison-difference-chart/u);
  assert.match(app, /COMPARISON_VIEW_MODE_KEY = "agent-hub:comparison-view-mode:v1"/u);
  assert.match(app, /function selectComparisonViewMode\(value\)/u);
  assert.match(app, /localStorage\.setItem\(COMPARISON_VIEW_MODE_KEY, next\)/u);
  assert.match(app, /function buildUsageComparisonSplitCharts\(model\)/u);
  assert.match(app, /function buildComparisonScatterChart\(model\)/u);
  assert.match(app, /function buildComparisonDifferenceChart\(model\)/u);
  assert.match(app, /if \(split\) buildUsageComparisonSplitCharts\(model\);\s*else buildUsageComparisonChart\(model\);/u);
  assert.match(styles, /\.comparison-analysis-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/su);
  assert.match(styles, /html\[data-surface="mobile"\] \.comparison-analysis-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/su);
});

test("local usage chart keeps its range and labels every calendar day", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  assert.match(app, /payload\?\.bucket === "day"/u);
  assert.match(app, /usage-axis-day/u);
  assert.match(styles, /\.usage-chart\s*\{[^}]*overflow-x:\s*auto;/su);
});

test("history dialog requests periods via limits:open and renders via setRateLimitHistory", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  assert.match(app, /setRateLimitHistory\(payload\) \{\s*applyRateLimitHistory\(payload\);/u);
  assert.match(app, /emit\("limits:open", \{ range: limitsState\.range \}\)/u);
  assert.match(client, /agentHub\.on\("limits:open", \(\{ range \}\) =>/u);
  assert.match(client, /readHistoryWithRangeCompatibility\([\s\S]*?"rate-limit-history",[\s\S]*?requestedRange,[\s\S]*?maxPointsPerSeries: 600,/u);
  assert.match(client, /payload = await control\(action, \{ \.\.\.params, range: "30d" \}\)/u);
  assert.match(client, /agentHub\.setRateLimitHistory\(\{/u);
  assert.match(client, /window\.setInterval\(\(\) => \{[\s\S]*refreshRateLimitHistory\(\);[\s\S]*5 \* 60_000/u);
  // клавиши − и + шагают по последовательности периодов
  assert.match(app, /event\.key === "-" \|\| event\.key === "_"[\s\S]*stepLimitsRange\(-1\)/u);
  assert.match(app, /event\.key === "\+" \|\| event\.key === "="[\s\S]*stepLimitsRange\(1\)/u);
  assert.match(app, /function stepLimitsRange\(direction\)/u);
});

test("history dialog handles loading, empty and error states", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  for (const slot of ["data-limits-loading", "data-limits-empty", "data-limits-error", "data-limits-retry"]) {
    assert.match(html, new RegExp(slot, "u"));
  }
  assert.match(app, /status !== "loading"/u);
  assert.match(app, /status !== "empty"/u);
  assert.match(app, /status !== "error"/u);
  assert.match(app, /function statusFromPayload\(payload\)/u);
});

test("history chart is drawn with inline SVG and no external dependencies", () => {
  const html = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
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
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
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
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  const scrim = styles.match(/\.limits-scrim\s*\{[^}]*background:\s*rgba\(0,\s*0,\s*0,\s*(?<alpha>[0-9.]+)\)/su);
  assert.ok(scrim, "у .limits-scrim задан чёрный фон с прозрачностью");
  const alpha = Number(scrim.groups.alpha);
  // заметно плотнее прежних 0.5, но фон приложения не исчезает полностью
  assert.ok(alpha >= 0.6 && alpha < 1, `scrim alpha ${alpha} в диапазоне [0.6, 1)`);
});

test("legend series are real toggle buttons with accessible pressed state", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
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
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
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
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  // цвет по индексу в полном списке — скрытие не перекрашивает остальные
  assert.match(app, /const allSeries = rawSeries[\s\S]*color:\s*seriesColor\(item, index\),\s*hidden:/u);
  assert.match(app, /const series = allSeries\.filter\(\(item\) => !item\.hidden\)/u);
  // легенда получает полный список, график — только видимые
  assert.match(app, /return allSeries;/u);
  // скрытие всех серий не ошибка: остаются оси и спокойная подсказка
  assert.match(app, /if \(!series\.length\) \{[\s\S]*class:\s*"limits-empty-plot"[\s\S]*"Все серии скрыты"/u);
});

test("all themes keep the unified raster Agent Hub mark", () => {
  const index = fs.readFileSync(path.join(WEB_APP_ROOT, "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(WEB_APP_ROOT, "styles.css"), "utf8");
  const mark = fs.readFileSync(path.join(WEB_APP_ROOT, "agent-hub-mark.png"));
  assert.match(index, /<img data-app-mark src="\/agent-hub-mark\.png"/u);
  assert.doesNotMatch(index, /<svg data-app-mark/u);
  assert.match(styles, /\.brand-mark\s*\{[\s\S]*background:\s*none !important;[\s\S]*border:\s*0 !important;/u);
  assert.match(styles, /\.brand-mark\s*\{[\s\S]*clip-path:\s*none !important;[\s\S]*rotate:\s*0deg !important;/u);
  assert.match(styles, /\.brand-mark::before,[\s\S]*content:\s*none !important;/u);
  assert.match(styles, /\.brand-mark > img\s*\{[\s\S]*display:\s*block !important;/u);
  assert.equal(mark.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.ok(mark.length > 20_000);
});

test("maintained shells package derivatives of the unified Agent Hub mark", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const androidManifest = fs.readFileSync(path.resolve(__dirname, "..", "AndroidApp", "app", "src", "main", "AndroidManifest.xml"), "utf8");
  const androidIcon = fs.readFileSync(path.resolve(__dirname, "..", "AndroidApp", "app", "src", "main", "res", "drawable-nodpi", "ic_agent_hub.png"));
  assert.equal(packageJson.icon, "media/agent-hub-mark.png");
  assert.equal(packageJson.contributes.viewsContainers.activitybar[0].icon, "media/agent-hub-mark.png");
  assert.match(androidManifest, /android:icon="@drawable\/ic_agent_hub"/u);
  assert.match(androidManifest, /android:roundIcon="@drawable\/ic_agent_hub"/u);
  assert.equal(androidIcon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
});

test("composer pastes arbitrary clipboard files and falls back to the files list", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  assert.match(app, /function clipboardAttachmentFiles\(clipboardData\)/u);
  assert.match(app, /clipboardData\?\.items/u);
  assert.match(app, /clipboardData\?\.files/u);
  assert.match(app, /const values = itemFiles\.length > 0 \? itemFiles :/u);
  assert.match(app, /void readAttachmentFiles\(files\)/u);
});

test("shared shell groups threads under stable Workspace and Stream identities", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");
  const tabsStart = app.indexOf("function renderStreamTabs()");
  const tabsEnd = app.indexOf("function publishVisibleStreamTasks", tabsStart);
  const tabs = app.slice(tabsStart, tabsEnd);

  // Новый фронтенд работает только от канонического streamId.
  assert.match(client, /const streamId = String\(task\.streamId \?\? ""\)\.trim\(\)/u);
  const modelTask = client.match(/function modelTask\([^)]*\) \{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  assert.match(modelTask, /streamId,/u);
  assert.doesNotMatch(modelTask, new RegExp(["hub", "TaskId"].join(""), "u"));

  // Один безымянный поток не показывает искусственный номер; несколько получают Stream N.
  assert.match(app, /function streamDisplayName\(stream, streamCount\)/u);
  assert.match(app, /streamCount > 1 \? `Stream \$\{stream\.ordinal\}` : "Stream"/u);
  // Обычный клик переключает единственную колонку; Ctrl+click держит до четырёх.
  assert.match(app, /normalized = \[selectedInWorkspace \|\| ordered\[0\]\?\.id\]\.filter\(Boolean\)/u);
  assert.match(app, /configuredOpenStreamWorkspaces/u);
  assert.match(app, /function toggleOpenStream\(workspaceId, streamId, streams, \{ additive = false \} = \{\}\)/u);
  const toggleStart = app.indexOf("function toggleOpenStream(");
  const toggleEnd = app.indexOf("/* =========================================================== роутер видов */", toggleStart);
  const toggle = app.slice(toggleStart, toggleEnd);
  assert.match(toggle, /persistOpenStreams\(\)/u);
  assert.match(toggle, /selectTaskFromUi\(target\.id\)/u);
  assert.match(app, /additive: event\.ctrlKey \|\| event\.metaKey/u);
  // Слева остаются только Workspace; Streams живут в горизонтальной полосе.
  assert.match(app, /function renderTaskWorkspaceItem\(/u);
  assert.doesNotMatch(app, /class: "task-workspace-streams"/u);
  assert.match(styles, /\.task-workspace-item\[data-selected\]/u);
  assert.match(styles, /\.stream-tab\[aria-pressed="true"\]/u);
  // Верхняя полоса показывает Stream и свойства текущего Thread, но не его
  // сменяемое название: история Thread появится только в истории перерождений.
  assert.match(tabs, /class: "stream-tab-card"/u);
  assert.match(tabs, /text: streamName/u);
  assert.doesNotMatch(tabs, /task\?\.threadTitle \|\| task\?\.title/u);
  assert.match(tabs, /"data-stream-model": task\?\.modelLabel \?\? ""/u);
  assert.doesNotMatch(tabs, /class: "task-agent task-model"/u);
  assert.doesNotMatch(tabs, /class: "task-runtime"/u);
  assert.match(app, /streamHeaderModel\.textContent = shortModelLabel\(model\)/u);
  assert.match(styles, /\.stream-tab-card\s*\{/u);
  assert.match(tabs, /"data-running": running \? "" : null/u);
  assert.match(tabs, /"data-answer-ready": answerReady \? "" : null/u);
  assert.doesNotMatch(tabs, /class: "task-status"/u);
  assert.match(styles, /@keyframes stream-running-wave/u);
  assert.match(styles, /@keyframes stream-answer-ready/u);
  assert.match(app, /const running = tasks\.some\(\(task\) => task\.running\)/u);
  assert.match(app, /"data-running": running \? "" : null/u);
  assert.match(styles, /\.task-workspace-item\[data-running\]::after/u);
  assert.match(styles, /\.task-workspace-item\[data-unread\]:not\(\[data-running\]\)/u);
  assert.doesNotMatch(app, /class: "task-unread", title: "Есть непрочитанные сообщения"/u);
  assert.doesNotMatch(styles, /\.stream-tab\[data-current\]\s*\{[\s\S]*?box-shadow/u);
});

test("Stream menu moves it to an existing or newly created Workspace", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");

  assert.match(app, /function openStreamContextMenu\(event, tab\)/u);
  assert.match(app, /class: "stream-context-submenu"/u);
  assert.match(app, /text: "Перенести в Workspace…"/u);
  assert.doesNotMatch(app, /text: "Статус и лимиты"/u);
  assert.match(app, /emit\("stream:move", \{ streamId, workspaceId:/u);
  assert.match(app, /emit\("workspace:create-from-stream", \{ streamId, name \}\)/u);
  assert.match(app, /text: "Ротация"/u);
  assert.match(app, /Завершить текущий Thread и продолжить Stream в новом/u);
  assert.match(app, /emit\("stream:rebirth", \{ streamId, provider, taskId \}\)/u);
  assert.match(app, /event\.pointerType !== "touch"/u);
  assert.match(app, /event\.key === "ContextMenu"/u);
  assert.match(client, /control\("create-workspace-from-stream", \{ streamId, name \}\)/u);
  assert.match(client, /control\("new-task", \{[\s\S]*?streamId,/u);
  assert.match(styles, /\.stream-context-menu\s*\{/u);
  assert.match(styles, /\.stream-context-submenu\s*\{/u);
  assert.match(styles, /\.stream-context-menu\s*\{[\s\S]*?scrollbar-gutter:\s*stable;[\s\S]*?width:\s*min\(14rem,/u);
  assert.match(styles, /\.stream-context-action\s*\{[\s\S]*?width:\s*100%;/u);
  assert.match(styles, /\.stream-context-menu\s*\{[\s\S]*?background-color:\s*var\(--bg\);[\s\S]*?background-image:\s*var\(--card-bg-open\);/u);
});

test("wide shared shell opens up to four Workspace Streams as chat columns", () => {
  const index = fs.readFileSync(require.resolve("../assets/web-app/index.html"), "utf8");
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const client = fs.readFileSync(require.resolve("../assets/web-app/hub-client.js"), "utf8");
  const styles = fs.readFileSync(require.resolve("../assets/web-app/styles.css"), "utf8");

  assert.match(index, /data-stream-tabs/u);
  assert.match(index, /data-stream-chat-columns/u);
  assert.match(app, /function visibleWorkspaceStreamTasks\(\)/u);
  assert.match(app, /const shown = surface === "mobile" \? visible\.slice\(0, 1\) : visible\.slice\(0, 4\)/u);
  assert.match(app, /emit\("workspace:visible-streams", \{ taskIds: ids \}\)/u);
  assert.match(app, /function renderStreamChatPreview\(task\)/u);
  assert.match(client, /agentHub\.on\("workspace:visible-streams"/u);
  assert.match(client, /visibleStreamTaskIds = new Set\(ids\)/u);
  assert.match(client, /for \(const task of snapshot\.tasks \?\? \[\]\) \{[\s\S]*agentHub\.setLive\(stableTaskId/u);
  assert.match(client, /control\("task-history", \{/u);
  assert.match(styles, /\.stream-chat-columns\[data-multi-stream\]/u);
  assert.match(styles, /repeat\(var\(--stream-chat-count, 1\), minmax\(13rem, 1fr\)\)/u);
  assert.match(styles, /\.stream-chat-columns\[data-multi-stream\] > \.chat-pane\[data-active-stream\]/u);
  assert.match(app, /chatPane\.toggleAttribute\("data-active-stream", selectedIndex >= 0\)/u);
  assert.match(index, /<\/aside>\s*<\/div>\s*<\/div>\s*<!-- Запросы подтверждений/u);
  assert.doesNotMatch(index, /data-mobile-chat-actions/u);
  assert.match(app, /class: "stream-chat-preview-head"/u);
  assert.match(app, /class: "stream-chat-preview-title"/u);
  assert.match(styles, /\.stream-chat-preview-head\s*\{/u);
  assert.match(app, /class: "stream-chat-preview-log chat-scroll"/u);
  assert.match(app, /class: "stream-chat-preview-messages chat-log"/u);
  assert.match(styles, /\.chat-overlay-actions\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?right:/u);
  assert.doesNotMatch(styles, /\.stream-chat-preview-log \.activity-feed\s*\{[\s\S]*?display:\s*none;/u);
  assert.match(styles, /html\[data-surface="mobile"\] \.stream-chat-preview\s*\{\s*display: none;/su);
  assert.match(styles, /html\[data-surface="mobile"\] \.stream-chat-columns\s*\{[\s\S]*?display: grid;/u);
});

test("VS Code stream refresh keeps composer focus and opens history at the bottom", () => {
  const app = fs.readFileSync(require.resolve("../assets/web-app/app.js"), "utf8");
  const deckStart = app.indexOf("function renderStreamChatDeck()");
  const deckEnd = app.indexOf("function refreshSupplementaryStreamChat", deckStart);
  const deck = app.slice(deckStart, deckEnd);
  const chatStart = app.indexOf("function renderChat()");
  const chatEnd = app.indexOf("function renderContextUsage", chatStart);
  const chat = app.slice(chatStart, chatEnd);

  // Фоновое обновление удаляет только read-only previews. Общий composer
  // находится вне колонок и остаётся подключённым к DOM.
  assert.match(deck, /querySelectorAll\("\.stream-chat-preview"\)/u);
  assert.doesNotMatch(deck, /replaceChildren\(chatPane/u);
  assert.match(deck, /chatPane\.style\.order/u);
  assert.doesNotMatch(app, /syncChatActionsPlacement/u);
  // Колонки фиксируются до forceBottom, поэтому переносы строк уже учтены.
  assert.ok(chat.indexOf("renderStreamChatDeck();") < chat.indexOf("renderMessages({ forceBottom: true, tailLimit: SWITCH_MESSAGE_RENDER_LIMIT });"));
});

test("hub status band lives inside the top toolbar instead of covering the stream row", () => {
  const html = fs.readFileSync(path.join(WEB_APP_ROOT, "index.html"), "utf8");
  const styles = fs.readFileSync(path.join(WEB_APP_ROOT, "styles.css"), "utf8");
  /* Полоса остаётся визуально связанной с верхней панелью, но выводится
     поверх оболочки и не меняет геометрию чата при переподключении. */
  const toolbar = html.indexOf('class="toolbar"');
  const banner = html.indexOf("data-restart-banner");
  const settings = html.indexOf('data-panel-open="settings"');
  assert.ok(toolbar < banner && banner < settings);
  assert.match(styles, /\.connection-banner \{[^}]*pointer-events: none;[^}]*position: fixed;/u);
  assert.match(styles, /\.connection-banner \{[^}]*left: 50%;[^}]*transform: translateX\(-50%\);[^}]*width: max-content;/u);
  assert.match(styles, /html\[data-surface="mobile"\] \.connection-banner \{[^}]*max-width: 100%;/u);
  assert.match(styles, /html:not\(\[data-surface="mobile"\]\) \.connection-banner:not\(\[hidden\]\) \{/u);
  assert.doesNotMatch(styles, /html:not\(\[data-surface="mobile"\]\) \.connection-banner \{[^}]*display:/u);
});

test("Null keeps a flat monochrome ground without a single coloured token", () => {
  const styles = themeFile("zero");
  const manifest = JSON.parse(fs.readFileSync(path.join(WEB_APP_ROOT, "themes", "zero", "theme.json"), "utf8"));
  /* Монохромность — визуальный контракт, а не требование к конкретной записи
     цвета. Проверяем и oklch, и hex, чтобы замена одного CSS-синтаксиса другим
     не ломала тест при сохранении той же grayscale-палитры. */
  const chroma = [...styles.matchAll(/oklch\(\s*[\d.]+\s+([\d.]+)/gu)].map((match) => Number(match[1]));
  assert.ok(chroma.every((value) => value === 0));
  const hexColours = [...styles.matchAll(/#([\da-f]{3,8})\b/giu)].map((match) => match[1]);
  assert.ok(hexColours.length > 20);
  for (const value of hexColours) {
    const expanded = value.length <= 4
      ? [...value].map((digit) => `${digit}${digit}`).join("")
      : value;
    assert.equal(expanded.slice(0, 2), expanded.slice(2, 4));
    assert.equal(expanded.slice(2, 4), expanded.slice(4, 6));
  }
  assert.equal(manifest.backgrounds.length, 1);
  assert.doesNotMatch(styles, /url\(/u);
  const shadows = [...styles.matchAll(/box-shadow:\s*([^;}]+)/gu)].map((match) => match[1].trim());
  for (const shadow of shadows) {
    if (shadow === "none") continue;
    const [inset, offsetX, offsetY, blur, colour, ...extra] = shadow.split(/\s+/u);
    assert.equal(inset, "inset");
    assert.equal(blur, "0");
    assert.equal(colour, "var(--accent)");
    assert.deepEqual(extra, []);
    assert.ok([offsetX, offsetY].some((offset) => Math.abs(Number.parseFloat(offset)) === 1));
  }
});

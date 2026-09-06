import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const WEB_APP_ROOT = new URL("../../assets/web-app/", import.meta.url);

const TEST_THEME_CATALOG = JSON.stringify([{
  id: "orbit",
  name: "Orbit",
  color: "#080b11",
  aliases: [],
  assets: {},
  backgrounds: [{ id: "none", name: "Нет", assetUrl: "", preload: false }],
}]);

function webAssetContentType(pathname) {
  if (/\.css$/u.test(pathname)) return "text/css; charset=utf-8";
  if (/\.(?:js|mjs)$/u.test(pathname)) return "text/javascript; charset=utf-8";
  if (/\.png$/u.test(pathname)) return "image/png";
  return "application/octet-stream";
}

async function launchDomBrowser(chromium) {
  if (process.platform === "win32") return chromium.launch({ channel: "msedge", headless: true });
  return chromium.launch({ headless: true });
}

async function openStreamTabsDomFixture(page, {
  includeHubClient = false,
  control = null,
} = {}) {
  const initialSnapshot = {
    apiVersion: 3,
    version: "hub157-browser-snapshot",
    server: { status: "online" },
    tasks: [],
    workspaces: [],
    archivedWorkspaces: [],
    boardTasks: [],
    boardLayout: { columnOrder: [] },
    deferredInputs: [],
    messageReceipts: [],
    pendingApprovals: [],
    settings: {
      provider: "codex",
      models: [],
      modelOptionsByProvider: {},
      reasoningOptions: [],
      reasoningOptionsByProvider: {},
      modeOptions: [],
      quickMessages: { global: [], workspaces: {}, streams: {} },
    },
  };
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "agent-hub.test") {
      await route.abort();
      return;
    }
    if (requestUrl.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      let body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "");
      if (!includeHubClient) {
        body = body.replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "");
      }
      body = body.replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
      return;
    }
    if (requestUrl.pathname === "/api/snapshot") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(initialSnapshot) });
      return;
    }
    if (requestUrl.pathname === "/api/control" && route.request().method() === "POST") {
      const request = route.request().postDataJSON();
      const response = await control?.(request) ?? { status: 200, body: { ok: true, result: initialSnapshot } };
      await route.fulfill({
        status: response.status ?? 200,
        contentType: "application/json",
        body: JSON.stringify(response.body ?? response),
      });
      return;
    }
    if (requestUrl.pathname === "/work-log.css") {
      await route.fulfill({
        status: 200,
        contentType: "text/css; charset=utf-8",
        body: await readFile(new URL("../../work-log.css", import.meta.url)),
      });
      return;
    }
    const relative = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, "");
    if (!relative || relative.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      await route.fulfill({ status: 404, body: "Not found" });
      return;
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: webAssetContentType(relative),
        body: await readFile(new URL(relative, WEB_APP_ROOT)),
      });
    } catch {
      await route.fulfill({ status: 404, body: "Not found" });
    }
  });
  await page.goto("https://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
  if (includeHubClient) {
    await page.waitForFunction(() => document.querySelector("[data-connection-label]")?.textContent !== "");
  }
}

async function startPermanentDeleteConflictBackend() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-delete-conflict-backend-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const imports = {
    catalog: new URL("../../src/infrastructure/persistence/workspace-catalog-store.mjs", import.meta.url).href,
    board: new URL("../../src/infrastructure/persistence/task-board-store.mjs", import.meta.url).href,
    server: new URL("../../src/interfaces/web/mini-app-server.mjs", import.meta.url).href,
  };
  const script = `(async () => {
    const [{ WorkspaceCatalogStore }, { TaskBoardStore }, { MiniAppServer }] = await Promise.all([
      import(process.argv[2]), import(process.argv[3]), import(process.argv[4]),
    ]);
    const databaseFile = process.argv[1];
    const catalog = new WorkspaceCatalogStore({
      databaseFile, instanceId: "hub157-edge-backend", leaseDurationMs: 10000,
    });
    await catalog.load();
    const board = new TaskBoardStore({ databaseFile });
    const workspace = catalog.createWorkspace({ id: "archived-rejected", name: "Rejected Archive" });
    catalog.createStream({ id: "archived-rejected-stream", workspaceId: workspace.id });
    board.create({
      text: "Durable attachment blocks deletion", bucket: "workspace", workspaceId: workspace.id,
      taskPrefix: "HUB", triageStatus: "disabled",
    });
    catalog.archiveWorkspace(workspace.id);
    const snapshot = {
      apiVersion: 3, version: "hub157-backend", server: { status: "online" }, tasks: [],
      workspaces: [], boardTasks: [], boardLayout: { columnOrder: [] }, deferredInputs: [],
      messageReceipts: [], pendingApprovals: [], settings: { provider: "codex", models: [],
        modelOptionsByProvider: {}, reasoningOptions: [], reasoningOptionsByProvider: {},
        modeOptions: [], quickMessages: { global: [], workspaces: {}, streams: {} } },
    };
    const server = new MiniAppServer({
      host: "127.0.0.1", port: 0,
      journalDatabase: { html: () => "", version: "test", subscribe: () => () => {} },
      controlHandler: async ({ action, params }) => {
        if (action === "delete-archived-workspace") {
          await catalog.deleteArchivedWorkspace(params.workspaceId, params.confirmationName);
        }
        return snapshot;
      },
    });
    const address = await server.start();
    process.stdout.write(JSON.stringify({ url: address.url }) + "\\n");
  })().catch((error) => { console.error(error); process.exit(1); });`;
  const child = spawn(process.execPath, [
    "--eval", script, databaseFile, imports.catalog, imports.board, imports.server,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend start timed out: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      resolve(JSON.parse(stdout.slice(0, newline)));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`backend exited ${code}: ${stderr}`));
    });
    child.once("error", reject);
  });
  return {
    ...ready,
    async close() {
      if (child.exitCode == null) {
        const closed = once(child, "close");
        child.kill("SIGTERM");
        await closed;
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.attributes = new Set();
    this.scrollLeft = 0;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  toggleAttribute(name, enabled) {
    if (enabled) this.attributes.add(name);
    else this.attributes.delete(name);
  }
}

class FakeSvgNode {
  constructor(namespaceURI, localName) {
    this.namespaceURI = namespaceURI;
    this.localName = localName;
    this.attributes = new Map();
    this.children = [];
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  append(child) {
    this.children.push(child);
  }
}

async function streamTabsApi() {
  const source = await readFile(new URL("../../assets/web-app/stream-tabs-controller.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubStreamTabs;
}

const stream = (id, ordinal, lastActivity) => ({
  id,
  ordinal,
  tasks: [{ lastActivity }],
});

test("activity mode puts the most recently active Stream first", async () => {
  const { orderWorkspaceStreams } = await streamTabsApi();
  const streams = [
    stream("older", 1, "2026-08-10T08:00:00.000Z"),
    stream("latest", 2, "2026-08-10T10:00:00.000Z"),
    stream("middle", 3, "2026-08-10T09:00:00.000Z"),
  ];
  assert.deepEqual(
    Array.from(
      orderWorkspaceStreams(streams, "activity"),
      (item) => item.id,
    ),
    ["latest", "middle", "older"],
  );
});

test("rotated Stream keeps recent activity while opening its current Thread", async () => {
  const { representativeSnapshotTasks } = await streamTabsApi();
  const previousThreadActivity = Date.parse("2026-08-21T12:32:43.462Z");
  const tasks = [
    {
      streamId: "stream-1",
      provider: "codex",
      threadId: "previous-thread",
      threadPosition: 2,
      lastAnswerAt: "2026-08-21T12:32:43.462Z",
    },
    {
      streamId: "stream-1",
      provider: "codex",
      threadId: "current-thread",
      threadPosition: 3,
      lastAnswerAt: "2026-08-21T12:03:58.474Z",
    },
  ];

  const [representative] = representativeSnapshotTasks(tasks);

  assert.equal(representative.threadId, "current-thread");
  assert.equal(representative.orderingActivityAtMs, previousThreadActivity);
});

test("a terminal identity absorbs a stale active Stream projection", async () => {
  const { isExactActiveUserTurn } = await streamTabsApi();
  const task = {
    provider: "codex",
    threadId: "thread-1",
    running: true,
    run: {
      turnId: "turn-1",
      operationKind: "user-turn",
      projectionState: "active",
    },
    latestFinal: {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      revision: 2,
    },
  };

  assert.equal(isExactActiveUserTurn(task), false);
  assert.equal(isExactActiveUserTurn({ ...task, latestFinal: null }), true);
  assert.equal(isExactActiveUserTurn({ ...task, run: null }), false);
});

test("rotation notice follows the actually compacted Thread instead of the previous head", async () => {
  const {
    rotationMaintenancePresentation,
    streamRotationTransitions,
  } = await streamTabsApi();
  const previousTasks = [
    {
      streamId: "stream-1",
      threadId: "compacted-thread",
      threadPosition: 2,
      context: {
        percent: 26.315015,
        compaction: {
          rotated: true,
          afterPercent: 26.315015,
          completedAt: "2026-08-21T12:33:12.575Z",
        },
      },
    },
    {
      streamId: "stream-1",
      threadId: "previous-head-without-context",
      threadPosition: 3,
      context: null,
      maintenance: { reason: "automatic-rotation" },
    },
  ];
  const currentTasks = [
    ...previousTasks,
    {
      streamId: "stream-1",
      threadId: "current-thread",
      threadPosition: 4,
      context: null,
    },
  ];

  const [transition] = streamRotationTransitions(previousTasks, currentTasks);
  const presentation = rotationMaintenancePresentation(transition.beforePercent, null);

  assert.equal(transition.sourceThreadId, "compacted-thread");
  assert.equal(transition.beforePercent, 26);
  assert.equal(presentation.maintenanceLabel, "Ротация завершена");
  assert.match(presentation.text, /новый Thread создан/u);
});

test("ordinary Thread continuation does not reuse an old rotation event", async () => {
  const { streamRotationTransitions } = await streamTabsApi();
  const previousTasks = [
    {
      streamId: "stream-1",
      threadId: "old-rotated-thread",
      threadPosition: 2,
      context: {
        compaction: {
          rotated: true,
          afterPercent: 16,
          completedAt: "2026-08-21T11:00:00.000Z",
        },
      },
    },
    {
      streamId: "stream-1",
      threadId: "previous-head",
      threadPosition: 3,
      context: { percent: 16 },
    },
  ];
  const currentTasks = [
    ...previousTasks,
    {
      streamId: "stream-1",
      threadId: "continued-thread",
      threadPosition: 4,
      context: { percent: 45 },
    },
  ];

  assert.deepEqual(Array.from(streamRotationTransitions(previousTasks, currentTasks)), []);
});

test("desktop Stream settings are theme-independent and keep stable geometry", async () => {
  const {
    STREAM_CARD_MAX_WIDTH,
    STREAM_CARD_MIN_WIDTH,
    calculateOverflowShift,
    compactStreamActivityValue,
    resolveStableStreamCardWidth,
    streamCardSettingsAvailable,
    streamCardSettingsWrapperNeedsReplacement,
  } = await streamTabsApi();
  assert.equal(streamCardSettingsAvailable({ isWide: true, surface: "desktop" }), true);
  assert.equal(streamCardSettingsAvailable({ isWide: true, surface: "vscode" }), true);
  assert.equal(streamCardSettingsAvailable({ isWide: true, surface: "mobile" }), false);
  assert.equal(streamCardSettingsAvailable({ isWide: false, surface: "desktop" }), false);
  const currentWrapper = {};
  assert.equal(streamCardSettingsWrapperNeedsReplacement(currentWrapper, currentWrapper), false);
  assert.equal(streamCardSettingsWrapperNeedsReplacement(currentWrapper, {}), true);
  assert.equal(streamCardSettingsWrapperNeedsReplacement(currentWrapper, null), true);
  assert.equal(STREAM_CARD_MIN_WIDTH, 90);
  assert.equal(STREAM_CARD_MAX_WIDTH, 450);
  assert.equal(compactStreamActivityValue("3 мин 26 с"), "3 мин");
  assert.equal(compactStreamActivityValue("26 с"), "<1м");
  assert.equal(calculateOverflowShift(1_838, 1_950, 299), 187);
  assert.equal(calculateOverflowShift(2_138, 1_950, 0), 188);

  const widths = new Map();
  assert.equal(resolveStableStreamCardWidth(widths, "themes", 119.25), 119.25);
  assert.equal(resolveStableStreamCardWidth(widths, "themes", 126.5), 119.25);
  assert.equal(resolveStableStreamCardWidth(widths, "new-stream"), 0);
});

test("quick messages preserve structured mappings and scope order", async () => {
  const {
    quickMessagesCountLabel,
    quickMessagesForStream,
    quickMessagesFromText,
    quickMessagesToText,
    setQuickMessagesForScope,
  } = await streamTabsApi();
  const selection = {
    quickMessages: {
      global: ["пинг"],
      workspaces: { "workspace-1": ["релизь", { label: "Тесты", text: "запусти тесты" }] },
      streams: { "stream-1": [{ label: "Release", text: "релизь" }, "продолжай", "пинг"] },
    },
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(quickMessagesForStream(selection, "workspace-1", "stream-1").map(({ scope, title, text }) => ({
      scope, title, text,
    })))),
    [
      { scope: "global", title: "пинг", text: "пинг" },
      { scope: "workspace", title: "релизь", text: "релизь" },
      { scope: "workspace", title: "Тесты", text: "запусти тесты" },
      { scope: "stream", title: "Release", text: "релизь" },
      { scope: "stream", title: "продолжай", text: "продолжай" },
      { scope: "stream", title: "пинг", text: "пинг" },
    ],
  );
  assert.equal(
    quickMessagesToText(quickMessagesFromText("Релиз | релизь\nпроверь")),
    "Релиз | релизь\nпроверь",
  );
  assert.equal(quickMessagesCountLabel(0), "0 ответов");
  assert.equal(quickMessagesCountLabel(1), "1 ответ");
  assert.equal(quickMessagesCountLabel(2), "2 ответа");
  assert.equal(quickMessagesCountLabel(5), "5 ответов");
  assert.equal(quickMessagesCountLabel(11), "11 ответов");
  assert.equal(quickMessagesCountLabel(21), "21 ответ");
  assert.deepEqual(
    JSON.parse(JSON.stringify(setQuickMessagesForScope(selection, "stream", "stream-1", []))),
    {
      global: [{ title: "пинг", text: "пинг" }],
      streams: {},
      workspaces: {
        "workspace-1": [
          { title: "релизь", text: "релизь" },
          { title: "Тесты", text: "запусти тесты" },
        ],
      },
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(setQuickMessagesForScope(selection, "global", "", ["везде"]))),
    {
      global: [{ title: "везде", text: "везде" }],
      streams: {
        "stream-1": [
          { title: "Release", text: "релизь" },
          { title: "продолжай", text: "продолжай" },
          { title: "пинг", text: "пинг" },
        ],
      },
      workspaces: {
        "workspace-1": [
          { title: "релизь", text: "релизь" },
          { title: "Тесты", text: "запусти тесты" },
        ],
      },
    },
  );
});
test("desktop Stream settings replace duplicate toolbar controls and keep titles left-aligned", async () => {
  const app = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");
  const controller = await readFile(new URL("../../assets/web-app/stream-tabs-controller.js", import.meta.url), "utf8");
  const dialogStyles = await readFile(new URL("../../assets/web-app/dialog-area.css", import.meta.url), "utf8");

  assert.match(app, /hidden: window\.AgentHubStreamTabs\.streamCardSettingsAvailable/u);
  assert.match(controller, /orderToggle\.hidden = true;/u);
  assert.match(dialogStyles, /\.stream-order-toggle\[hidden\] \{[\s\S]*display: none !important;/u);
  assert.doesNotMatch(dialogStyles, /\.toolbar \.view-settings \{[\s\S]*display: none !important;/u);
  assert.match(dialogStyles, /\.stream-tabs-track \.stream-tab-title \{[\s\S]*text-align: left !important;/u);
  assert.match(
    dialogStyles,
    /^&:not\(\[data-surface="mobile"\]\) \.chat-log \.msg-stack-user \{/mu,
  );
  assert.doesNotMatch(
    dialogStyles,
    /html\[data-view="chat"\][^{]*html\[data-view="chat"\]/u,
  );
  const strippedPseudoElements = dialogStyles.match(
    /\.stream-tabs-track \.stream-tab\[aria-pressed="true"\]::after,[\s\S]*?\{\s*content:\s*none;\s*\}/u,
  )?.[0] ?? "";
  assert.doesNotMatch(strippedPseudoElements, /\.stream-tab-card::/u);
});

test("every desktop Stream tab keeps dot, title and time in fixed columns", async () => {
  const dialogStyles = await readFile(new URL("../../assets/web-app/dialog-area.css", import.meta.url), "utf8");
  const gothicStyles = await readFile(new URL("../../assets/web-app/themes/gothic/theme.css", import.meta.url), "utf8");

  assert.match(
    dialogStyles,
    /\.stream-tabs-track \.stream-tab-card \{[\s\S]*display: grid;[\s\S]*grid-template-columns: 7px minmax\(0, 1fr\) max-content;[\s\S]*width: 100%;/u,
  );
  assert.match(
    dialogStyles,
    /\.stream-tabs-track \.stream-tab-card:has\(> \.stream-tab-pin-icon\) \{[\s\S]*grid-template-columns: 7px 13px minmax\(0, 1fr\) max-content;/u,
  );
  assert.match(dialogStyles, /\.stream-tabs-track \.stream-tab-title \{[\s\S]*justify-self: start;[\s\S]*text-align: left !important;/u);
  assert.match(dialogStyles, /\.stream-tabs-track \.stream-tab \.task-time,[\s\S]*justify-self: end;[\s\S]*margin-left: 0;/u);
  assert.doesNotMatch(dialogStyles, /\.stream-tab:is\([^}]+margin-inline: calc\(-1 \* var\(--stream-tab-inline-padding\)\)/u);
  assert.doesNotMatch(
    gothicStyles,
    /\.stream-tabs \.stream-tab(?:\[[^\]]+\])+ \.stream-tab-card \{[^}]*margin(?:-inline|-left|-right)\s*:/u,
  );
});

test("Stream card settings normalize values received from the server snapshot", async () => {
  const {
    normalizeStreamCardSettings,
  } = await streamTabsApi();

  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeStreamCardSettings({
      streamCardWidthMode: "fixed",
      streamCardFixedWidth: 237,
      streamCardGapEnabled: true,
    }))),
    { widthMode: "fixed", fixedWidth: 237, gapEnabled: true },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalizeStreamCardSettings({
      widthMode: "broken",
      fixedWidth: 999,
      gapEnabled: "true",
    }))),
    { widthMode: "auto", fixedWidth: 450, gapEnabled: false },
  );
});

test("Stream card settings do not rewrite an unchanged width label", async () => {
  const { setTextContentIfChanged } = await streamTabsApi();
  let text = "90";
  let writes = 0;
  const element = {
    get textContent() {
      return text;
    },
    set textContent(value) {
      writes += 1;
      text = value;
    },
  };

  assert.equal(setTextContentIfChanged(element, 90), false);
  assert.equal(writes, 0);
  assert.equal(setTextContentIfChanged(element, 120), true);
  assert.equal(text, "120");
  assert.equal(writes, 1);
});

test("every production Phosphor icon creates a real namespaced SVG", async () => {
  const { createPhosphorIcon } = await streamTabsApi();
  const document = {
    createElementNS: (namespaceURI, localName) => new FakeSvgNode(namespaceURI, localName),
  };
  for (const name of [
    "arrow-clockwise",
    "arrows-down-up",
    "caret-down",
    "caret-right",
    "caret-up",
    "clock-counter-clockwise",
    "copy",
    "folder",
    "pencil-simple",
    "plus",
    "push-pin-simple",
  ]) {
    const icon = createPhosphorIcon(document, name, "stream-order-icon");
    assert.equal(icon.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(icon.localName, "svg");
    assert.equal(icon.attributes.get("data-phosphor-icon"), name);
    assert.equal(icon.attributes.get("viewBox"), "0 0 256 256");
    assert.equal(icon.children[0].namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(icon.children[0].localName, "path");
    assert.ok(icon.children[0].attributes.get("d"));
    assert.equal(icon.children[0].attributes.get("fill"), "currentColor");
  }
});

test("unknown Phosphor icons fail the registry contract", async () => {
  const { createPhosphorIcon } = await streamTabsApi();
  const document = {
    createElementNS: (namespaceURI, localName) => new FakeSvgNode(namespaceURI, localName),
  };

  assert.throws(
    () => createPhosphorIcon(document, "missing-icon"),
    /unknown Phosphor icon: missing-icon/u,
  );
});

test("Workspace folder summary uses only namespaced Phosphor SVG icons", async () => {
  const { workspaceFolderSummaryIcons } = await streamTabsApi();
  const document = {
    createElementNS: (namespaceURI, localName) => new FakeSvgNode(namespaceURI, localName),
  };

  const icons = workspaceFolderSummaryIcons(document);

  assert.deepEqual(
    Array.from(icons, (icon) => icon.attributes.get("data-phosphor-icon")),
    ["caret-right", "folder"],
  );
  for (const icon of icons) {
    assert.equal(icon.namespaceURI, "http://www.w3.org/2000/svg");
    assert.equal(icon.localName, "svg");
    assert.equal(icon.attributes.get("aria-hidden"), "true");
    assert.ok(icon.attributes.get("class")?.startsWith("task-workspace-folder-"));
    assert.equal(icon.children.length, 1);
    assert.equal(icon.children[0].localName, "path");
    assert.ok(icon.children[0].attributes.get("d"));
  }
});

test("Workspace folder production path uses Phosphor icons without raw glyphs", async () => {
  const [appSource, stylesSource] = await Promise.all([
    readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(appSource, /workspaceFolderSummaryIcons\(document\)/u);
  assert.doesNotMatch(appSource, /task-workspace-folder-icon[^,\n]*text:\s*"▸"/u);
  assert.doesNotMatch(stylesSource, /task-workspace-folder-glyph::before/u);
  assert.doesNotMatch(stylesSource, /task-workspace-folder-glyph\s*\{[^}]*border:/u);
});

test("open Stream layout preserves physical column order when activity changes", async () => {
  const { reconcileOpenStreamIds } = await streamTabsApi();
  assert.deepEqual(
    Array.from(reconcileOpenStreamIds(
      ["alpha", "beta", "gamma"],
      ["gamma", "alpha", "beta", "delta"],
      "gamma",
    )),
    ["alpha", "beta", "gamma"],
  );
});

test("Stream deck key ignores live status churn but tracks physical chat identity", async () => {
  const { streamDeckRenderKey } = await streamTabsApi();
  const first = [{
    id: "stream-1",
    workspaceName: "Agent HUB",
    streamName: "Architect",
    running: false,
  }];
  const active = [{ ...first[0], running: true, statusLabel: "Ход выполняется" }];

  assert.equal(streamDeckRenderKey(first, "stream-1"), streamDeckRenderKey(active, "stream-1"));
  assert.notEqual(streamDeckRenderKey(first, "stream-1"), streamDeckRenderKey(first, "stream-2"));
  assert.notEqual(
    streamDeckRenderKey(first, "stream-1"),
    streamDeckRenderKey([{ ...first[0], streamName: "Themes" }], "stream-1"),
  );
});

test("Stream overflow menu survives background rerenders only inside its Workspace", async () => {
  const { preserveStreamOverflowMenuOpen } = await streamTabsApi();

  assert.equal(preserveStreamOverflowMenuOpen("agent-hub", "agent-hub", true), true);
  assert.equal(preserveStreamOverflowMenuOpen("agent-hub", "other", true), false);
  assert.equal(preserveStreamOverflowMenuOpen("agent-hub", "agent-hub", false), false);
  assert.equal(preserveStreamOverflowMenuOpen("", "agent-hub", true), false);
});

test("ordinary hidden Stream selection collapses a four-column layout", async () => {
  const { applyOpenStreamSelection } = await streamTabsApi();
  const open = ["alpha", "beta", "gamma", "delta"];
  assert.deepEqual(
    JSON.parse(JSON.stringify(applyOpenStreamSelection(open, "epsilon"))),
    { ids: ["epsilon"], limitReached: false },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(applyOpenStreamSelection(open, "beta"))),
    { ids: open, limitReached: false },
  );
});

test("only additive selection expands the open Stream layout", async () => {
  const { applyOpenStreamSelection } = await streamTabsApi();
  assert.deepEqual(
    JSON.parse(JSON.stringify(applyOpenStreamSelection(["alpha"], "beta", { additive: true }))),
    { ids: ["alpha", "beta"], limitReached: false },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(applyOpenStreamSelection(
      ["alpha", "beta", "gamma", "delta"],
      "epsilon",
      { additive: true },
    ))),
    { ids: ["alpha", "beta", "gamma", "delta"], limitReached: true },
  );
});

test("Stream dot state separates execution, idle and failure from provider color", async () => {
  const { streamStatusState } = await streamTabsApi();
  assert.equal(streamStatusState({ running: true }), "running");
  assert.equal(streamStatusState({ running: false }), "idle");
  assert.equal(streamStatusState({ failed: true, running: true }), "failed");
  assert.equal(streamStatusState({ statusLabel: "Ошибка доставки" }), "failed");
});

async function productionWebScripts(directory) {
  const sources = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);
    if (entry.isDirectory()) sources.push(...await productionWebScripts(child));
    else if (/\.(?:js|mjs)$/u.test(entry.name)) sources.push({
      name: child.pathname,
      source: await readFile(child, "utf8"),
    });
  }
  return sources;
}

test("production Web SVG nodes cannot bypass the namespace-safe factories", async () => {
  const scripts = await productionWebScripts(new URL("../../assets/web-app/", import.meta.url));
  const forbidden = /(?:\bel\(\s*["']svg["']|document\.createElement\(\s*["']svg["'])/u;
  const violations = scripts.filter(({ source }) => forbidden.test(source)).map(({ name }) => name);
  assert.deepEqual(violations, []);
});

test("desktop Stream tabs fit their titles and render separators between Streams", async () => {
  const [appSource, styles, jediTheme] = await Promise.all([
    readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/themes/jedi-archives/theme.css", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /class: "stream-tab-divider"/u);
  assert.match(styles, /\.stream-tab-divider \{[\s\S]*flex: 0 0 1px/u);
  assert.match(styles, /--shell-stream-tab-width, max-content/u);
  assert.match(styles, /--shell-stream-tab-max-width, 20rem/u);
  assert.match(jediTheme, /--shell-stream-tab-width: max-content/u);
});

test("Stream create control keeps compact geometry outside regular tab sizing", async () => {
  const styles = await readFile(new URL("../../assets/web-app/styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /\.stream-tab-create \{[\s\S]*?flex: 0 0 2rem;[\s\S]*?max-width: 2rem;[\s\S]*?min-width: 2rem;[\s\S]*?width: 2rem;/u,
  );
  assert.match(
    styles,
    /html\[data-view="chat"\]:not\(\[data-surface="mobile"\]\) \.stream-tab-create \{[\s\S]*?flex: 0 0 var\(--shell-stream-create-width, 2rem\) !important;[\s\S]*?max-width: var\(--shell-stream-create-width, 2rem\) !important;[\s\S]*?min-width: var\(--shell-stream-create-width, 2rem\) !important;[\s\S]*?width: var\(--shell-stream-create-width, 2rem\) !important;/u,
  );
});

test("Stream archive intent keeps the stable Stream identity", async () => {
  const { archiveStreamIntent } = await streamTabsApi();
  assert.deepEqual(
    JSON.parse(JSON.stringify(archiveStreamIntent(" stream-1 "))),
    { type: "stream:archive", detail: { streamId: "stream-1" } },
  );
  assert.throws(() => archiveStreamIntent(" "), /stream id is required/u);
});

test("activity order always keeps the latest Streams at the start", async () => {
  const { orderWorkspaceStreams } = await streamTabsApi();
  const streams = [
    stream("older", 1, "2026-08-10T08:00:00.000Z"),
    stream("latest", 2, "2026-08-10T10:00:00.000Z"),
    stream("middle", 3, "2026-08-10T09:00:00.000Z"),
  ];
  assert.deepEqual(
    Array.from(orderWorkspaceStreams(streams, "activity"), (item) => item.id),
    ["latest", "middle", "older"],
  );
});

test("activity rail count excludes merely recent Streams", async () => {
  const { attentionStreamCount } = await streamTabsApi();
  assert.equal(attentionStreamCount([
    { id: "running", running: true, unread: false },
    { id: "unread", running: false, unread: true },
    { id: "both", running: true, unread: true },
    { id: "recent", running: false, unread: false },
  ]), 3);
});

test("activity rail separates attention from recent Streams and keeps active Other", async () => {
  const { activityStreamSections, includeTaskInActivityRail } = await streamTabsApi();
  const tasks = [
    { id: "running", running: true, unread: false },
    { id: "unread", running: false, unread: true },
    { id: "recent", running: false, unread: false },
  ];
  const sections = activityStreamSections(tasks);
  assert.deepEqual(Array.from(sections.active, (item) => item.id), ["running", "unread"]);
  assert.deepEqual(Array.from(sections.recent, (item) => item.id), ["recent"]);
  assert.equal(includeTaskInActivityRail({ workspaceName: "Other" }, "running"), true);
  assert.equal(includeTaskInActivityRail({ workspaceName: "Other" }, "completed"), true);
  assert.equal(includeTaskInActivityRail({ workspaceName: "Other" }, "recent"), false);
});

test("task list keeps unassigned Tasks beside Workspace groups", async () => {
  const { taskListSections } = await streamTabsApi();
  const sections = taskListSections([
    { id: "workspace-task", workspaceId: "workspace-1" },
    { id: "legacy-task", workspaceId: "" },
    { id: "missing-workspace" },
  ]);
  assert.deepEqual(Array.from(sections.workspaceTasks, (task) => task.id), ["workspace-task"]);
  assert.deepEqual(Array.from(sections.unassignedTasks, (task) => task.id), ["legacy-task", "missing-workspace"]);
});

test("an active Stream preserves its answer-ready state", async () => {
  const { streamStatusPresentation } = await streamTabsApi();
  assert.deepEqual(
    JSON.parse(JSON.stringify(streamStatusPresentation({ running: true, unread: true }))),
    { running: true, answerReady: true, statusLabel: "Ход выполняется · Ответ готов" },
  );
});

test("Astra uses its compact label only in Stream pills and the active Stream header", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    const page = await browser.newPage();
    await openStreamTabsDomFixture(page);
    const result = await page.evaluate(() => {
      window.AgentHub.setWorkspaces([{
        id: "workspace-agent-hub",
        name: "Agent HUB",
        title: "Agent HUB",
      }]);
      const astraTask = {
        id: "task-astra",
        threadId: "thread-astra",
        workspaceId: "workspace-agent-hub",
        workspaceName: "Agent HUB",
        streamId: "stream-astra",
        streamName: "S4",
        streamOrdinal: 4,
        title: "Astra task",
        provider: "codex",
        agentLabel: "Codex",
        modelLabel: "GPT-6 Astra",
        status: "in_progress",
        statusLabel: "В работе",
        lastActivity: "2026-09-05T08:00:00.000Z",
        unread: false,
        running: true,
        selected: true,
      };
      window.AgentHub.setTasks([astraTask, {
        ...astraTask,
        id: "task-custom-astra",
        threadId: "thread-custom-astra",
        streamId: "stream-custom-astra",
        streamName: "S5",
        streamOrdinal: 5,
        modelLabel: "Custom Astra Preview",
        selected: false,
      }]);
      return {
        header: document.querySelector("[data-stream-header-model]")?.textContent,
        headerTitle: document.querySelector("[data-stream-header-model]")?.title,
        astraPill: document.querySelector(
          '[data-activity-task-id="task-astra"] .task-model',
        )?.textContent,
        astraPillTitle: document.querySelector(
          '[data-activity-task-id="task-astra"] .task-model',
        )?.title,
        customPill: document.querySelector(
          '[data-activity-task-id="task-custom-astra"] .task-model',
        )?.textContent,
        customPillTitle: document.querySelector(
          '[data-activity-task-id="task-custom-astra"] .task-model',
        )?.title,
      };
    });

    assert.equal(result.header, "Astra");
    assert.equal(result.headerTitle, "GPT-6 Astra");
    assert.equal(result.astraPill, "Astra");
    assert.equal(result.astraPillTitle, "GPT-6 Astra");
    assert.equal(result.customPill, "Custom Astra Preview");
    assert.equal(result.customPillTitle, "Custom Astra Preview");
  } finally {
    await browser.close();
  }
});

test("background status changes rerender visible top Stream tabs", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    const page = await browser.newPage();
    await openStreamTabsDomFixture(page);
    const result = await page.evaluate(() => {
      const lastActivity = "2026-09-02T08:00:00.000Z";
      const architect = {
        id: "task-architect",
        threadId: "thread-architect",
        workspaceId: "workspace-agent-hub",
        workspaceName: "Agent HUB",
        streamId: "stream-architect",
        streamName: "Architect",
        streamOrdinal: 1,
        title: "Architect",
        provider: "codex",
        agentLabel: "Codex",
        modelLabel: "Sol",
        status: "ready",
        statusLabel: "Готов",
        lastActivity,
        unread: false,
        running: false,
        selected: true,
      };
      const idleS2 = {
        ...architect,
        id: "task-s2",
        threadId: "thread-s2",
        streamId: "stream-s2",
        streamName: "S2",
        streamOrdinal: 2,
        title: "S2",
        selected: false,
      };
      window.AgentHub.setWorkspaces([{
        id: "workspace-agent-hub",
        name: "Agent HUB",
        title: "Agent HUB",
      }]);
      window.AgentHub.setTasks([architect, idleS2]);
      const initialTopS2 = document.querySelector(
        '.stream-tabs-track .stream-tab[data-stream-name="S2"]',
      );
      const before = {
        topExists: Boolean(initialTopS2),
        topRunning: initialTopS2?.hasAttribute("data-running") ?? null,
        topCurrent: initialTopS2?.hasAttribute("data-current") ?? null,
      };

      window.AgentHub.setTasks([architect, {
        ...idleS2,
        running: true,
        status: "in_progress",
        statusLabel: "В работе",
        startedAt: "2026-09-02T08:01:00.000Z",
      }]);

      const topS2 = document.querySelector(
        '.stream-tabs-track .stream-tab[data-stream-name="S2"]',
      );
      const rightS2 = document.querySelector(
        '.activity-stream-item[data-activity-task-id="task-s2"]',
      );
      const architectTab = document.querySelector(
        '.stream-tabs-track .stream-tab[data-stream-name="Architect"]',
      );
      const effect = topS2?.querySelector(".stream-tab-card")
        ? getComputedStyle(topS2.querySelector(".stream-tab-card"), "::after")
        : null;
      const setTasksAfter = {
        topRunning: topS2?.hasAttribute("data-running") ?? null,
        topCurrent: topS2?.hasAttribute("data-current") ?? null,
        topState: topS2?.dataset.state ?? null,
        rightRunning: rightS2?.hasAttribute("data-running") ?? null,
        rightCurrent: rightS2?.hasAttribute("data-current") ?? null,
        architectCurrent: architectTab?.hasAttribute("data-current") ?? null,
        effectAnimation: effect?.animationName ?? null,
        effectDisplay: effect?.display ?? null,
      };

      window.AgentHub.setTasks([architect, idleS2]);
      window.AgentHub.setRunning("task-s2", true);
      const patchedTopS2 = document.querySelector(
        '.stream-tabs-track .stream-tab[data-stream-name="S2"]',
      );
      const patchedRightS2 = document.querySelector(
        '.activity-stream-item[data-activity-task-id="task-s2"]',
      );
      return {
        before,
        setTasksAfter,
        patchTaskAfter: {
          topRunning: patchedTopS2?.hasAttribute("data-running") ?? null,
          topCurrent: patchedTopS2?.hasAttribute("data-current") ?? null,
          topState: patchedTopS2?.dataset.state ?? null,
          rightRunning: patchedRightS2?.hasAttribute("data-running") ?? null,
          rightCurrent: patchedRightS2?.hasAttribute("data-current") ?? null,
          architectCurrent: document.querySelector(
            '.stream-tabs-track .stream-tab[data-stream-name="Architect"]',
          )?.hasAttribute("data-current") ?? null,
        },
      };
    });

    assert.deepEqual(result, {
      before: { topExists: true, topRunning: false, topCurrent: false },
      setTasksAfter: {
        topRunning: true,
        topCurrent: false,
        topState: "running",
        rightRunning: true,
        rightCurrent: false,
        architectCurrent: true,
        effectAnimation: "stream-running-wave",
        effectDisplay: "block",
      },
      patchTaskAfter: {
        topRunning: true,
        topCurrent: false,
        topState: "running",
        rightRunning: true,
        rightCurrent: false,
        architectCurrent: true,
      },
    });
  } finally {
    await browser.close();
  }
});

test("Workspace and Stream cards expose behavioral editing and quick reply contracts", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    const page = await browser.newPage();
    await openStreamTabsDomFixture(page);
    await page.evaluate(() => {
      window.__hub157Intents = [];
      document.addEventListener("agenthub:intent", (event) => {
        window.__hub157Intents.push(structuredClone(event.detail));
      });
      const shared = {
        workspaceId: "workspace-1",
        workspaceName: "Agent HUB",
        workspaceSettings: { catalogFolder: "Team" },
        status: "ready",
        statusLabel: "Готов",
        lastActivity: "2026-09-04T08:00:00.000Z",
        running: false,
        unread: false,
        streamSettings: {},
      };
      window.__hub157Tasks = [{
        ...shared,
        id: "task-codex",
        selected: true,
        streamId: "stream-codex",
        streamName: "Codex Stream",
        streamOrdinal: 1,
        provider: "codex",
        threadId: "thread-codex",
        agentLabel: "Codex",
      }, {
        ...shared,
        id: "task-claude",
        selected: false,
        streamId: "stream-claude",
        streamName: "Claude Stream",
        streamOrdinal: 2,
        provider: "claude",
        threadId: "thread-claude",
        agentLabel: "Claude",
      }];
      window.AgentHub.setWorkspaces([{
        id: "workspace-1", name: "Agent HUB", settings: { catalogFolder: "Team" },
      }, {
        id: "workspace-2", name: "Archive", settings: { catalogFolder: "Other" },
      }], ["workspace:workspace-1", "workspace:workspace-2", "notes"]);
      window.AgentHub.setSelection({
        quickMessages: {
          global: [],
          workspaces: {
            "workspace-1": [{ title: "Workspace reply", text: "WORKSPACE" }],
          },
          streams: {
            "stream-codex": [{ title: "Stream reply", text: "STREAM" }],
          },
        },
      });
      window.AgentHub.setTasks(window.__hub157Tasks);
      window.__hub157Message = {
        id: "message-1",
        itemId: "item-1",
        turnId: "turn-1",
        threadId: "thread-codex",
        provider: "codex",
        role: "agent",
        author: "Codex",
        text: "Quoted source text",
        time: "08:00",
      };
      window.AgentHub.setMessages("task-codex", [window.__hub157Message]);
    });

    const workspace = page.locator('[data-workspace-select="workspace-1"]');
    await workspace.click();
    assert.equal(await page.locator("[data-workspace-card-modal]").evaluate((node) => node.open), false);
    await workspace.dispatchEvent("contextmenu", { clientX: 80, clientY: 80 });
    assert.deepEqual(await page.locator(".workspace-context-menu:not([hidden]) [role=menuitem]").allTextContents(), [
      "Редактировать…",
    ]);
    await page.keyboard.press("Escape");

    await workspace.focus();
    await workspace.dblclick();
    assert.equal(await page.locator("[data-workspace-card-modal]").evaluate((node) => node.open), true);
    assert.equal(await page.locator("[data-workspace-card-form] input").first().getAttribute("data-workspace-card-name"), "");
    assert.equal(await page.locator("[data-workspace-card-folder]").inputValue(), "Team");
    await page.locator('[data-workspace-card-quick-messages] [data-quick-message-title]').fill("Workspace edited");
    await page.locator("[data-workspace-card-comment]").focus();
    await page.locator("[data-workspace-card-folder]").evaluate((node) => {
      node.value = "Other";
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.locator("[data-workspace-card-submit]").click();
    const workspaceUpdate = await page.evaluate(() => window.__hub157Intents.find((item) => item.type === "workspace:update"));
    assert.equal(workspaceUpdate.folderName, "Other");
    assert.equal(await page.evaluate(() => window.__hub157Intents.some((item) => (
      item.type === "selection:set"
      && item.key === "quickMessages"
      && item.value.workspaces["workspace-1"][0].title === "Workspace edited"
    ))), true);

    const codexTab = page.locator('.stream-tabs-track .stream-tab[data-stream-tab-id="stream-codex"]');
    await codexTab.dispatchEvent("contextmenu", { clientX: 100, clientY: 100 });
    assert.deepEqual(await page.locator(".stream-context-menu:not(.workspace-context-menu):not([hidden]) [role=menuitem]").allTextContents(), [
      "Редактировать…",
      "Ротация",
      "Продолжить в Claude",
    ]);
    await page.keyboard.press("Escape");
    await codexTab.focus();
    await codexTab.dblclick();
    assert.equal(await page.locator("[data-dialog-settings]").evaluate((node) => node.open), true);
    assert.equal(await page.locator("[data-dialog-settings] input").first().getAttribute("data-dialog-stream-name"), "");
    assert.equal(await page.locator("[data-dialog-stream-name]").inputValue(), "Codex Stream");
    await page.locator("[data-dialog-stream-name]").fill("Renamed Stream");
    await page.locator("[data-dialog-working-directory]").focus();
    assert.equal(await page.evaluate(() => window.__hub157Intents.some((item) => (
      item.type === "stream:rename" && item.streamId === "stream-codex" && item.name === "Renamed Stream"
    ))), true);
    assert.equal(await page.locator("[data-stream-card-continue-provider]").textContent(), "Продолжить в Claude");
    assert.equal(await page.locator("[data-stream-card-move-target] option").nth(1).textContent(), "Archive");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("[data-dialog-settings]").evaluate((node) => node.open), false);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.streamTabId), "stream-codex");

    await page.evaluate(() => window.AgentHub.setTasks(window.__hub157Tasks.map((task) => ({
      ...task, selected: task.id === "task-claude",
    }))));
    const claudeTab = page.locator('.stream-tabs-track .stream-tab[data-stream-tab-id="stream-claude"]');
    await claudeTab.dispatchEvent("contextmenu", { clientX: 120, clientY: 100 });
    assert.deepEqual(await page.locator(".stream-context-menu:not(.workspace-context-menu):not([hidden]) [role=menuitem]").allTextContents(), [
      "Редактировать…",
      "Ротация",
      "Продолжить в Codex",
    ]);

    await page.evaluate(() => window.AgentHub.setTasks(window.__hub157Tasks));
    const composer = page.locator("[data-composer-input]");
    await composer.fill("AB");
    await composer.evaluate((node) => node.setSelectionRange(1, 1));
    const workspaceReply = page.locator("[data-composer-quick-messages] [data-quick-message-index]")
      .filter({ hasText: "Workspace edited" });
    await workspaceReply.click();
    assert.equal(await composer.inputValue(), "AWORKSPACEB");
    assert.deepEqual(await composer.evaluate((node) => [node.selectionStart, node.selectionEnd]), [10, 10]);
    assert.equal(await page.evaluate(() => window.__hub157Intents.filter((item) => item.type === "message:send").length), 0);

    const annotationAdded = await page.evaluate(async () => {
      window.AgentHub.selectTask("task-codex");
      window.AgentHub.setMessages("task-codex", [{
        ...window.__hub157Message,
        id: "message-quote",
        itemId: "item-quote",
      }]);
      const source = [...document.querySelectorAll("[data-chat-log] > [data-message-key]")]
        .find((node) => node.textContent.includes("Quoted source text"));
      const body = source?.querySelector(".msg-body");
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return window.AgentHub.addSelectedAnnotation();
    });
    assert.equal(annotationAdded, true);
    const comment = page.locator("[data-annotation-comment-index='0']");
    await comment.fill("XY");
    await comment.evaluate((node) => node.setSelectionRange(1, 1));
    const streamReply = page.locator("[data-composer-quick-messages] [data-quick-message-index]")
      .filter({ hasText: "Stream reply" });
    await streamReply.click();
    assert.equal(await comment.inputValue(), "XSTREAMY");

    const composerBeforeQuickSend = await composer.inputValue();
    const commentBeforeQuickSend = await comment.inputValue();
    await streamReply.click({ modifiers: ["Control"] });
    const quickSend = await page.evaluate(() => window.__hub157Intents.filter((item) => item.type === "message:send").at(-1));
    assert.equal(quickSend.text, "STREAM");
    assert.deepEqual(quickSend.annotations, []);
    assert.deepEqual(quickSend.attachments, []);
    assert.deepEqual(quickSend.taskReferences, []);
    assert.equal(await composer.inputValue(), composerBeforeQuickSend);
    assert.equal(await comment.inputValue(), commentBeforeQuickSend);
    await page.evaluate((requestId) => window.AgentHub.completeSend(requestId, { accepted: true }), quickSend.requestId);

    const sendsBeforeKeyboard = await page.evaluate(() => window.__hub157Intents.filter((item) => item.type === "message:send").length);
    await comment.press("Control+Enter");
    assert.equal((await comment.inputValue()).includes("\n"), true);
    await comment.evaluate((node) => node.setSelectionRange(1, 1));
    await comment.press("Shift+Enter");
    assert.deepEqual(await comment.evaluate((node) => [node.selectionStart, node.selectionEnd]), [2, 2]);
    assert.equal(await page.locator("[data-annotation-comment-index='0']").count(), 1);
    await comment.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await comment.dispatchEvent("keydown", { key: "Enter", repeat: true });
    assert.equal(await page.evaluate(() => window.__hub157Intents.filter((item) => item.type === "message:send").length), sendsBeforeKeyboard);
    await comment.press("Enter");
    const quoteSend = await page.evaluate(() => window.__hub157Intents.filter((item) => item.type === "message:send").at(-1));
    assert.equal(quoteSend.text, composerBeforeQuickSend);
    assert.equal(quoteSend.annotations.length, 1);
    assert.equal(await page.evaluate(() => window.__hub157Intents.filter((item) => item.type === "message:send").length), sendsBeforeKeyboard + 1);
    await page.evaluate((requestId) => window.AgentHub.completeSend(requestId, { accepted: true }), quoteSend.requestId);

    await composer.fill("Steer composition");
    const metaAnnotationAdded = await page.evaluate(() => {
      const source = [...document.querySelectorAll("[data-chat-log] > [data-message-key]")]
        .find((node) => node.textContent.includes("Quoted source text"));
      const body = source?.querySelector(".msg-body");
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return window.AgentHub.addSelectedAnnotation();
    });
    assert.equal(metaAnnotationAdded, true);
    const metaComment = page.locator("[data-annotation-comment-index='0']");
    await metaComment.fill("Steer quote");
    await page.evaluate(() => window.AgentHub.setRunning("task-codex", true));
    await metaComment.dispatchEvent("keydown", { key: "Enter", metaKey: true });
    const metaSend = await page.evaluate(() => window.__hub157Intents.filter((item) => item.type === "message:send").at(-1));
    assert.equal(metaSend.text, "Steer composition");
    assert.equal(metaSend.annotations[0].annotation, "Steer quote");
    assert.equal(metaSend.followUpMode, "steer");
    assert.equal(metaSend.deferWhileRunning, false);
    assert.equal(await page.locator("[data-annotation-comment-index='0']").count(), 0);

    await page.evaluate(() => window.AgentHub.setArchivedWorkspaces([{
      id: "archived-1", name: "Exact Archive", streamCount: 2, threadCount: 3, purgeAfterMs: 1,
    }]));
    await page.locator("[data-action='workspace-archive-open']").click();
    await page.locator("[data-workspace-archive-delete='archived-1']").click();
    assert.match(await page.locator("[data-text-dialog-title]").textContent(), /необратимо/u);
    await page.locator("[data-text-dialog-input]").fill("wrong");
    await page.locator("[data-text-dialog-ok]").click();
    assert.equal(await page.evaluate(() => window.__hub157Intents.some((item) => item.type === "workspace:delete-permanently")), false);
    await page.locator("[data-workspace-archive-delete='archived-1']").click();
    await page.locator("[data-text-dialog-input]").fill("Exact Archive");
    await page.locator("[data-text-dialog-ok]").click();
    assert.deepEqual(await page.evaluate(() => window.__hub157Intents.filter((item) => (
      item.type === "workspace:delete-permanently"
    )).at(-1)), {
      type: "workspace:delete-permanently",
      workspaceId: "archived-1",
      confirmationName: "Exact Archive",
    });
  } finally {
    await browser.close();
  }
});

test("backend permanent-delete rejection retains archive UI and restores exact action focus in installed Edge", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const backend = await startPermanentDeleteConflictBackend();
  const commands = [];
  let page;
  try {
    page = await browser.newPage();
    await openStreamTabsDomFixture(page, {
      includeHubClient: true,
      control: async (request) => {
        commands.push(structuredClone(request));
        const response = await fetch(`${backend.url}api/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        });
        return { status: response.status, body: await response.json() };
      },
    });
    await page.evaluate(() => window.AgentHub.setArchivedWorkspaces([{
      id: "archived-rejected",
      name: "Rejected Archive",
      streamCount: 2,
      threadCount: 3,
      purgeAfterMs: null,
    }]));
    await page.locator("[data-action='workspace-archive-open']").click();
    await page.locator("[data-workspace-archive-delete='archived-rejected']").click();
    await page.locator("[data-text-dialog-input]").fill("Rejected Archive");
    await page.locator("[data-text-dialog-ok]").click();

    await page.locator("[data-toast]").filter({
      hasText: "Сначала переместите или удалите связанные Dashboard Task",
    }).waitFor({ state: "visible" });
    assert.deepEqual(commands.filter(({ action }) => action === "delete-archived-workspace")
      .map(({ action, params }) => ({ action, params })), [{
      action: "delete-archived-workspace",
      params: {
        workspaceId: "archived-rejected",
        confirmationName: "Rejected Archive",
      },
    }]);
    assert.equal(await page.locator("[data-workspace-archive-modal]").evaluate((node) => node.open), true);
    const deleteAction = page.locator("[data-workspace-archive-delete='archived-rejected']");
    assert.equal(await deleteAction.count(), 1);
    assert.equal(await deleteAction.evaluate((node) => document.activeElement === node), true);
  } finally {
    await backend.close();
    await page?.unrouteAll({ behavior: "ignoreErrors" });
    await browser.close();
  }
});

test("card dblclick identity and provider continuation fail closed in installed Edge", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    const page = await browser.newPage();
    await openStreamTabsDomFixture(page);
    await page.evaluate(() => {
      const shared = {
        status: "ready",
        statusLabel: "Готов",
        lastActivity: "2026-09-04T08:00:00.000Z",
        running: false,
        unread: false,
        streamSettings: {},
      };
      window.AgentHub.setWorkspaces([{
        id: "workspace-1", name: "One", settings: {},
      }, {
        id: "workspace-2", name: "Two", settings: {},
      }], ["workspace:workspace-1", "workspace:workspace-2", "notes"]);
      window.AgentHub.setTasks([{
        ...shared,
        id: "task-known",
        selected: true,
        workspaceId: "workspace-1",
        workspaceName: "One",
        streamId: "stream-known",
        streamName: "Known",
        streamOrdinal: 1,
        provider: "codex",
        agentLabel: "Codex",
      }, {
        ...shared,
        id: "task-other",
        selected: false,
        workspaceId: "workspace-1",
        workspaceName: "One",
        streamId: "stream-other",
        streamName: "Other",
        streamOrdinal: 2,
        provider: "claude",
        agentLabel: "Claude",
      }, {
        ...shared,
        id: "task-second-workspace",
        selected: false,
        workspaceId: "workspace-2",
        workspaceName: "Two",
        streamId: "stream-second-workspace",
        streamName: "Second workspace",
        streamOrdinal: 1,
        provider: "codex",
        agentLabel: "Codex",
      }]);
    });

    const replacedWorkspaceResult = await page.evaluate(() => {
      const original = document.querySelector('[data-workspace-select="workspace-1"]');
      original.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      const replacement = original.cloneNode(true);
      original.replaceWith(replacement);
      replacement.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      replacement.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      return {
        open: document.querySelector("[data-workspace-card-modal]").open,
        selected: document.querySelector('[data-workspace-select="workspace-1"]')
          ?.getAttribute("aria-pressed"),
      };
    });
    assert.deepEqual(replacedWorkspaceResult, { open: false, selected: "true" });

    const reorderedStreamResult = await page.evaluate(() => {
      const known = document.querySelector('[data-stream-tab-id="stream-known"]');
      const other = document.querySelector('[data-stream-tab-id="stream-other"]');
      known.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      known.before(other);
      other.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      other.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      return {
        open: document.querySelector("[data-dialog-settings]").open,
        selectedTaskId: document.querySelector('[data-stream-tab-id="stream-other"]')
          ?.dataset.streamTaskId,
      };
    });
    assert.deepEqual(reorderedStreamResult, { open: false, selectedTaskId: "task-other" });

    await page.evaluate(() => {
      const shared = {
        workspaceId: "workspace-1",
        workspaceName: "One",
        status: "ready",
        statusLabel: "Готов",
        lastActivity: "2026-09-04T08:00:00.000Z",
        running: false,
        unread: false,
        streamSettings: {},
      };
      window.AgentHub.setTasks([{
        ...shared,
        id: "task-absent-provider",
        selected: true,
        streamId: "stream-absent-provider",
        streamName: "Absent provider",
        streamOrdinal: 1,
      }, {
        ...shared,
        id: "task-unknown-provider",
        selected: false,
        streamId: "stream-unknown-provider",
        streamName: "Unknown provider",
        streamOrdinal: 2,
        provider: "future-provider",
      }]);
    });
    for (const streamId of ["stream-absent-provider", "stream-unknown-provider"]) {
      const tab = page.locator(`.stream-tabs-track [data-stream-tab-id="${streamId}"]`);
      await tab.dispatchEvent("contextmenu", { clientX: 120, clientY: 100 });
      const actions = page.locator(".stream-context-menu:not(.workspace-context-menu):not([hidden]) [role=menuitem]");
      assert.deepEqual(await actions.allTextContents(), [
        "Редактировать…",
        "Ротация",
        "Продолжение недоступно",
      ]);
      assert.equal(await actions.nth(1).isDisabled(), true);
      assert.equal(await actions.nth(2).isDisabled(), true);
      assert.equal(await actions.nth(2).getAttribute("data-provider"), "");
      await page.keyboard.press("Escape");
    }
  } finally {
    await browser.close();
  }
});

test("Stream display identity never exposes a blank name", async () => {
  const { streamDisplayName } = await streamTabsApi();
  assert.equal(streamDisplayName({ name: " Architect ", ordinal: 2 }, 3), "Architect");
  assert.equal(streamDisplayName({ name: "", ordinal: 2 }, 3), "Stream 2");
  assert.equal(streamDisplayName({ name: "", ordinal: 7 }, 1), "Stream");
});

test("overflow visibility mutations do not rebuild Stream settings", async () => {
  const { streamTabsMutationAction } = await streamTabsApi();
  const overflowTarget = { matches: (selector) => selector.includes(".stream-tab-group") };
  assert.equal(streamTabsMutationAction([{
    type: "attributes",
    attributeName: "hidden",
    target: overflowTarget,
  }]), "align");
  assert.equal(streamTabsMutationAction([{
    type: "attributes",
    attributeName: "data-order-mode",
    target: overflowTarget,
  }]), "sync");
  assert.equal(streamTabsMutationAction([{ type: "childList", target: overflowTarget }]), "sync");
  assert.equal(streamTabsMutationAction([{
    type: "attributes",
    attributeName: "hidden",
    target: { matches: () => false },
  }]), "none");
});

test("answer arrival animation does not replay during Thread selection", async () => {
  const { answerArrivalTaskIds } = await streamTabsApi();
  const observedFinals = new Map();
  const architectFinal = {
    provider: "codex",
    threadId: "thread-architect",
    turnId: "turn-1",
    revision: 1,
  };
  const statisticsFinal = {
    provider: "codex",
    threadId: "thread-statistics",
    turnId: "turn-1",
    revision: 1,
  };
  const previous = [
    { id: "architect", selected: true, unread: true, latestFinal: architectFinal },
    { id: "statistics", selected: false, unread: false, latestFinal: statisticsFinal },
  ];
  const selectedAnotherThread = [
    { id: "architect", selected: false, unread: true, latestFinal: architectFinal },
    { id: "statistics", selected: true, unread: false, latestFinal: statisticsFinal },
  ];

  assert.deepEqual(Array.from(answerArrivalTaskIds(previous, observedFinals)), []);
  assert.deepEqual(Array.from(answerArrivalTaskIds(selectedAnotherThread, observedFinals)), []);
  assert.deepEqual(Array.from(answerArrivalTaskIds([
    selectedAnotherThread[0],
    { ...selectedAnotherThread[1], unread: true },
  ], observedFinals)), []);
  assert.deepEqual(Array.from(answerArrivalTaskIds([
    selectedAnotherThread[0],
    {
      ...selectedAnotherThread[1],
      unread: true,
      latestFinal: { ...statisticsFinal, turnId: "turn-2" },
    },
  ], observedFinals)), ["statistics"]);
});

test("transient snapshot without latest final does not replay answer arrival", async () => {
  const { answerArrivalTaskIds } = await streamTabsApi();
  const observedFinals = new Map();
  const final = {
    provider: "codex",
    threadId: "thread-architect",
    turnId: "turn-1",
    revision: 1,
  };
  const current = [{ id: "architect", unread: true, latestFinal: final }];

  assert.deepEqual(Array.from(answerArrivalTaskIds(current, observedFinals)), []);
  assert.deepEqual(Array.from(answerArrivalTaskIds([
    { id: "architect", unread: true, latestFinal: null },
  ], observedFinals)), []);
  assert.deepEqual(Array.from(answerArrivalTaskIds(current, observedFinals)), []);
  assert.deepEqual(Array.from(answerArrivalTaskIds([
    {
      id: "architect",
      unread: true,
      latestFinal: { ...final, turnId: "turn-2" },
    },
  ], observedFinals)), ["architect"]);
});

test("task hierarchy is recovered by Stream identity when a transient task lacks Workspace fields", async () => {
  const { resolveTaskHierarchy } = await streamTabsApi();
  const workspaces = [{
    id: "workspace-1",
    name: "AgentHub",
    streams: [{ id: "stream-33", name: "Диалоги" }],
  }];
  const resolved = resolveTaskHierarchy({ streamId: "stream-33" }, workspaces);
  assert.equal(resolved.workspace.id, "workspace-1");
  assert.equal(resolved.stream.name, "Диалоги");
});

test("task hierarchy is recovered by unique provider Thread when Stream identity is absent", async () => {
  const { resolveTaskHierarchy } = await streamTabsApi();
  const workspaces = [{
    id: "workspace-1",
    name: "AgentHub",
    streams: [{
      id: "stream-33",
      name: "Диалоги",
      threads: [{ provider: "codex", threadId: "thread-1" }],
    }],
  }];
  const resolved = resolveTaskHierarchy({ provider: "codex", threadId: "thread-1" }, workspaces);
  assert.equal(resolved.workspace.id, "workspace-1");
  assert.equal(resolved.stream.id, "stream-33");

  const ambiguous = resolveTaskHierarchy({ provider: "codex", threadId: "thread-1" }, [
    ...workspaces,
    {
      id: "workspace-2",
      name: "Other",
      streams: [{
        id: "stream-44",
        name: "Stream 1",
        threads: [{ provider: "codex", threadId: "thread-1" }],
      }],
    },
  ]);
  assert.equal(ambiguous.workspace, null);
  assert.equal(ambiguous.stream, null);
});

test("Workspace order follows meaningful activity with deterministic ties", async () => {
  const { orderWorkspaceGroups } = await streamTabsApi();
  const groups = [
    { id: "beta", name: "Бета", kind: "user", tasks: [{ lastActivity: "2026-08-10T09:00:00Z" }] },
    { id: "alpha", name: "Альфа", kind: "user", tasks: [{ lastActivity: "2026-08-10T09:00:00Z" }] },
    { id: "latest", name: "Новый", kind: "user", tasks: [{ lastActivity: "2026-08-10T10:00:00Z" }] },
    { id: "other", name: "Other", kind: "system", tasks: [{ lastActivity: "2026-08-10T11:00:00Z" }] },
  ];
  assert.deepEqual(
    Array.from(orderWorkspaceGroups(groups), (item) => item.id),
    ["latest", "alpha", "beta", "other"],
  );
});

test("Workspace sections keep matching prefixes flat outside explicit folders", async () => {
  const { workspaceSections } = await streamTabsApi();
  const groups = [
    { id: "active", name: "Agent HUB", tasks: [{ running: true, lastActivity: "2026-08-10T10:00:00Z" }] },
    { id: "fb-alpha", name: "FB Альфа", tasks: [{ lastActivity: "2026-08-01T10:00:00Z" }] },
    { id: "fb-beta", name: "FB Бета", tasks: [{ lastActivity: "2026-08-01T09:00:00Z" }] },
    { id: "fb-gamma", name: "FB Гамма", tasks: [{ lastActivity: "2026-08-01T08:00:00Z" }] },
    { id: "solo", name: "Отдельный", tasks: [{ lastActivity: "2026-08-01T07:00:00Z" }] },
  ];
  const sections = workspaceSections(groups, {
    nowMs: Date.parse("2026-08-10T11:00:00Z"),
    activeWindowMs: 1,
  });

  assert.deepEqual(Array.from(sections.active, (group) => group.id), ["active"]);
  assert.deepEqual(JSON.parse(JSON.stringify(sections.catalog.map((entry) => ({
    type: entry.type,
    id: entry.group.id,
    name: entry.group.name,
  })))), [
    { type: "workspace", id: "solo", name: "Отдельный" },
    { type: "workspace", id: "fb-alpha", name: "FB Альфа" },
    { type: "workspace", id: "fb-beta", name: "FB Бета" },
    { type: "workspace", id: "fb-gamma", name: "FB Гамма" },
  ]);
});

test("explicit Workspace folders keep members together and empty folders visible", async () => {
  const { workspaceSections } = await streamTabsApi();
  const sections = workspaceSections([
    {
      id: "urgent",
      name: "Срочный проект",
      folderName: "Клиенты",
      tasks: [{ running: true, lastActivity: "2026-08-10T10:00:00Z" }],
    },
    {
      id: "calm",
      name: "Архивный проект",
      folderName: "Клиенты",
      tasks: [{ lastActivity: "2026-08-01T10:00:00Z" }],
    },
    {
      id: "loose",
      name: "Личное",
      tasks: [{ running: true, lastActivity: "2026-08-10T10:00:00Z" }],
    },
  ], {
    nowMs: Date.parse("2026-08-10T11:00:00Z"),
    activeWindowMs: 1,
    folderNames: ["Пустая"],
  });

  assert.deepEqual(Array.from(sections.active, (group) => group.id), ["loose"]);
  assert.deepEqual(JSON.parse(JSON.stringify(sections.catalog.map((entry) => ({
    type: entry.type,
    name: entry.name,
    items: entry.items?.map((item) => item.id) ?? [],
  })))), [
    { type: "folder", name: "Клиенты", items: ["calm", "urgent"] },
    { type: "folder", name: "Пустая", items: [] },
  ]);
});

test("Workspace folders open for selected, running, or unread children", async () => {
  const { workspaceFolderOpen } = await streamTabsApi();
  const folder = {
    key: "folder:Клиенты",
    name: "Клиенты",
    items: [{ id: "one", tasks: [{ running: false, unread: false }] }],
  };

  assert.equal(workspaceFolderOpen(folder, ["folder:Клиенты"], "other"), false);
  assert.equal(workspaceFolderOpen(folder, ["folder:Клиенты"], "one"), true);
  assert.equal(workspaceFolderOpen({
    ...folder,
    items: [{ id: "one", tasks: [{ running: true }] }],
  }, ["folder:Клиенты"], "other"), true);
  assert.equal(workspaceFolderOpen({
    ...folder,
    items: [{ id: "one", tasks: [{ unread: true }] }],
  }, ["folder:Клиенты"], "other"), true);
});

test("Workspace folder mutations carry only identity and folder while creation can stay ungrouped", async () => {
  const {
    workspaceCreationSettings,
    workspaceFolderMutation,
    workspaceFolderNames,
    workspaceFolderRenamePlan,
  } = await streamTabsApi();
  const workspace = {
    id: "workspace-1",
    settings: { workingDirectory: "project", taskPrefix: "HUB", releaseWorkflowEnabled: true },
  };

  assert.deepEqual(JSON.parse(JSON.stringify(
    workspaceFolderMutation(workspace, "  Важные   проекты  "),
  )), {
    workspaceId: "workspace-1",
    folderName: "Важные проекты",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(workspaceFolderMutation({
    ...workspace,
    settings: { ...workspace.settings, catalogFolder: "Старая" },
  }, ""))), {
    workspaceId: "workspace-1",
    folderName: "",
  });
  assert.deepEqual(Array.from(workspaceFolderNames([
    { settings: { catalogFolder: "Бета" } },
    { settings: { catalogFolder: "Альфа" } },
  ], [" Гамма ", "Альфа"])), ["Альфа", "Бета", "Гамма"]);
  assert.deepEqual(JSON.parse(JSON.stringify(workspaceCreationSettings({
    workingDirectory: "  project  ",
    taskPrefix: " HUB ",
    releaseWorkflowEnabled: true,
    folderName: "  Новые   проекты ",
  }))), {
    workingDirectory: "project",
    taskPrefix: "HUB",
    releaseWorkflowEnabled: true,
    catalogFolder: "Новые проекты",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(
    workspaceCreationSettings({ workingDirectory: "project" }),
  )), {
    workingDirectory: "project",
    taskPrefix: "",
    releaseWorkflowEnabled: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(workspaceFolderRenamePlan([
    { id: "one", settings: { catalogFolder: "Клиенты" } },
    { id: "two", settings: { catalogFolder: "Другое" } },
  ], "Клиенты", " Заказчики ", ["Клиенты", "Другое"]))), {
    fromFolderName: "Клиенты",
    toFolderName: "Заказчики",
    duplicateFolderName: "",
    workspaceIds: ["one"],
  });
  assert.equal(
    workspaceFolderRenamePlan([], "Клиенты", "другое", ["Клиенты", "Другое"]).duplicateFolderName,
    "Другое",
  );
});

test("Workspace archive presentation cancels expiry and keeps exact-name confirmation", async () => {
  const { workspaceArchiveNameMatches, workspaceArchivePresentation } = await streamTabsApi();
  assert.deepEqual(JSON.parse(JSON.stringify(workspaceArchivePresentation([{
    id: "archived",
    name: "Удалённый",
    streamCount: 2,
    threadCount: 5,
    purgeAfterMs: 1_700_000_000_000 + (26 * 60 * 60 * 1000),
  }]))), [{
    id: "archived",
    name: "Удалённый",
    streamCount: 2,
    threadCount: 5,
    purgeAfterMs: null,
  }]);
  assert.equal(workspaceArchiveNameMatches({ name: "Точный регистр" }, "Точный регистр"), true);
  assert.equal(workspaceArchiveNameMatches({ name: "Точный регистр" }, "точный регистр"), false);
});

test("activity rail markup exposes separate active and recent sections", async () => {
  const [html, appSource, clientSource] = await Promise.all([
    readFile(new URL("../../assets/web-app/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8"),
    readFile(new URL("../../assets/web-app/hub-client.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /data-activity-rail-count>Активно</u);
  assert.match(html, /<strong>Недавние<\/strong>/u);
  assert.match(appSource, /activityStreamSections\(entries\)/u);
  assert.match(appSource, /activityStreamList\?\.addEventListener\("click", selectActivityTask\)/u);
  assert.match(appSource, /activityRecentList\?\.addEventListener\("click", selectActivityTask\)/u);
  assert.match(clientSource, /resolveTaskHierarchy\(/u);
});

test("manual mode follows the server-synchronized ordinal order", async () => {
  const { orderWorkspaceStreams, streamsAreDraggable } = await streamTabsApi();
  const streams = [
    stream("third", 3, "2026-08-10T10:00:00.000Z"),
    stream("first", 1, "2026-08-10T09:00:00.000Z"),
    stream("second", 2, "2026-08-10T08:00:00.000Z"),
  ];
  assert.deepEqual(
    Array.from(orderWorkspaceStreams(streams, "manual"), (item) => item.id),
    ["first", "second", "third"],
  );
  assert.equal(streamsAreDraggable("manual", "desktop"), true);
  assert.equal(streamsAreDraggable("activity", "desktop"), false);
  assert.equal(streamsAreDraggable("manual", "mobile"), false);
});

test("pinned Streams stay first in Workspace tabs", async () => {
  const {
    orderWorkspaceStreams,
    pinnedWorkspaceStreamIds,
    streamIsPinned,
    togglePinnedWorkspaceStream,
  } = await streamTabsApi();
  const streams = [
    stream("older", 1, "2026-08-10T08:00:00.000Z"),
    stream("latest", 2, "2026-08-10T10:00:00.000Z"),
    stream("middle", 3, "2026-08-10T09:00:00.000Z"),
  ];
  const selection = {
    pinnedWorkspaceStreams: togglePinnedWorkspaceStream({}, "workspace-1", "older"),
  };

  assert.deepEqual(JSON.parse(JSON.stringify(pinnedWorkspaceStreamIds(selection, "workspace-1"))), ["older"]);
  assert.equal(streamIsPinned(selection, "workspace-1", "older"), true);
  assert.deepEqual(
    Array.from(orderWorkspaceStreams(streams, "activity", ["older"]), (item) => item.id),
    ["older", "latest", "middle"],
  );
  assert.deepEqual(
    Array.from(orderWorkspaceStreams(streams, "manual", ["middle"]), (item) => item.id),
    ["middle", "older", "latest"],
  );
});

test("activity-mode pointer drag scrolls horizontally without native reordering", async () => {
  const { HorizontalPointerScroller } = await streamTabsApi();
  const target = new FakeTarget();
  target.scrollLeft = 120;
  let enabled = true;
  let dragEnds = 0;
  new HorizontalPointerScroller(target, {
    enabled: () => enabled,
    onDragEnd: () => { dragEnds += 1; },
  });
  target.dispatch("pointerdown", { pointerId: 7, pointerType: "mouse", button: 0, clientX: 100 });
  target.dispatch("pointermove", { pointerId: 7, clientX: 70, preventDefault() {} });
  assert.equal(target.scrollLeft, 150);
  assert.equal(target.attributes.has("data-scroll-drag"), true);
  target.dispatch("pointerup", { pointerId: 7 });
  assert.equal(target.attributes.has("data-scroll-drag"), false);
  assert.equal(dragEnds, 1);

  enabled = false;
  target.dispatch("pointerdown", { pointerId: 8, pointerType: "mouse", button: 0, clientX: 100 });
  target.dispatch("pointermove", { pointerId: 8, clientX: 40, preventDefault() {} });
  assert.equal(target.scrollLeft, 150);
});

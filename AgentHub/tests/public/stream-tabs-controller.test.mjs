import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { stressMatrix } from "../helpers/test-profile.mjs";

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

// Один процесс браузера на файл. Измерено 2026-09-11 на этой машине:
// остановка процесса Edge после навигации стоит ~6.4 с, закрытие контекста
// ~10 мс. Каждый тест получает собственные контексты с изолированным
// хранилищем и закрывает только их; процесс закрывается один раз после
// всех тестов файла. Схема повторяет принятую в composer-production.fixture.
let sharedDomBrowserPromise = null;

function sharedDomBrowser(chromium) {
  if (!sharedDomBrowserPromise) {
    const pending = process.platform === "win32"
      ? chromium.launch({ channel: "msedge", headless: true })
      : chromium.launch({ headless: true });
    sharedDomBrowserPromise = pending;
    void pending.catch(() => {
      if (sharedDomBrowserPromise === pending) sharedDomBrowserPromise = null;
    });
  }
  return sharedDomBrowserPromise;
}

after(async () => {
  const pending = sharedDomBrowserPromise;
  sharedDomBrowserPromise = null;
  if (pending) await (await pending).close();
});

async function launchDomBrowser(chromium) {
  const browser = await sharedDomBrowser(chromium);
  const contexts = new Set();
  const creating = new Set();
  let closed = false;
  let closing = null;
  const newContext = async (options) => {
    if (closed) throw new Error("Stream tabs browser handle is closed");
    const pending = browser.newContext(options);
    creating.add(pending);
    try {
      const context = await pending;
      contexts.add(context);
      context.once("close", () => contexts.delete(context));
      if (closed) throw new Error("Stream tabs browser handle is closed");
      return context;
    } finally {
      creating.delete(pending);
    }
  };
  return {
    newContext,
    async newPage(options) {
      // Как browser.newPage(): опции контекста и свежий контекст на страницу.
      return (await newContext(options)).newPage();
    },
    close() {
      if (!closing) {
        closed = true;
        closing = (async () => {
          await Promise.allSettled([...creating]);
          const results = await Promise.allSettled([...contexts].map(async (context) => context.close()));
          const failure = results.find((result) => result.status === "rejected");
          if (failure) throw failure.reason;
        })();
      }
      return closing;
    },
  };
}

async function openStreamTabsDomFixture(page, {
  includeHubClient = false,
  control = null,
  initialSettings = {},
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
      ...initialSettings,
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

// Редактор шаблонов теперь один и живёт в общей форме: прежние места открывают
// её с нужной областью, поэтому и проверки идут через неё.
const PROMPT_TEMPLATES_ENTRY = {
  global: "[data-settings-global-quick-messages-entry]",
  workspace: "[data-workspace-card-quick-messages-entry]",
  stream: "[data-dialog-stream-quick-messages-entry]",
};

// На узких поверхностях карточка Stream в этой фикстуре не разложена и её узлы
// имеют нулевой размер — так было и со встроенным редактором. Там вход
// открывают событием, а настоящую кликабельность проверяют отдельные тесты.
async function openPromptTemplatesForm(page, scope, { synthetic = false } = {}) {
  const entry = page.locator(PROMPT_TEMPLATES_ENTRY[scope]);
  if (synthetic) await entry.dispatchEvent("click");
  else await entry.click();
  await page.waitForFunction(() => document.querySelector("[data-prompt-templates-modal]")?.open === true);
  return page.locator("[data-prompt-templates-editor]");
}

async function closePromptTemplatesForm(page, { synthetic = false } = {}) {
  const open = await page.evaluate(() => document.querySelector("[data-prompt-templates-modal]")?.open === true);
  if (!open) return;
  const done = page.locator("[data-prompt-templates-done]");
  if (synthetic) await done.dispatchEvent("click");
  else await done.click();
  await page.waitForFunction(() => document.querySelector("[data-prompt-templates-modal]")?.open !== true);
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

test("persisted rotation restores the source event without observing the Thread transition", async () => {
  const { persistedStreamRotationMessages } = await streamTabsApi();
  const source = {
    streamId: "stream-1", provider: "codex", threadId: "source",
    context: { compaction: {
      operationId: "compaction-1", status: "completed", rotated: true,
      afterPercent: 26, completedAt: "2026-09-10T20:55:00.000Z",
    } },
  };
  const current = {
    streamId: "stream-1", provider: "codex", threadId: "current",
    context: { percent: 81 },
  };
  const [message] = persistedStreamRotationMessages([source, current]);
  assert.equal(message.sourceThreadId, "source");
  assert.equal(message.threadId, "source", "legacy evidence does not invent a target");
  assert.equal(message.afterPercent, null, "current usage is not a historical probe");
  assert.equal(message.maintenanceLabel, "Ротация завершена");
  assert.doesNotMatch(message.maintenanceDetail, /выполняется/u);
  assert.equal(message.placement, "after-source-turn");
  assert.equal(message.time, source.context.compaction.completedAt);
  const reloaded = persistedStreamRotationMessages(JSON.parse(JSON.stringify([source, current])));
  assert.equal(JSON.stringify(reloaded), JSON.stringify([message]));
  assert.equal(persistedStreamRotationMessages([source, source, current]).length, 1);
});

test("persisted rotation uses only exact recorded target and probe measurements", async () => {
  const { persistedStreamRotationMessages } = await streamTabsApi();
  const source = {
    streamId: "stream-1", provider: "codex", threadId: "source",
    context: { compaction: {
      id: "compaction-1", status: "completed", rotated: true, afterPercent: 26,
      rotationThreadId: "target", rotationAfterPercent: 7,
      rotationCompletedAt: "2026-09-10T20:56:00.000Z",
      completedAt: "2026-09-10T20:55:00.000Z",
    } },
  };
  const [message] = persistedStreamRotationMessages([source]);
  assert.equal(message.threadId, "target");
  assert.equal(message.afterPercent, 7);
  assert.equal(message.time, source.context.compaction.rotationCompletedAt);
  assert.equal(
    message.text,
    "Ротация завершена. Использование контекста: после свёртки 26% → новый Thread сразу после переноса 7%",
  );
  for (const patch of [{ rotated: false }, { status: "running" }, { status: "unknown" }, { id: "" }]) {
    assert.equal(persistedStreamRotationMessages([{
      ...source, context: { compaction: { ...source.context.compaction, ...patch } },
    }]).length, 0);
  }
  assert.equal(persistedStreamRotationMessages([{ ...source, streamId: "" }]).length, 0);
});

// Случай пользователя: уведомление говорило «новый 11%», а новый Thread уже
// показывал 27%. Оба числа верны, но относятся к разным моментам — подача
// обязана называть этап и не выдавать живое значение за замер ротации.
test("rotation stages stay historical while the new Thread's live usage grows", async () => {
  const { persistedStreamRotationMessages, rotationMaintenancePresentation } = await streamTabsApi();
  const source = {
    streamId: "stream-1", provider: "codex", threadId: "source",
    context: { compaction: {
      id: "ac912f09", status: "completed", rotated: true,
      beforePercent: 85.532508, afterPercent: 27.278251,
      rotationThreadId: "target", rotationAfterPercent: 11.256192,
      rotationProbeTurnId: "probe-target", rotationMeasuredAt: "2026-09-12T22:10:34.367Z",
      rotationCompletedAt: "2026-09-12T22:10:34.500Z", completedAt: "2026-09-12T22:10:23.671Z",
    } },
  };
  const target = {
    streamId: "stream-1", provider: "codex", threadId: "target",
    context: { percent: 27.0855 },
  };

  const [message] = persistedStreamRotationMessages([source, target]);

  assert.equal(
    message.text,
    "Ротация завершена. Использование контекста: до свёртки 86% → после свёртки 27% → новый Thread сразу после переноса 11%",
  );
  assert.equal(message.afterPercent, 11, "живое использование нового Thread не подменяет замер ротации");
  assert.equal(message.beforePercent, 27);
  assert.equal(message.compactionBeforePercent, 86);
  assert.doesNotMatch(message.text, /новый Thread[^%]*27%/u);
  assert.equal(
    rotationMaintenancePresentation(27, null).text,
    "Ротация завершена. Использование контекста: после свёртки 27% → новый Thread создан, его замер не сохранён",
  );
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
  assert.equal(quickMessagesCountLabel(0), "0 шаблонов");
  assert.equal(quickMessagesCountLabel(1), "1 шаблон");
  assert.equal(quickMessagesCountLabel(2), "2 шаблона");
  assert.equal(quickMessagesCountLabel(5), "5 шаблонов");
  assert.equal(quickMessagesCountLabel(11), "11 шаблонов");
  assert.equal(quickMessagesCountLabel(21), "21 шаблон");
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
    "arrow-down",
    "arrow-up",
    "arrow-clockwise",
    "arrows-down-up",
    "caret-down",
    "caret-left",
    "caret-right",
    "caret-up",
    "clock-counter-clockwise",
    "copy",
    "folder",
    "list-bullets",
    "pencil-simple",
    "plus",
    "push-pin-simple",
    "trash",
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

test("right panel visibility defaults on and its header switch preserves hidden options across reload", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    for (const width of [1440, 1024]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const populate = async () => {
        await page.evaluate(() => {
          window.AgentHub.setWorkspaces([{ id: "rail-workspace", name: "Panel preview", settings: {} }]);
          window.AgentHub.setTasks([{
            id: "rail-task", threadId: "rail-thread", workspaceId: "rail-workspace",
            workspaceName: "Panel preview", streamId: "rail-stream", streamName: "Preview",
            streamOrdinal: 1, provider: "codex", agentLabel: "Codex", status: "ready",
            statusLabel: "Готов", lastActivity: new Date().toISOString(),
            running: false, unread: true, selected: true, streamSettings: {},
          }]);
        });
        await page.locator("[data-stream-card-settings-toggle]").click();
      };
      await openStreamTabsDomFixture(page);
      await populate();
      const group = page.getByRole("region", { name: "Правая панель", exact: true });
      const toggle = group.getByRole("switch", { name: "Отображать правую панель", exact: true });
      const options = group.locator("[data-activity-rail-settings]");
      const recent = group.getByRole("spinbutton", { name: "Часы для недавних Streams" });
      const detailed = group.getByRole("switch", { name: "Подробные карточки Streams" });
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      assert.equal(await page.locator("[data-activity-rail]").isVisible(), true);
      assert.equal(await options.isVisible(), true);
      assert.equal(await page.locator("[data-settings-panel] [data-activity-rail-visibility-toggle]").count(), 0);
      const headingBox = await group.getByRole("heading", { name: "Правая панель" }).boundingBox();
      const toggleBox = await toggle.boundingBox();
      assert.ok(toggleBox.x >= headingBox.x + headingBox.width);
      assert.ok(Math.abs(toggleBox.y + toggleBox.height / 2 - headingBox.y - headingBox.height / 2) < 4);
      assert.equal((await toggle.innerText()).trim(), "");
      await recent.fill("7");
      await recent.press("Tab");
      await detailed.click();
      assert.equal(await detailed.getAttribute("aria-checked"), "true");
      const screenshotDirectory = String(process.env.HUB157_QA_SCREENSHOT_DIR ?? "").trim();
      if (screenshotDirectory) {
        await group.screenshot({
          path: path.join(screenshotDirectory, `right-panel-on-${width}.png`),
        });
      }
      await toggle.click();
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      assert.equal(await options.isVisible(), false);
      assert.equal(await page.locator("[data-activity-rail]").isVisible(), false);
      assert.equal(await toggle.isVisible(), true);
      if (screenshotDirectory) {
        await group.screenshot({
          path: path.join(screenshotDirectory, `right-panel-off-${width}.png`),
        });
      }
      await toggle.click();
      assert.equal(await recent.inputValue(), "7");
      assert.equal(await detailed.getAttribute("aria-checked"), "true");
      await toggle.click();
      await page.reload();
      await page.waitForFunction(() => typeof window.AgentHub === "object");
      await populate();
      assert.equal(await toggle.getAttribute("aria-checked"), "false");
      assert.equal(await options.isVisible(), false);
      assert.equal(await page.locator("[data-activity-rail]").isVisible(), false);
      await toggle.focus();
      await toggle.press("Space");
      assert.equal(await toggle.getAttribute("aria-checked"), "true");
      assert.equal(await options.isVisible(), true);
      assert.equal(await detailed.getAttribute("aria-checked"), "true");
      assert.equal(await page.locator("[data-activity-rail]").isVisible(), true);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
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
    await page.emulateMedia({ reducedMotion: "no-preference" });
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
      const effect = topS2?.querySelector(".stream-tab-status-layer")
        ? getComputedStyle(topS2.querySelector(".stream-tab-status-layer"), "::after")
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
    assert.equal(await page.locator("[data-workspace-card-archive]").evaluate((node) => (
      Boolean(node.closest(".workspace-card-fields")) && !node.closest("footer")
    )), true);
    assert.equal(await page.locator("[data-workspace-card-form] input").first().getAttribute("data-workspace-card-name"), "");
    assert.equal(await page.locator("[data-workspace-card-folder]").inputValue(), "Team");
    const workspaceTemplates = await openPromptTemplatesForm(page, "workspace");
    await workspaceTemplates.locator("[data-quick-message-title]").fill("Workspace edited");
    await workspaceTemplates.locator("[data-quick-message-title]").dispatchEvent("change");
    await closePromptTemplatesForm(page);
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
    assert.equal(await page.locator("[data-dialog-settings]").getAttribute("aria-label"), "Карточка Stream");
    assert.equal(await page.getByText("Карточка Stream", { exact: true }).count(), 0);
    assert.equal(await page.locator("[data-dialog-settings] input").first().getAttribute("data-dialog-stream-name"), "");
    assert.equal(await page.locator("[data-dialog-stream-name]").inputValue(), "Codex Stream");
    await page.locator("[data-dialog-stream-name]").fill("Renamed Stream");
    await page.locator("[data-dialog-working-directory]").focus();
    assert.equal(await page.evaluate(() => window.__hub157Intents.some((item) => (
      item.type === "stream:rename" && item.streamId === "stream-codex" && item.name === "Renamed Stream"
    ))), true);
    assert.equal(await page.locator("[data-stream-card-continue-provider]").textContent(), "Продолжить в Claude");
    assert.equal(await page.locator("[data-stream-card-move-target]").count(), 0);
    const moveButton = page.locator("[data-stream-card-move]");
    assert.equal(await moveButton.textContent(), "Перенести в другой Workspace");
    const cardSpacing = await page.evaluate(() => {
      const save = document.querySelector("[data-dialog-stream-rules-save]").getBoundingClientRect();
      const rules = document.querySelector(".stream-agent-rules").getBoundingClientRect();
      const rulesCardNode = document.querySelector(".agent-rules-card");
      const rulesCard = rulesCardNode.getBoundingClientRect();
      const rulesCardStyle = getComputedStyle(rulesCardNode);
      const section = document.querySelector(".stream-card-actions-section").getBoundingClientRect();
      const title = document.querySelector(".stream-card-actions-section .settings-section-title").getBoundingClientRect();
      const card = document.querySelector(".stream-card-actions").getBoundingClientRect();
      const pin = document.querySelector("[data-stream-card-pin]").getBoundingClientRect();
      const archive = document.querySelector("[data-stream-card-archive]").getBoundingClientRect();
      return {
        insideRulesCard: rulesCard.bottom - Number.parseFloat(rulesCardStyle.borderBottomWidth) - save.bottom,
        afterRulesSave: rules.bottom - save.bottom,
        beforeActions: title.top - section.top,
        beforePin: pin.top - card.top,
        afterArchive: card.bottom - archive.bottom,
      };
    });
    for (const gap of Object.values(cardSpacing)) assert.ok(gap >= 6, JSON.stringify(cardSpacing));
    await moveButton.click();
    const moveMenu = page.locator("[data-stream-card-move-menu]");
    assert.equal(await moveMenu.evaluate((node) => node.matches(":popover-open")), true);
    assert.equal(await moveMenu.locator("[role=menuitem]").allTextContents().then((items) => items.join("|")), "Archive");
    assert.equal(await moveMenu.locator("[role=menuitem]").evaluate((node) => document.activeElement === node), true);
    await page.keyboard.press("Escape");
    assert.equal(await moveMenu.evaluate((node) => node.matches(":popover-open")), false);
    assert.equal(await moveButton.evaluate((node) => document.activeElement === node), true);
    const movesBeforeStaleChoice = await page.evaluate(() => window.__hub157Intents.filter((item) => (
      item.type === "stream:move"
    )).length);
    await moveButton.click();
    const staleOption = moveMenu.locator("[role=menuitem]");
    await staleOption.evaluate((node) => { node.dataset.streamCardMoveWorkspace = "workspace-missing"; });
    await staleOption.click();
    assert.equal(await page.evaluate(() => window.__hub157Intents.filter((item) => (
      item.type === "stream:move"
    )).length), movesBeforeStaleChoice);
    assert.equal(await moveMenu.evaluate((node) => node.matches(":popover-open")), false);
    await moveButton.click();
    await moveMenu.locator("[data-stream-card-move-workspace='workspace-2']").click();
    assert.equal(await page.evaluate(() => window.__hub157Intents.some((item) => (
      item.type === "stream:move" && item.streamId === "stream-codex" && item.workspaceId === "workspace-2"
    ))), true);
    assert.equal(await page.locator("[data-dialog-settings]").evaluate((node) => node.open), false);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.streamTabId), "stream-codex");

    await page.evaluate(() => {
      window.AgentHub.setWorkspaces([{
        id: "workspace-1", name: "Agent HUB", settings: { catalogFolder: "Team" },
      }], ["workspace:workspace-1", "notes"]);
      window.AgentHub.setTasks(window.__hub157Tasks);
    });
    const codexTabWithoutMoveTarget = page.locator('.stream-tabs-track .stream-tab[data-stream-tab-id="stream-codex"]');
    await codexTabWithoutMoveTarget.dblclick();
    assert.equal(await page.locator("[data-stream-card-move]").isDisabled(), true);
    assert.equal(await page.locator("[data-stream-card-move-menu] [role=menuitem]").count(), 0);
    await page.keyboard.press("Escape");

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

    await page.evaluate(() => window.AgentHub.setSelection({ quickMessageActionMode: "send" }));
    await composer.fill("Existing draft");
    const sendsBeforePrimarySend = await page.evaluate(() => window.__hub157Intents.filter((item) => (
      item.type === "message:send"
    )).length);
    await workspaceReply.click();
    const primarySend = await page.evaluate(() => window.__hub157Intents.filter((item) => item.type === "message:send").at(-1));
    assert.equal(primarySend.text, "WORKSPACE");
    assert.equal(await composer.inputValue(), "Existing draft");
    assert.equal(await page.evaluate(() => window.__hub157Intents.filter((item) => (
      item.type === "message:send"
    )).length), sendsBeforePrimarySend + 1);
    await page.evaluate((requestId) => window.AgentHub.completeSend(requestId, { accepted: true }), primarySend.requestId);
    await composer.focus();
    await composer.evaluate((node) => node.setSelectionRange(8, 8));
    await workspaceReply.click({ modifiers: ["Control"] });
    assert.equal(await composer.inputValue(), "ExistingWORKSPACE draft");
    assert.match(await workspaceReply.getAttribute("title"), /Отправить сразу.*Ctrl.*вставить/u);

    await page.evaluate(() => window.AgentHub.setSelection({ quickMessageActionMode: "invalid" }));
    await composer.fill("");
    await workspaceReply.click();
    assert.equal(await composer.inputValue(), "WORKSPACE");
    assert.match(await workspaceReply.getAttribute("aria-label"), /Вставить в поле.*Ctrl.*отправить/u);
    await composer.fill(composerBeforeQuickSend);

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

test("composer quick replies render above attached Task references", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 920, height: 640 } });
    await openStreamTabsDomFixture(page);
    await page.evaluate(() => {
      window.__hub157Intents = [];
      document.addEventListener("agenthub:intent", (event) => {
        window.__hub157Intents.push(structuredClone(event.detail));
      });
      window.AgentHub.setWorkspaces([{
        id: "workspace-1", name: "Agent HUB", settings: {},
      }], ["workspace:workspace-1", "notes"]);
      window.AgentHub.setSelection({
        quickMessages: {
          global: [{ title: "Принято", text: "Принято" }],
          workspaces: {
            "workspace-1": [{ title: "Workspace", text: "Workspace prompt" }],
          },
          streams: {
            "stream-1": [{ title: "Stream", text: "Stream prompt" }],
          },
        },
      });
      window.AgentHub.setTasks([{
        id: "task-1",
        selected: true,
        workspaceId: "workspace-1",
        workspaceName: "Agent HUB",
        streamId: "stream-1",
        streamName: "Dashboard",
        streamOrdinal: 1,
        provider: "codex",
        agentLabel: "Codex",
        status: "ready",
        statusLabel: "Готов",
        lastActivity: "2026-09-08T08:00:00.000Z",
        running: false,
        unread: false,
        streamSettings: {},
      }]);
      const transfer = new DataTransfer();
      window.AgentHubTaskReferences.beginDrag(transfer, {
        id: "linked-task",
        taskNumber: "HUB-157",
        title: "Переработать карточки Workspace/Stream",
        workflowStatus: "awaiting_implementation",
        workspaceId: "workspace-1",
      }, { intent: "context" });
      document.querySelector('[data-stream-tab-id="stream-1"]').dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
      window.AgentHubTaskReferences.endDrag();
    });

    const layout = await page.evaluate(() => {
      const quickReplies = document.querySelector("[data-composer-quick-messages]");
      const attachments = document.querySelector("[data-attachments]");
      const quickRect = quickReplies.getBoundingClientRect();
      const attachmentRect = attachments.getBoundingClientRect();
      return {
        quickRepliesVisible: !quickReplies.hidden && quickRect.height > 0,
        attachmentsVisible: !attachments.hidden && attachmentRect.height > 0,
        sourceOrder: Boolean(quickReplies.compareDocumentPosition(attachments)
          & Node.DOCUMENT_POSITION_FOLLOWING),
        visualOrder: quickRect.bottom <= attachmentRect.top,
      };
    });
    assert.deepEqual(layout, {
      quickRepliesVisible: true,
      attachmentsVisible: true,
      sourceOrder: true,
      visualOrder: true,
    });
    assert.equal(await page.locator("[data-composer-quick-messages]").getAttribute("aria-label"), "Prompt-шаблоны");
    assert.equal(await page.locator("[data-settings-global-quick-messages-entry]").evaluate((node) => (
      node.closest(".quick-messages-settings-row")?.querySelector(".setting-name")?.textContent
    )), "Глобальные prompt-шаблоны");
    assert.equal(await page.locator("[data-settings-global-quick-messages-count]").textContent(), "1 шаблон");
    await page.locator('[data-panel-open="settings"]').click();
    const actionMode = page.locator("[data-quick-message-action-mode]");
    const actionModeNote = page.locator("[data-quick-message-action-mode-note]");
    assert.equal(await actionMode.inputValue(), "insert");
    assert.equal(await actionModeNote.textContent(), "Ctrl + нажатие — отправить.");
    await actionMode.evaluate((node) => {
      node.value = "send";
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(await actionModeNote.textContent(), "Ctrl + нажатие — вставить в поле.");
    assert.equal(await page.evaluate(() => window.__hub157Intents.some((item) => (
      item.type === "selection:set"
      && item.key === "quickMessageActionMode"
      && item.value === "send"
    ))), true);
    await actionMode.evaluate((node) => {
      node.value = "insert";
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const globalEditor = await openPromptTemplatesForm(page, "global");
    assert.equal(await globalEditor.isVisible(), true);
    assert.equal(await globalEditor.locator("[data-quick-message-row]").count(), 1);
    assert.equal(await globalEditor.locator("[data-quick-message-title]").inputValue(), "Принято");
    assert.equal(await globalEditor.locator("[data-quick-message-text]").inputValue(), "Принято");
    assert.equal(await globalEditor.locator("[data-quick-message-add]").textContent(), "Добавить шаблон");
    assert.equal(await globalEditor.locator('[data-quick-message-add] svg[data-phosphor-icon="plus"]').count(), 1);
    await globalEditor.locator("[data-quick-message-add]").click();
    assert.equal(await globalEditor.locator("[data-quick-message-row]").count(), 2);
    await globalEditor.locator("[data-quick-message-title]").nth(1).fill("Продолжай");
    await globalEditor.locator("[data-quick-message-text]").nth(1).fill("Продолжай работу");
    await globalEditor.locator("[data-quick-message-text]").nth(1).dispatchEvent("change");
    assert.equal(await page.evaluate(() => window.__hub157Intents.some((item) => (
      item.type === "selection:set"
      && item.key === "quickMessages"
      && item.value.global[1]?.title === "Продолжай"
      && item.value.global[1]?.text === "Продолжай работу"
    ))), true);
    assert.equal(await page.locator("[data-text-dialog]").isHidden(), true);
    await closePromptTemplatesForm(page);
    await page.locator("[data-panel-close]").click();

    const workspace = page.locator('[data-workspace-select="workspace-1"]');
    await workspace.dblclick();
    assert.equal(await page.getByText("Prompt-шаблоны Workspace", { exact: true }).isVisible(), true);
    assert.equal(await page.locator("[data-workspace-card-quick-messages-count]").textContent(), "1 шаблон");
    const workspaceEditor = await openPromptTemplatesForm(page, "workspace");
    assert.equal(await workspaceEditor.locator("[data-quick-message-add]").textContent(), "Добавить шаблон");
    assert.equal(await workspaceEditor.locator(
      "[data-quick-message-title]",
    ).getAttribute("aria-label"), "Название prompt-шаблона 1");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    const stream = page.locator('.stream-tabs-track [data-stream-tab-id="stream-1"]');
    await stream.dblclick();
    assert.equal(await page.getByText("Prompt-шаблоны потока", { exact: true }).isVisible(), true);
    assert.equal(await page.locator("[data-dialog-stream-quick-messages-count]").textContent(), "1 шаблон");
    const streamEditor = await openPromptTemplatesForm(page, "stream");
    assert.equal(await streamEditor.locator("[data-quick-message-add]").textContent(), "Добавить шаблон");
    assert.equal(await streamEditor.locator(
      "[data-quick-message-title]",
    ).getAttribute("aria-label"), "Название prompt-шаблона 1");
  } finally {
    await browser.close();
  }
});

test("shared prompt template editor preserves accordion identity and scope behavior", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 980, height: 760 } });
    await openStreamTabsDomFixture(page);
    await page.evaluate(() => {
      window.__promptEditorIntents = [];
      document.addEventListener("agenthub:intent", (event) => {
        window.__promptEditorIntents.push(structuredClone(event.detail));
      });
      window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent HUB", settings: {} }]);
      window.AgentHub.setSelection({
        quickMessages: {
          global: [
            { title: "A", text: "Alpha body" },
            { title: "B", text: "Beta body" },
            { title: "C", text: "Gamma body" },
          ],
          workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace body" }] },
          streams: { "stream-1": [{ title: "Stream", text: "Stream body" }] },
        },
      });
      window.AgentHub.setTasks([{
        id: "task-1", selected: true, workspaceId: "workspace-1", workspaceName: "Agent HUB",
        streamId: "stream-1", streamName: "Dialog", streamOrdinal: 1, provider: "codex",
        agentLabel: "Codex", status: "ready", statusLabel: "Готов", running: false,
        unread: false, streamSettings: {},
      }]);
    });
    await page.locator('[data-panel-open="settings"]').click();
    const editor = await openPromptTemplatesForm(page, "global");
    const rows = editor.locator("[data-quick-message-row]");
    assert.equal(await rows.count(), 3);
    assert.equal(await editor.locator(".quick-message-editor-details:not([hidden])").count(), 1);
    assert.equal(await page.locator("[data-settings-global-quick-messages-count]").textContent(), "3 шаблона");
    assert.deepEqual(await rows.first().locator(".quick-message-editor-order svg").evaluateAll(
      (nodes) => nodes.map((node) => node.dataset.phosphorIcon),
    ), ["arrow-up", "arrow-down"]);
    assert.equal(await rows.first().locator(".quick-message-editor-action.toggle svg").getAttribute("data-phosphor-icon"), "caret-down");
    assert.equal(await rows.nth(1).locator(".quick-message-editor-action.toggle svg").getAttribute("data-phosphor-icon"), "caret-right");
    assert.deepEqual(await rows.first().locator(".quick-message-editor-footer-order svg").evaluateAll(
      (nodes) => nodes.map((node) => node.dataset.phosphorIcon),
    ), ["arrow-up", "arrow-down", "copy"]);
    assert.equal(await rows.first().locator('svg[data-phosphor-icon="arrow-up"] path').first().getAttribute("d")
      === await rows.first().locator('svg[data-phosphor-icon="caret-down"] path').getAttribute("d"), false);
    const initialIds = await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.quickMessageRow));

    await rows.nth(1).locator(".quick-message-editor-summary").click();
    assert.equal(await rows.nth(1).locator(".quick-message-editor-summary").getAttribute("aria-expanded"), "true");
    await rows.nth(1).locator('.quick-message-editor-order [data-quick-message-action="up"]').click();
    assert.deepEqual(await editor.locator(".quick-message-editor-title").allTextContents(), ["B", "A", "C"]);
    assert.equal(await rows.first().getAttribute("data-quick-message-row"), initialIds[1]);
    assert.equal(await rows.first().locator(".quick-message-editor-summary").getAttribute("aria-expanded"), "true");

    const title = rows.first().locator("[data-quick-message-title]");
    await title.fill("B edited");
    await title.evaluate((node) => {
      node.focus();
      node.setSelectionRange(2, 2);
      window.AgentHub.setSelection({ activityRecentMinutes: 31 });
    });
    assert.deepEqual(await page.evaluate(() => ({
      id: document.activeElement?.closest("[data-quick-message-row]")?.dataset.quickMessageRow,
      field: document.activeElement?.hasAttribute("data-quick-message-title"),
      start: document.activeElement?.selectionStart,
    })), { id: initialIds[1], field: true, start: 2 });

    await rows.first().locator('.quick-message-editor-footer [data-quick-message-action="duplicate"]').click();
    assert.deepEqual(await editor.locator(".quick-message-editor-title").allTextContents(), [
      "B edited", "B edited (копия)", "A", "C",
    ]);
    assert.equal(await rows.nth(1).locator(".quick-message-editor-summary").getAttribute("aria-expanded"), "true");
    assert.equal(await rows.nth(1).locator("[data-quick-message-title]").evaluate((node) => document.activeElement === node), true);
    await rows.nth(1).locator('[data-quick-message-action="delete"]').click();
    assert.equal(await rows.nth(1).locator(".quick-message-editor-title").textContent(), "A");
    assert.equal(await rows.nth(1).locator(".quick-message-editor-summary").getAttribute("aria-expanded"), "true");

    await rows.last().locator(".quick-message-editor-summary").focus();
    await page.keyboard.press("Space");
    assert.equal(await rows.last().locator(".quick-message-editor-summary").getAttribute("aria-expanded"), "true");
    await rows.last().locator('[data-quick-message-action="delete"]').click();
    assert.equal(await rows.last().locator(".quick-message-editor-title").textContent(), "A");
    assert.equal(await rows.last().locator(".quick-message-editor-summary").getAttribute("aria-expanded"), "true");
    assert.equal(await rows.first().locator('.quick-message-editor-order [data-quick-message-action="up"]').isDisabled(), true);
    assert.equal(await rows.last().locator('.quick-message-editor-order [data-quick-message-action="down"]').isDisabled(), true);

    await editor.locator("[data-quick-message-add]").click();
    assert.equal(await rows.count(), 3);
    assert.equal(await rows.last().locator("[data-quick-message-title]").evaluate((node) => document.activeElement === node), true);
    assert.equal(await page.locator("[data-settings-global-quick-messages-count]").textContent(), "3 шаблона");
    assert.equal(await editor.locator('svg[data-phosphor-icon="copy"]').count() > 0, true);
    assert.equal(await editor.locator('svg[data-phosphor-icon="trash"]').count() > 0, true);
    assert.equal(await editor.locator("svg path").evaluateAll((paths) => paths.every((node) => node.getAttribute("fill") === "currentColor")), true);

    const lastQuickMessages = await page.evaluate(() => window.__promptEditorIntents
      .filter((intent) => intent.type === "selection:set" && intent.key === "quickMessages").at(-1)?.value);
    assert.deepEqual(lastQuickMessages.workspaces["workspace-1"], [{ title: "Workspace", text: "Workspace body" }]);
    assert.deepEqual(lastQuickMessages.streams["stream-1"], [{ title: "Stream", text: "Stream body" }]);

    await page.evaluate(() => window.AgentHub.setSelection({
      quickMessages: {
        global: Array.from({ length: 20 }, (_, index) => ({
          title: index === 0 ? "Очень длинное название prompt-шаблона, которое обязано сжиматься" : `Template ${index + 1}`,
          text: index === 0 ? "Очень длинный preview ".repeat(20) : `Body ${index + 1}`,
        })),
        workspaces: { "workspace-1": [{ title: "Workspace", text: "Workspace body" }] },
        streams: { "stream-1": [{ title: "Stream", text: "Stream body" }] },
      },
    }));
    // Добавленная строка ещё не записана, поэтому входящий снимок её не
    // подменяет: показывается расхождение, а решение принимает человек.
    assert.equal(await rows.count(), 3);
    assert.equal(await page.locator("[data-prompt-templates-conflict]").isVisible(), true);
    await page.locator("[data-prompt-templates-reload]").click();
    assert.equal(await rows.count(), 20);
    assert.equal(await editor.locator("[data-quick-message-add]").isDisabled(), true);
    const overflow = await editor.evaluate((node) => ({
      editor: node.scrollWidth - node.clientWidth,
      row: node.querySelector("[data-quick-message-row]").scrollWidth
        - node.querySelector("[data-quick-message-row]").clientWidth,
    }));
    assert.ok(overflow.editor <= 1, JSON.stringify(overflow));
    assert.ok(overflow.row <= 1, JSON.stringify(overflow));
  } finally {
    await browser.close();
  }
});

test("prompt template editor keeps rejected drafts and persists a successful retry", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  let serverQuickMessages = {
    global: [{ title: "Confirmed", text: "Confirmed body" }], workspaces: {}, streams: {},
  };
  let rejectNext = true;
  let observeRejectedUpdate;
  const rejectedUpdateObserved = new Promise((resolve) => { observeRejectedUpdate = resolve; });
  let releaseRejectedUpdate;
  const rejectedUpdateGate = new Promise((resolve) => { releaseRejectedUpdate = resolve; });
  let observeSuccessfulUpdate;
  const successfulUpdateObserved = new Promise((resolve) => { observeSuccessfulUpdate = resolve; });
  const snapshot = () => ({
    apiVersion: 3,
    version: `prompt-editor-${JSON.stringify(serverQuickMessages).length}`,
    server: { status: "online" },
    tasks: [], workspaces: [], archivedWorkspaces: [], boardTasks: [],
    boardLayout: { columnOrder: [] }, deferredInputs: [], messageReceipts: [], pendingApprovals: [],
    settings: {
      provider: "codex", models: [], modelOptionsByProvider: {}, reasoningOptions: [],
      reasoningOptionsByProvider: {}, modeOptions: [], quickMessages: serverQuickMessages,
    },
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
    await openStreamTabsDomFixture(page, {
      includeHubClient: true,
      initialSettings: { quickMessages: serverQuickMessages },
      control: async (request) => {
        if (request.action !== "update-setting" || request.params?.name !== "quickMessages") {
          return { status: 200, body: { ok: true, result: snapshot() } };
        }
        if (rejectNext) {
          rejectNext = false;
          observeRejectedUpdate();
          await rejectedUpdateGate;
          return { status: 400, body: { ok: false, error: "Synthetic persistence rejection" } };
        }
        const next = JSON.parse(request.params.value);
        serverQuickMessages.global = next.global;
        serverQuickMessages.workspaces = next.workspaces;
        serverQuickMessages.streams = next.streams;
        observeSuccessfulUpdate();
        return { status: 200, body: { ok: true, result: snapshot() } };
      },
    });
    await page.evaluate(() => {
      window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent HUB", settings: {} }]);
      window.AgentHub.setTasks([{
        id: "task-1", selected: true, workspaceId: "workspace-1", workspaceName: "Agent HUB",
        streamId: "stream-1", streamName: "Dialog", streamOrdinal: 1, provider: "codex",
        agentLabel: "Codex", status: "ready", statusLabel: "Готов", running: false,
        unread: false, streamSettings: {},
      }]);
    });
    await page.locator('[data-panel-open="settings"]').click();
    const editor = await openPromptTemplatesForm(page, "global");
    const title = editor.locator("[data-quick-message-title]");
    await title.evaluate((node) => {
      node.value = "Local draft";
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await rejectedUpdateObserved;
    assert.equal(await editor.getAttribute("aria-busy"), "true");
    assert.equal(await title.isDisabled(), true);
    assert.equal(await editor.locator("[data-quick-message-add]").isDisabled(), true);
    releaseRejectedUpdate();
    await page.waitForTimeout(500);
    const rejectedState = await page.evaluate(() => ({
      rejectApi: typeof window.AgentHub.rejectSelection,
      busy: document.querySelector("[data-prompt-templates-editor]")?.getAttribute("aria-busy"),
      error: document.querySelector("[data-prompt-templates-editor] [data-quick-message-error]")?.textContent,
      errorHidden: document.querySelector("[data-prompt-templates-editor] [data-quick-message-error]")?.hidden,
      toast: document.querySelector("[data-toast]")?.textContent,
    }));
    assert.deepEqual(rejectedState, {
      rejectApi: "function", busy: "false",
      error: "Не удалось сохранить. Черновик оставлен в редакторе.", errorHidden: false,
      toast: "Synthetic persistence rejection",
    });
    assert.equal(await title.inputValue(), "Local draft");
    assert.equal(await editor.locator("[data-quick-message-error]").isVisible(), true);
    assert.equal(await page.locator('[data-composer-quick-messages] [data-quick-message-index="0"]').textContent(), "GConfirmed");

    await title.evaluate((node) => {
      node.value = "Persisted retry";
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await successfulUpdateObserved;
    await editor.locator("[data-quick-message-error]").waitFor({ state: "hidden" });
    await page.reload({ waitUntil: "load" });
    await page.locator('[data-panel-open="settings"]').click();
    const reopened = await openPromptTemplatesForm(page, "global");
    assert.equal(await reopened.locator("[data-quick-message-title]").inputValue(), "Persisted retry");
  } finally {
    await browser.close();
  }
});

test("prompt template drafts stay isolated by owner across rejected and pending transport", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const surfaces = [
    ["web", { width: 1280, height: 800 }],
    ["webview", { width: 520, height: 720 }],
    ["mobile", { width: 390, height: 844 }],
  ];
  const workspaces = [
    { id: "workspace-a", name: "Workspace A", settings: {} },
    { id: "workspace-b", name: "Workspace B", settings: {} },
  ];
  const tasks = [
    {
      id: "stream-a", threadId: "thread-a", workspaceId: "workspace-a", workspaceName: "Workspace A",
      streamId: "stream-a", streamName: "Stream A", streamOrdinal: 1, provider: "codex",
      agentLabel: "Codex", status: "ready", statusLabel: "Готов", running: false, unread: false,
      streamSettings: {},
    },
    {
      id: "stream-b", threadId: "thread-b", workspaceId: "workspace-b", workspaceName: "Workspace B",
      streamId: "stream-b", streamName: "Stream B", streamOrdinal: 1, provider: "codex",
      agentLabel: "Codex", status: "ready", statusLabel: "Готов", running: false, unread: false,
      streamSettings: {},
    },
  ];
  const editTitle = (title, value) => title.evaluate((node, nextValue) => {
    node.value = nextValue;
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  try {
    for (const [surface, viewport] of surfaces) {
      for (const scope of ["workspace", "stream"]) {
        let serverQuickMessages = {
          global: [],
          workspaces: {
            "workspace-a": [{ title: "Workspace A confirmed", text: "Workspace A body" }],
            "workspace-b": [{ title: "Workspace B confirmed", text: "Workspace B body" }],
          },
          streams: {
            "stream-a": [{ title: "Stream A confirmed", text: "Stream A body" }],
            "stream-b": [{ title: "Stream B confirmed", text: "Stream B body" }],
          },
        };
        let updateCount = 0;
        let observeFirstUpdate;
        let releaseFirstUpdate;
        let observeSecondUpdate;
        let observeThirdUpdate;
        const firstUpdateObserved = new Promise((resolve) => { observeFirstUpdate = resolve; });
        const firstUpdateGate = new Promise((resolve) => { releaseFirstUpdate = resolve; });
        const secondUpdateObserved = new Promise((resolve) => { observeSecondUpdate = resolve; });
        const thirdUpdateObserved = new Promise((resolve) => { observeThirdUpdate = resolve; });
        const snapshot = () => ({
          apiVersion: 3,
          version: `prompt-owner-${scope}-${surface}-${updateCount}`,
          server: { status: "online" },
          tasks: tasks.map((task) => ({
            ...task,
            selected: task.streamId === (updateCount >= 3 ? "stream-a" : "stream-b"),
          })),
          workspaces,
          archivedWorkspaces: [], boardTasks: [], boardLayout: { columnOrder: [] },
          deferredInputs: [], messageReceipts: [], pendingApprovals: [],
          settings: {
            provider: "codex", models: [], modelOptionsByProvider: {}, reasoningOptions: [],
            reasoningOptionsByProvider: {}, modeOptions: [], quickMessages: serverQuickMessages,
          },
        });
        const page = await browser.newPage({ viewport });
        await openStreamTabsDomFixture(page, {
          includeHubClient: true,
          initialSettings: { quickMessages: serverQuickMessages },
          control: async (request) => {
            if (request.action !== "update-setting" || request.params?.name !== "quickMessages") {
              return { status: 200, body: { ok: true, result: snapshot() } };
            }
            updateCount += 1;
            if (updateCount === 1) {
              observeFirstUpdate();
              await firstUpdateGate;
              return { status: 400, body: { ok: false, error: "Synthetic owner rejection" } };
            }
            serverQuickMessages = JSON.parse(request.params.value);
            if (updateCount === 2) observeSecondUpdate();
            if (updateCount === 3) observeThirdUpdate();
            return { status: 200, body: { ok: true, result: snapshot() } };
          },
        });
        await page.evaluate(({ workspaceRows, taskRows }) => {
          window.AgentHub.setWorkspaces(workspaceRows);
          window.AgentHub.setTasks(taskRows.map((task, index) => ({ ...task, selected: index === 0 })));
        }, { workspaceRows: workspaces, taskRows: tasks });

        const editorSelector = "[data-prompt-templates-editor]";
        const editor = page.locator(editorSelector);
        const title = () => editor.locator("[data-quick-message-title]");
        const openWorkspace = async (workspaceId) => {
          await page.locator(`[data-workspace-select="${workspaceId}"]`).evaluate((node) => {
            node.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
            node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
          });
        };
        const openOwner = async (owner) => {
          await closePromptTemplatesForm(page, { synthetic: true });
          if (scope === "workspace") {
            await openWorkspace(`workspace-${owner}`);
          } else {
            await page.evaluate((taskId) => {
              window.AgentHub.selectTask(taskId);
              window.AgentHub.openDialogSettings();
            }, `stream-${owner}`);
          }
          await openPromptTemplatesForm(page, scope, { synthetic: true });
        };

        await openOwner("a");
        await editTitle(title(), `${scope} A rejected draft`);
        await firstUpdateObserved;
        assert.equal(await editor.getAttribute("aria-busy"), "true", `${scope}/${surface} A pending`);

        await openOwner("b");
        assert.equal(await title().inputValue(), `${scope === "workspace" ? "Workspace" : "Stream"} B confirmed`, `${scope}/${surface} B owner`);
        assert.equal(await title().isDisabled(), true, `${scope}/${surface} B pending lock`);
        assert.equal(await editor.locator("[data-quick-message-error]").isHidden(), true, `${scope}/${surface} B no A error`);

        releaseFirstUpdate();
        await page.waitForFunction((selector) => (
          document.querySelector(selector)?.getAttribute("aria-busy") === "false"
        ), editorSelector);
        assert.equal(await title().inputValue(), `${scope === "workspace" ? "Workspace" : "Stream"} B confirmed`, `${scope}/${surface} B after A reject`);
        await editTitle(title(), `${scope} B persisted`);
        await secondUpdateObserved;
        await page.waitForFunction((selector) => (
          document.querySelector(selector)?.getAttribute("aria-busy") === "false"
        ), editorSelector);

        await openOwner("a");
        assert.equal(await title().inputValue(), `${scope} A rejected draft`, `${scope}/${surface} restores A draft`);
        assert.deepEqual(await editor.locator("[data-quick-message-error]").evaluate((node) => ({
          hidden: node.hidden,
          text: node.textContent,
        })), {
          hidden: false,
          text: "Не удалось сохранить. Черновик оставлен в редакторе.",
        }, `${scope}/${surface} restores A error`);
        await editTitle(title(), `${scope} A retry`);
        await thirdUpdateObserved;
        await page.waitForFunction((selector) => (
          document.querySelector(selector)?.getAttribute("aria-busy") === "false"
        ), editorSelector);
        assert.equal(await editor.locator("[data-quick-message-error]").isHidden(), true, `${scope}/${surface} clears A only`);

        await openOwner("b");
        assert.equal(await title().inputValue(), `${scope} B persisted`, `${scope}/${surface} preserves B save`);
        assert.equal(await editor.locator("[data-quick-message-error]").isHidden(), true, `${scope}/${surface} B remains healthy`);
        const storedScope = scope === "workspace" ? serverQuickMessages.workspaces : serverQuickMessages.streams;
        assert.equal(storedScope[`${scope}-a`]?.[0]?.title, `${scope} A retry`, `${scope}/${surface} persisted A`);
        assert.equal(storedScope[`${scope}-b`]?.[0]?.title, `${scope} B persisted`, `${scope}/${surface} persisted B`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test("prompt template action mode uses the canonical selection transport", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const commands = [];
  let releaseUpdate;
  let observeUpdate;
  const updateGate = new Promise((resolve) => { releaseUpdate = resolve; });
  const updateObserved = new Promise((resolve) => { observeUpdate = resolve; });
  const snapshot = (mode) => ({
    apiVersion: 3,
    version: `prompt-mode-${mode}`,
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
      quickMessageActionMode: mode,
    },
  });
  try {
    const page = await browser.newPage();
    await openStreamTabsDomFixture(page, {
      includeHubClient: true,
      initialSettings: { quickMessageActionMode: "insert" },
      control: async (request) => {
        commands.push(structuredClone(request));
        if (request.action === "update-setting") {
          observeUpdate();
          await updateGate;
        }
        return { status: 200, body: { ok: true, result: snapshot(request.params?.value ?? "insert") } };
      },
    });
    await page.locator('[data-panel-open="settings"]').click();
    await page.locator("[data-quick-message-action-mode]").evaluate((node) => {
      node.value = "send";
      node.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await updateObserved;
    assert.equal(await page.locator("[data-quick-message-action-mode]").isDisabled(), true);
    assert.equal(await page.locator("[data-quick-message-action-mode]").getAttribute("aria-busy"), "true");
    releaseUpdate();
    await page.waitForFunction(() => document.querySelector("[data-quick-message-action-mode]")?.getAttribute("aria-busy") === "false");
    const update = commands.find((request) => request.action === "update-setting");
    assert.equal(update.params.name, "quickMessageActionMode");
    assert.equal(update.params.value, "send");
    assert.equal(await page.locator("[data-quick-message-action-mode]").inputValue(), "send");
    assert.equal(await page.locator("[data-quick-message-action-mode-note]").textContent(), "Ctrl + нажатие — вставить в поле.");
  } finally {
    await browser.close();
  }
});

test("prompt template action setting stays compact on Web, narrow WebView and Mobile Web", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const captureDirectory = String(process.env.AGENT_HUB_PROMPT_MODE_CAPTURE_DIR ?? "").trim();
  if (captureDirectory) await mkdir(captureDirectory, { recursive: true });
  try {
    for (const [surface, viewport, vscode] of [
      ["web", { width: 1280, height: 800 }, false],
      ["vscode-webview", { width: 520, height: 720 }, true],
      ["mobile-web", { width: 390, height: 844 }, false],
    ]) {
      const page = await browser.newPage({ viewport });
      if (vscode) await page.addInitScript(() => { window.__agentHubVscode = { postMessage() {} }; });
      await openStreamTabsDomFixture(page);
      await page.evaluate(() => window.AgentHub.setSelection({
        quickMessageActionMode: "send",
        quickMessages: {
          global: [{ title: "Продолжить работу", text: "Продолжай с текущего места" }],
          workspaces: {},
          streams: {},
        },
      }));
      await page.locator('[data-panel-open="settings"]').click();
      const layout = await page.locator(".prompt-template-action-row").evaluate((row) => {
        const panel = row.closest("[data-settings-panel]");
        const select = row.querySelector(".themed-select") ?? row.querySelector("select");
        const note = row.querySelector("[data-quick-message-action-mode-note]");
        const rowRect = row.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const selectRect = select.getBoundingClientRect();
        return {
          rowOverflow: row.scrollWidth - row.clientWidth,
          panelOverflow: panel.scrollWidth - panel.clientWidth,
          insidePanel: rowRect.left >= panelRect.left && rowRect.right <= panelRect.right,
          controlInside: selectRect.left >= rowRect.left && selectRect.right <= rowRect.right,
          noteVisible: note.getBoundingClientRect().height > 0,
        };
      });
      assert.ok(layout.rowOverflow <= 1, `${surface}: ${JSON.stringify(layout)}`);
      assert.ok(layout.panelOverflow <= 1, `${surface}: ${JSON.stringify(layout)}`);
      assert.equal(layout.insidePanel, true, surface);
      assert.equal(layout.controlInside, true, surface);
      assert.equal(layout.noteVisible, true, surface);
      if (captureDirectory) {
        await page.locator("[data-settings-panel]").screenshot({
          path: path.join(captureDirectory, `prompt-template-action-${surface}.png`),
        });
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("shared prompt template editor stays responsive across every scope and surface", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const captureDirectory = String(process.env.AGENT_HUB_PROMPT_EDITOR_CAPTURE_DIR ?? "").trim();
  if (captureDirectory) await mkdir(captureDirectory, { recursive: true });
  const entries = [
    {
      title: "Релиз",
      text: "Собери релиз-ноты по задачам спринта: что добавили, что починили и на что обратить внимание.",
    },
    {
      title: "Очень длинное название шаблона для проверки узкой панели",
      text: "Продолжай работу по текущему плану, сохраняя все принятые ограничения и проверяя результат.",
    },
    { title: "Дайджест", text: "" },
  ];
  try {
    for (const [surface, viewport, vscode, theme] of [
      ["web", { width: 1280, height: 820 }, false, "orange"],
      ["vscode-webview", { width: 520, height: 760 }, true, "orbit"],
      ["mobile-web", { width: 390, height: 844 }, false, "orange"],
    ]) {
      const page = await browser.newPage({ viewport });
      if (vscode) await page.addInitScript(() => { window.__agentHubVscode = { postMessage() {} }; });
      await openStreamTabsDomFixture(page);
      if (theme === "orange") {
        await page.addStyleTag({ path: fileURLToPath(new URL("../../assets/web-app/themes/orange/theme.css", import.meta.url)) });
        await page.evaluate(() => { document.documentElement.dataset.theme = "orange"; });
      }
      await page.evaluate((promptEntries) => {
        window.AgentHub.setWorkspaces([{ id: "workspace-1", name: "Agent HUB", settings: {} }]);
        window.AgentHub.setSelection({
          quickMessages: {
            global: promptEntries,
            workspaces: { "workspace-1": promptEntries },
            streams: { "stream-1": promptEntries },
          },
        });
        window.AgentHub.setTasks([{
          id: "task-1", selected: true, workspaceId: "workspace-1", workspaceName: "Agent HUB",
          streamId: "stream-1", streamName: "Architect", streamOrdinal: 1, provider: "codex",
          agentLabel: "Codex", status: "ready", statusLabel: "Готов", running: false,
          unread: false, streamSettings: {},
        }]);
      }, entries);

      const verifyEditor = async (scope, editor) => {
        const metrics = await editor.evaluate((node) => {
          const card = node.closest(".prompt-template-editor-card");
          const first = node.querySelector("[data-quick-message-row]");
          const compactButtons = [...node.querySelectorAll(".quick-message-editor-order button")];
          const fields = card.closest(".prompt-templates-fields");
          const cardBox = card.getBoundingClientRect();
          const fieldsBox = fields.getBoundingClientRect();
          return {
            cardOverflow: card.scrollWidth - card.clientWidth,
            cardHeight: cardBox.height,
            cardWidth: cardBox.width,
            fieldsOverflow: fields.scrollWidth - fields.clientWidth,
            cardInsideFields: cardBox.left >= fieldsBox.left - 1 && cardBox.right <= fieldsBox.right + 1,
            rowOverflow: first.scrollWidth - first.clientWidth,
            openCount: node.querySelectorAll(".quick-message-editor-details:not([hidden])").length,
            touchTargets: compactButtons.map((button) => button.getBoundingClientRect().height),
            firstUpDisabled: node.querySelector('.quick-message-editor-order [data-quick-message-action="up"]').disabled,
            lastDownDisabled: [...node.querySelectorAll("[data-quick-message-row]")].at(-1)
              .querySelector('.quick-message-editor-order [data-quick-message-action="down"]').disabled,
          };
        });
        assert.ok(metrics.cardOverflow <= 1, `${surface}/${scope}: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.cardHeight > 100, `${surface}/${scope}: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.cardWidth <= 621, `${surface}/${scope}: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.fieldsOverflow <= 1, `${surface}/${scope}: ${JSON.stringify(metrics)}`);
        assert.equal(metrics.cardInsideFields, true, `${surface}/${scope}: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.rowOverflow <= 1, `${surface}/${scope}: ${JSON.stringify(metrics)}`);
        assert.equal(metrics.openCount, 1, `${surface}/${scope}`);
        assert.equal(metrics.firstUpDisabled, true, `${surface}/${scope}`);
        assert.equal(metrics.lastDownDisabled, true, `${surface}/${scope}`);
        if (surface === "mobile-web") {
          assert.equal(metrics.touchTargets.every((height) => height >= 44), true, `${surface}/${scope}`);
        }
        if (captureDirectory) {
          await editor.evaluate((node) => {
            const card = node.closest(".prompt-template-editor-card");
            const scrollContainer = card?.closest(".prompt-templates-fields");
            if (scrollContainer) {
              scrollContainer.scrollTop = Math.max(0, card.offsetTop - scrollContainer.offsetTop);
              return;
            }
            card?.scrollIntoView({ block: "center", inline: "nearest" });
          });
          const screenshotTarget = page.locator("[data-prompt-templates-modal]");
          await screenshotTarget.screenshot({
            path: path.join(captureDirectory, `prompt-template-editor-${scope}-${surface}.png`),
          });
        }
      };

      await page.locator('[data-panel-open="settings"]').click();
      await verifyEditor("global", await openPromptTemplatesForm(page, "global"));
      await closePromptTemplatesForm(page);
      await page.locator("[data-panel-close]").click();

      await page.locator('[data-workspace-select="workspace-1"]').dispatchEvent("click", { detail: 1 });
      await page.locator('[data-workspace-select="workspace-1"]').dispatchEvent("dblclick", { detail: 2 });
      await page.waitForFunction(() => document.querySelector("[data-workspace-card-modal]")?.open === true);
      await verifyEditor("workspace", await openPromptTemplatesForm(page, "workspace"));
      await closePromptTemplatesForm(page);
      await page.locator("[data-workspace-card-close]").click();

      const streamTab = page.locator('.stream-tabs-track [data-stream-tab-id="stream-1"]');
      await streamTab.dispatchEvent("click", { detail: 1 });
      await streamTab.dispatchEvent("dblclick", { detail: 2 });
      await page.waitForFunction(() => document.querySelector("[data-dialog-settings]")?.open === true);
      await verifyEditor("stream", await openPromptTemplatesForm(page, "stream"));
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("Dashboard column headers keep equal height across different task densities", { timeout: 20_000 }, async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const screenshotDirectory = String(process.env.HUB157_QA_SCREENSHOT_DIR ?? "").trim();
  try {
    for (const [surface, viewport] of [
      ["wide-short", { width: 1900, height: 376 }],
      ["desktop", { width: 1440, height: 900 }],
      ["mobile", { width: 390, height: 844 }],
    ]) {
      const problems = [];
      const page = await browser.newPage({ viewport });
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) {
          const location = message.location().url;
          if (!["https://agent-hub.test/health", "https://agent-hub.test/events"].includes(location)) {
            problems.push(`${message.type()}: ${message.text()} (${location})`);
          }
        }
      });
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      await openStreamTabsDomFixture(page);
      await page.evaluate(() => {
        const workspaces = [
          { id: "empty", name: "Пустой Workspace", comment: "", streams: [] },
          { id: "dense", name: "Плотный Workspace", comment: "", streams: new Array(17).fill({}) },
          { id: "commented", name: "Workspace с комментарием", comment: "Описание колонки", streams: [{ id: "s" }] },
        ];
        const tasks = Array.from({ length: 28 }, (_, index) => ({
          id: `task-${index}`,
          taskNumber: `HUB-${index + 1}`,
          title: `Плотная задача ${index + 1}`,
          text: `Плотная задача ${index + 1}`,
          rawText: `Плотная задача ${index + 1}`,
          bucket: index < 26 ? "workspace" : "notes",
          workspaceId: index < 26 ? "dense" : null,
          status: "started",
          workflowStatus: "in_progress",
          revision: 1,
          attachments: [],
        }));
        window.AgentHubTaskBoard.setSnapshot({
          tasks,
          workspaces,
          columnOrder: ["workspace:empty", "workspace:dense", "workspace:commented", "notes"],
        });
        document.querySelector('[data-view-button="dashboard"]').click();
      });
      const geometry = await page.locator(".task-board-column-head").evaluateAll((headers) => headers.map((header) => {
        const rect = header.getBoundingClientRect();
        const column = header.closest("[data-board-destination]");
        const columnRect = column.getBoundingClientRect();
        const style = getComputedStyle(column);
        const borderTop = parseFloat(style.borderTopWidth) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const contentTop = columnRect.top + borderTop + paddingTop;
        return {
          column: column.dataset.boardDestination,
          height: rect.height,
          borderTop,
          paddingTop,
          topFromContent: rect.top - contentTop,
          bottomFromContent: rect.bottom - contentTop,
        };
      }));
      const densities = await page.locator(".task-board-column-list").evaluateAll((lists) => (
        lists.map((list) => list.querySelectorAll("[data-board-task-id]").length)
      ));
      const evidence = JSON.stringify({ surface, geometry, densities });
      assert.ok(geometry.length >= 5, evidence);
      assert.ok(densities.includes(0) && Math.max(...densities) >= 26, evidence);
      assert.ok(geometry.every(({ height }) => height > 0), evidence);
      const spread = (field) => Math.max(...geometry.map((value) => value[field]))
        - Math.min(...geometry.map((value) => value[field]));
      assert.ok(spread("height") <= 0.5, evidence);
      // Backlog has its own border. Compare header alignment inside each
      // parent's content box, not absolute page coordinates or CSS literals.
      assert.ok(geometry.every(({ topFromContent }) => Math.abs(topFromContent) <= 0.5), evidence);
      assert.ok(spread("bottomFromContent") <= 0.5, evidence);
      if (screenshotDirectory) {
        console.log(`HUB157_BOARD_HEADER_GEOMETRY ${surface} ${JSON.stringify(geometry)}`);
        await page.screenshot({
          path: path.join(screenshotDirectory, `hub157-board-headers-${surface}.png`),
          fullPage: false,
        });
      }
      assert.deepEqual(problems, []);
      await page.close();
    }
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
      .map(({ action, params }) => {
        const { clientTraceId, clientTiming, ...businessParams } = params;
        assert.equal(typeof clientTraceId, "string");
        assert.ok(clientTraceId.length > 0);
        assert.equal(clientTiming.surface, "browser");
        assert.equal(clientTiming.transport, "direct-http");
        assert.ok(Number.isFinite(clientTiming.submittedAtMs));
        assert.ok(Number.isFinite(clientTiming.submittedMonotonicMs));
        assert.ok(clientTiming.controlStartedMonotonicMs >= clientTiming.submittedMonotonicMs);
        assert.ok(clientTiming.transportStartedMonotonicMs >= clientTiming.controlStartedMonotonicMs);
        return { action, params: businessParams };
      }), [{
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

test("mobile Workspace click preserves its dblclick target while desktop click still opens chat", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const installFixture = async (page) => page.evaluate(() => {
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
      id: "task-one",
      selected: false,
      workspaceId: "workspace-1",
      workspaceName: "One",
      streamId: "stream-one",
      streamName: "One stream",
      streamOrdinal: 1,
      provider: "codex",
      agentLabel: "Codex",
    }, {
      ...shared,
      id: "task-two",
      selected: true,
      workspaceId: "workspace-2",
      workspaceName: "Two",
      streamId: "stream-two",
      streamName: "Two stream",
      streamOrdinal: 1,
      provider: "claude",
      agentLabel: "Claude",
    }]);
  });
  try {
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await openStreamTabsDomFixture(mobile);
    await installFixture(mobile);
    const mobileWorkspace = mobile.locator('[data-workspace-select="workspace-1"]');
    await mobileWorkspace.click();
    assert.deepEqual(await mobile.evaluate(() => ({
      surface: document.documentElement.dataset.surface,
      pane: document.documentElement.dataset.pane,
      selected: document.querySelector('[data-workspace-select="workspace-1"]')?.getAttribute("aria-pressed"),
      cardOpen: document.querySelector("[data-workspace-card-modal]")?.open,
    })), {
      surface: "mobile",
      pane: "tasks",
      selected: "true",
      cardOpen: false,
    });
    await mobileWorkspace.focus();
    await mobileWorkspace.dblclick();
    assert.equal(await mobile.locator("[data-workspace-card-modal]").evaluate((node) => node.open), true);
    await mobile.keyboard.press("Escape");
    assert.equal(await mobileWorkspace.evaluate((node) => document.activeElement === node), true);
    await mobile.close();

    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await openStreamTabsDomFixture(desktop);
    await installFixture(desktop);
    const desktopWorkspace = desktop.locator('[data-workspace-select="workspace-1"]');
    await desktopWorkspace.click();
    assert.deepEqual(await desktop.evaluate(() => ({
      surface: document.documentElement.dataset.surface,
      pane: document.documentElement.dataset.pane,
      selected: document.querySelector('[data-workspace-select="workspace-1"]')?.getAttribute("aria-pressed"),
      cardOpen: document.querySelector("[data-workspace-card-modal]")?.open,
    })), {
      surface: "desktop",
      pane: "chat",
      selected: "true",
      cardOpen: false,
    });
    await desktopWorkspace.focus();
    await desktopWorkspace.dblclick();
    assert.equal(await desktop.locator("[data-workspace-card-modal]").evaluate((node) => node.open), true);
    await desktop.close();
  } finally {
    await browser.close();
  }
});

test("current and other Workspace or Stream native dblclicks survive exact-identity rerenders in Edge", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const screenshotDirectory = String(process.env.HUB157_QA_SCREENSHOT_DIR ?? "").trim();
  const scenarios = [
    {
      name: "selected-workspace",
      kind: "workspace",
      id: "workspace-1",
      expectedName: "One",
      selected: true,
      forceFirstClickRerender: true,
    },
    {
      name: "unselected-workspace",
      kind: "workspace",
      id: "workspace-2",
      expectedName: "Two",
      selected: false,
      forceFirstClickRerender: false,
    },
    {
      name: "selected-stream",
      kind: "stream",
      id: "stream-one",
      expectedName: "One stream",
      selected: true,
      forceFirstClickRerender: false,
    },
    {
      name: "unselected-stream",
      kind: "stream",
      id: "stream-other",
      expectedName: "Other stream",
      selected: false,
      forceFirstClickRerender: false,
    },
  ];
  const targetFor = (page, scenario, region) => {
    const row = scenario.kind === "workspace"
      ? page.locator(`[data-workspace-select="${scenario.id}"]`)
      : page.locator(`.stream-tabs-track [data-stream-tab-id="${scenario.id}"]`);
    if (region === "text") {
      return scenario.kind === "workspace"
        ? row.locator(".task-workspace-name")
        : row.locator(".stream-tab-title");
    }
    if (region === "status") {
      return scenario.kind === "workspace"
        ? row
        : row.locator(".provider-dot");
    }
    return row;
  };
  try {
    for (const [surface, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 480, height: 844 }],
    ]) {
      const problems = [];
      const page = await browser.newPage({ viewport });
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) {
          const location = message.location().url;
          if (!["https://agent-hub.test/health", "https://agent-hub.test/events"].includes(location)) {
            problems.push(`${message.type()}: ${message.text()} (${location})`);
          }
        }
      });
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
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
          id: "task-one",
          selected: true,
          workspaceId: "workspace-1",
          workspaceName: "One",
          streamId: "stream-one",
          streamName: "One stream",
          streamOrdinal: 1,
          provider: "codex",
          agentLabel: "Codex",
        }, {
          ...shared,
          id: "task-one-other",
          selected: false,
          workspaceId: "workspace-1",
          workspaceName: "One",
          streamId: "stream-other",
          streamName: "Other stream",
          streamOrdinal: 2,
          provider: "claude",
          agentLabel: "Claude",
        }, {
          ...shared,
          id: "task-two",
          selected: false,
          workspaceId: "workspace-2",
          workspaceName: "Two",
          streamId: "stream-two",
          streamName: "Two stream",
          streamOrdinal: 1,
          provider: "codex",
          agentLabel: "Codex",
        }]);

        const nodeIds = new WeakMap();
        let nextNodeId = 1;
        const nodeId = (node) => {
          if (!nodeIds.has(node)) nodeIds.set(node, nextNodeId++);
          return nodeIds.get(node);
        };
        window.__hub157NativeTrace = [];
        window.__hub157DialogOpenCounts = { workspace: 0, stream: 0 };
        window.__hub157ForceSelectedWorkspaceRerender = false;
        window.__hub157PatchOrdinal = 0;
        for (const type of ["pointerdown", "pointerup", "click", "dblclick"]) {
          document.addEventListener(type, (event) => {
            const row = event.target.closest?.(
              "[data-workspace-select], [data-stream-tab-id][data-workspace-id]",
            );
            if (!row) return;
            const logicalId = row.dataset.workspaceSelect
              ? `workspace:${row.dataset.workspaceSelect}`
              : `stream:${row.dataset.workspaceId}:${row.dataset.streamTabId}:${row.dataset.streamTaskId}`;
            window.__hub157NativeTrace.push({
              type,
              detail: event.detail,
              logicalId,
              rowNodeId: nodeId(row),
              targetClass: String(event.target.className ?? ""),
            });
          }, true);
        }
        window.addEventListener("click", (event) => {
          const workspace = event.target.closest?.('[data-workspace-select="workspace-1"]');
          if (!window.__hub157ForceSelectedWorkspaceRerender || event.detail !== 1 || !workspace) return;
          window.__hub157PatchOrdinal += 1;
          window.AgentHub.patchTask("task-one", {
            lastActivity: `2026-09-04T08:00:${String(window.__hub157PatchOrdinal).padStart(2, "0")}.000Z`,
          });
        });
        const nativeShowModal = HTMLDialogElement.prototype.showModal;
        HTMLDialogElement.prototype.showModal = function showModal(...args) {
          if (this.matches("[data-workspace-card-modal]")) {
            window.__hub157DialogOpenCounts.workspace += 1;
          } else if (this.matches("[data-dialog-settings]")) {
            window.__hub157DialogOpenCounts.stream += 1;
          }
          return nativeShowModal.apply(this, args);
        };
      });

      for (const scenario of scenarios) {
        if (surface === "mobile") {
          await page.locator(`[data-mobile-button="${scenario.kind === "workspace" ? "tasks" : "chat"}"]`).click();
        }
        await page.evaluate(() => window.AgentHub.selectTask("task-one"));
        const singleTarget = targetFor(page, scenario, "text");
        const beforeSingle = await page.evaluate((kind) => window.__hub157DialogOpenCounts[kind], scenario.kind);
        await singleTarget.click();
        assert.equal(
          await page.locator(scenario.kind === "workspace"
            ? "[data-workspace-card-modal]"
            : "[data-dialog-settings]").evaluate((node) => node.open),
          false,
          `${surface}/${scenario.name}: a single click must not open the card`,
        );
        assert.equal(
          await page.evaluate((kind) => window.__hub157DialogOpenCounts[kind], scenario.kind),
          beforeSingle,
          `${surface}/${scenario.name}: a single click must not call showModal`,
        );

        for (let attempt = 0; attempt < 20; attempt += 1) {
          await page.evaluate(() => window.AgentHub.selectTask("task-one"));
          await page.evaluate(({ forceFirstClickRerender }) => {
            window.__hub157ForceSelectedWorkspaceRerender = forceFirstClickRerender;
            window.__hub157NativeTrace = [];
          }, scenario);
          const region = ["text", "status", "padding"][attempt % 3];
          const target = targetFor(page, scenario, region);
          const beforeOpen = await page.evaluate((kind) => window.__hub157DialogOpenCounts[kind], scenario.kind);
          if (region === "padding" || (region === "status" && scenario.kind === "workspace")) {
            const box = await target.boundingBox();
            assert.ok(box, `${surface}/${scenario.name}: target row is visible`);
            await page.mouse.dblclick(
              region === "status" ? box.x + box.width - 8 : box.x + (box.width / 2),
              region === "status" ? box.y + (box.height / 2) : box.y + box.height - 3,
              { delay: 35 },
            );
          } else {
            await target.dblclick({ delay: 35 });
          }
          const dialog = page.locator(scenario.kind === "workspace"
            ? "[data-workspace-card-modal]"
            : "[data-dialog-settings]");
          const trace = await page.evaluate(() => window.__hub157NativeTrace);
          assert.equal(await dialog.evaluate((node) => node.open), true, JSON.stringify({
            surface, scenario: scenario.name, attempt, region, trace,
          }));
          assert.equal(
            await page.evaluate((kind) => window.__hub157DialogOpenCounts[kind], scenario.kind),
            beforeOpen + 1,
            `${surface}/${scenario.name}/${attempt}: native dblclick opens exactly once`,
          );
          const actualName = await page.locator(scenario.kind === "workspace"
            ? "[data-workspace-card-name]"
            : "[data-dialog-stream-name]").inputValue();
          assert.equal(actualName, scenario.expectedName, `${surface}/${scenario.name}: exact card identity`);
          assert.deepEqual(trace.map(({ type, detail }) => [type, detail]), [
            ["pointerdown", 0],
            ["pointerup", 0],
            ["click", 1],
            ["pointerdown", 0],
            ["pointerup", 0],
            ["click", 2],
            ["dblclick", 2],
          ], `${surface}/${scenario.name}/${region}: native event sequence`);
          assert.equal(new Set(trace.map(({ logicalId }) => logicalId)).size, 1);
          if (scenario.forceFirstClickRerender) {
            assert.equal(new Set(trace.map(({ rowNodeId }) => rowNodeId)).size, 1,
              `${surface}/${scenario.name}: the same logical Workspace keeps its node through a rerender`);
          }
          if (screenshotDirectory && scenario.name === "selected-workspace" && attempt === 0) {
            console.log(`HUB157_DBLCLICK_TRACE ${surface} ${JSON.stringify(trace)}`);
            await page.screenshot({
              path: path.join(screenshotDirectory, `hub157-selected-workspace-dblclick-${surface}.png`),
              fullPage: false,
            });
          }
          await page.keyboard.press("Escape");
          assert.equal(await dialog.evaluate((node) => node.open), false);
        }
        await page.evaluate(() => { window.__hub157ForceSelectedWorkspaceRerender = false; });
      }
      assert.deepEqual(problems, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("Stream card opens on 20 repeated native dblclicks per viewport without console failures", stressMatrix(), async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  const screenshotDirectory = String(process.env.HUB157_QA_SCREENSHOT_DIR ?? "").trim();
  const installFixture = async (page) => page.evaluate(() => {
    const shared = {
      workspaceId: "workspace-1",
      workspaceName: "One",
      workspaceSettings: {},
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
      id: "task-one",
      selected: true,
      streamId: "stream-one",
      streamName: "One stream",
      streamOrdinal: 1,
      provider: "codex",
      agentLabel: "Codex",
    }, {
      ...shared,
      id: "task-two",
      selected: false,
      streamId: "stream-two",
      streamName: "Two stream",
      streamOrdinal: 2,
      provider: "claude",
      agentLabel: "Claude",
    }]);
  });
  const measureCardGaps = (page) => page.evaluate(() => {
    const saveNode = document.querySelector("[data-dialog-stream-rules-save]");
    const save = saveNode.getBoundingClientRect();
    const saveStyle = getComputedStyle(saveNode);
    const rules = document.querySelector(".stream-agent-rules").getBoundingClientRect();
    const rulesCardNode = document.querySelector(".agent-rules-card");
    const rulesCard = rulesCardNode.getBoundingClientRect();
    const rulesCardStyle = getComputedStyle(rulesCardNode);
    const section = document.querySelector(".stream-card-actions-section").getBoundingClientRect();
    const title = document.querySelector(".stream-card-actions-section .settings-section-title").getBoundingClientRect();
    const card = document.querySelector(".stream-card-actions").getBoundingClientRect();
    const pin = document.querySelector("[data-stream-card-pin]").getBoundingClientRect();
    const archive = document.querySelector("[data-stream-card-archive]").getBoundingClientRect();
    return {
      insideRulesCard: Number((
        rulesCard.bottom - Number.parseFloat(rulesCardStyle.borderBottomWidth) - save.bottom
      ).toFixed(2)),
      afterRulesSave: Number((rules.bottom - save.bottom).toFixed(2)),
      beforeActions: Number((title.top - section.top).toFixed(2)),
      beforePin: Number((pin.top - card.top).toFixed(2)),
      afterArchive: Number((card.bottom - archive.bottom).toFixed(2)),
      boxModel: {
        cardPaddingBottom: rulesCardStyle.paddingBottom,
        cardBorderBottom: rulesCardStyle.borderBottomWidth,
        cardGap: rulesCardStyle.gap,
        saveMarginBottom: saveStyle.marginBottom,
        savePaddingBottom: saveStyle.paddingBottom,
        saveBorderBottom: saveStyle.borderBottomWidth,
      },
    };
  });
  try {
    for (const [surface, viewport] of [
      ["desktop", { width: 1440, height: 1000 }],
      ["mobile", { width: 390, height: 844 }],
      ["mobile-short", { width: 390, height: 520 }],
    ]) {
      const problems = [];
      const page = await browser.newPage({ viewport });
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) {
          const location = message.location().url;
          if (!["https://agent-hub.test/health", "https://agent-hub.test/events"].includes(location)) {
            problems.push(`${message.type()}: ${message.text()} (${location})`);
          }
        }
      });
      page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
      await openStreamTabsDomFixture(page);
      await installFixture(page);
      if (surface.startsWith("mobile")) await page.locator('[data-mobile-button="chat"]').click();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const tab = page.locator('.stream-tabs-track .stream-tab[data-stream-tab-id="stream-one"]');
        await tab.dblclick();
        assert.equal(await page.locator("[data-dialog-settings]").evaluate((node) => node.open), true);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("[data-dialog-settings]").evaluate((node) => node.open), false);
        assert.equal(await tab.evaluate((node) => document.activeElement === node), true);
      }
      const tab = page.locator('.stream-tabs-track .stream-tab[data-stream-tab-id="stream-one"]');
      await tab.dblclick();
      const baselineStyle = await page.addStyleTag({ content: `
        .stream-agent-rules { padding-bottom: 0 !important; }
        .stream-card-actions-section { padding-top: 0 !important; }
        .settings-card.stream-card-actions { padding-block: 0 !important; }
        .settings-card.agent-rules-card { padding-bottom: 0 !important; }
      ` });
      const baselineGaps = await measureCardGaps(page);
      await baselineStyle.evaluate((node) => node.remove());
      const correctedGaps = await measureCardGaps(page);
      if (screenshotDirectory) {
        console.log(`HUB157_QA_GEOMETRY ${surface} ${JSON.stringify({ baselineGaps, correctedGaps })}`);
      }
      for (const gap of [
        correctedGaps.insideRulesCard,
        correctedGaps.afterRulesSave,
        correctedGaps.beforeActions,
        correctedGaps.beforePin,
        correctedGaps.afterArchive,
      ]) assert.ok(gap >= 6, JSON.stringify(correctedGaps));
      const bottomVisibility = await page.evaluate(() => {
        const body = document.querySelector(".dialog-settings-body");
        const card = document.querySelector(".agent-rules-card");
        const save = document.querySelector("[data-dialog-stream-rules-save]");
        card.scrollIntoView({ block: "end" });
        const bodyRect = body.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const saveRect = save.getBoundingClientRect();
        return {
          cardBottom: Number(cardRect.bottom.toFixed(2)),
          bodyBottom: Number(bodyRect.bottom.toFixed(2)),
          saveBottom: Number(saveRect.bottom.toFixed(2)),
          clipped: cardRect.bottom > bodyRect.bottom + 1 || saveRect.bottom >= cardRect.bottom,
        };
      });
      assert.equal(bottomVisibility.clipped, false, JSON.stringify(bottomVisibility));
      if (screenshotDirectory) {
        await page.screenshot({
          path: path.join(screenshotDirectory, `hub157-rules-gap-${surface}.png`),
          fullPage: false,
        });
        await page.locator(".dialog-settings-body").evaluate((node) => { node.scrollTop = node.scrollHeight; });
        await page.locator("[data-stream-card-move]").click();
        await page.screenshot({
          path: path.join(screenshotDirectory, `hub157-stream-card-${surface}.png`),
          fullPage: false,
        });
        await page.keyboard.press("Escape");
        await page.keyboard.press("Escape");
        if (surface.startsWith("mobile")) await page.locator('[data-mobile-button="tasks"]').click();
        const workspace = page.locator('[data-workspace-select="workspace-1"]');
        await workspace.dblclick();
        await page.locator(".workspace-card-fields").evaluate((node) => { node.scrollTop = node.scrollHeight; });
        await page.screenshot({
          path: path.join(screenshotDirectory, `hub157-workspace-card-${surface}.png`),
          fullPage: false,
        });
        await page.keyboard.press("Escape");
      }
      assert.deepEqual(problems, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test("Stream card close button does not reopen or hide a legitimately reopened modal", async () => {
  const { chromium } = await import("playwright");
  const browser = await launchDomBrowser(chromium);
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await openStreamTabsDomFixture(page);
    await page.evaluate(() => {
      window.AgentHub.setWorkspaces([{
        id: "workspace-1", name: "One", settings: {},
      }], ["workspace:workspace-1", "notes"]);
      window.AgentHub.setTasks([{
        id: "task-one",
        selected: true,
        workspaceId: "workspace-1",
        workspaceName: "One",
        workspaceSettings: {},
        streamId: "stream-one",
        streamName: "One stream",
        streamOrdinal: 1,
        provider: "codex",
        agentLabel: "Codex",
        status: "ready",
        statusLabel: "Готов",
        lastActivity: "2026-09-04T08:00:00.000Z",
        running: false,
        unread: false,
        streamSettings: {},
      }]);
    });

    const tab = page.locator('.stream-tabs-track .stream-tab[data-stream-tab-id="stream-one"]');
    const dialog = page.locator("[data-dialog-settings]");
    const closeButton = page.locator("[data-dialog-settings-close]");

    await tab.dblclick();
    await closeButton.click();
    assert.deepEqual(await dialog.evaluate((node) => ({
      open: node.open,
      modal: node.matches(":modal"),
      hidden: node.hidden,
    })), { open: false, modal: false, hidden: true });

    await tab.dblclick();
    assert.deepEqual(await dialog.evaluate((node) => ({
      open: node.open,
      modal: node.matches(":modal"),
      hidden: node.hidden,
      visible: getComputedStyle(node).display !== "none",
    })), { open: true, modal: true, hidden: false, visible: true });

    const reopenedAfterQueuedClose = await page.evaluate(() => new Promise((resolve) => {
      const modal = document.querySelector("[data-dialog-settings]");
      modal.addEventListener("close", () => resolve({
        open: modal.open,
        modal: modal.matches(":modal"),
        hidden: modal.hidden,
        visible: getComputedStyle(modal).display !== "none",
      }), { once: true });
      document.querySelector("[data-dialog-settings-close]").click();
      document.querySelector("[data-dialog-settings-toggle]").click();
    }));
    assert.deepEqual(reopenedAfterQueuedClose,
      { open: true, modal: true, hidden: false, visible: true });

    await closeButton.click();
    assert.deepEqual(await dialog.evaluate((node) => ({
      open: node.open,
      modal: node.matches(":modal"),
      hidden: node.hidden,
    })), { open: false, modal: false, hidden: true });
    await page.locator('[data-view-button="dashboard"]').click();
    assert.equal(await page.locator("html").getAttribute("data-view"), "dashboard");
  } finally {
    await browser.close();
  }
});

test("Workspace and Stream cards survive logical-identity rerenders while stale dblclick identity fails closed in Edge", async () => {
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
      window.__hub157IdentityTasks = [{
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
      }];
      window.AgentHub.setTasks(window.__hub157IdentityTasks);
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
    assert.deepEqual(replacedWorkspaceResult, { open: true, selected: "true" });
    await page.keyboard.press("Escape");

    const rerenderedStreamResult = await page.evaluate(() => {
      const known = document.querySelector('[data-stream-tab-id="stream-known"]');
      known.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      window.AgentHub.selectTask("task-other");
      window.AgentHub.selectTask("task-known");
      const replacement = document.querySelector('[data-stream-tab-id="stream-known"]');
      replacement.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      replacement.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      return {
        open: document.querySelector("[data-dialog-settings]").open,
        replaced: replacement !== known,
      };
    });
    // Обновление сохраняет узел вкладки, поэтому состояние статуса не сбрасывается.
    assert.deepEqual(rerenderedStreamResult, { open: true, replaced: false });
    await page.keyboard.press("Escape");

    const staleStreamResult = await page.evaluate(() => {
      const known = document.querySelector('[data-stream-tab-id="stream-known"]');
      const other = document.querySelector('[data-stream-tab-id="stream-other"]');
      known.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      other.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      other.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      return document.querySelector("[data-dialog-settings]").open;
    });
    assert.equal(staleStreamResult, false);

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

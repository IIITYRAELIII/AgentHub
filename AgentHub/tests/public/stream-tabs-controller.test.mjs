import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
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

async function openStreamTabsDomFixture(page) {
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "agent-hub.test") {
      await route.abort();
      return;
    }
    if (requestUrl.pathname === "/") {
      const source = await readFile(new URL("index.html", WEB_APP_ROOT), "utf8");
      const body = source
        .replace(/\s*<script src="https:\/\/telegram\.org\/[^>]+><\/script>/u, "")
        .replace(/\s*<script src="\/browser-device-auth\.js" defer><\/script>/u, "")
        .replace(/\s*<script src="\/hub-client\.js" defer><\/script>/u, "")
        .replace("</head>", `<script type="application/json" data-theme-catalog>${TEST_THEME_CATALOG}</script></head>`);
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
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
  await page.goto("http://agent-hub.test/", { waitUntil: "load" });
  await page.waitForFunction(() => typeof window.AgentHub === "object");
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

test("quick messages merge Workspace and Stream scopes without duplicates", async () => {
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
    JSON.parse(JSON.stringify(quickMessagesForStream(selection, "workspace-1", "stream-1").map(({ scope, label, text }) => ({
      scope, label, text,
    })))),
    [
      { scope: "global", label: "пинг", text: "пинг" },
      { scope: "workspace", label: "релизь", text: "релизь" },
      { scope: "workspace", label: "Тесты", text: "запусти тесты" },
      { scope: "stream", label: "продолжай", text: "продолжай" },
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
      global: [{ id: "пинг", label: "пинг", text: "пинг" }],
      streams: {},
      workspaces: {
        "workspace-1": [
          { id: "релизь", label: "релизь", text: "релизь" },
          { id: "Тесты", label: "Тесты", text: "запусти тесты" },
        ],
      },
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(setQuickMessagesForScope(selection, "global", "", ["везде"]))),
    {
      global: [{ id: "везде", label: "везде", text: "везде" }],
      streams: {
        "stream-1": [
          { id: "Release", label: "Release", text: "релизь" },
          { id: "продолжай", label: "продолжай", text: "продолжай" },
          { id: "пинг", label: "пинг", text: "пинг" },
        ],
      },
      workspaces: {
        "workspace-1": [
          { id: "релизь", label: "релизь", text: "релизь" },
          { id: "Тесты", label: "Тесты", text: "запусти тесты" },
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

test("Workspace sections separate active work and group stable project families", async () => {
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
  assert.deepEqual(
    JSON.parse(JSON.stringify(sections.catalog.map((entry) => entry.type === "family"
      ? {
          type: entry.type,
          name: entry.name,
          items: entry.items.map((item) => ({ id: item.id, shortName: item.shortName })),
        }
      : { type: entry.type, id: entry.group.id }))),
    [
      { type: "workspace", id: "solo" },
      {
        type: "family",
        name: "FB",
        items: [
          { id: "fb-alpha", shortName: "Альфа" },
          { id: "fb-beta", shortName: "Бета" },
          { id: "fb-gamma", shortName: "Гамма" },
        ],
      },
    ],
  );
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

test("Workspace folder mutations preserve settings and creation can stay ungrouped", async () => {
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
    settings: {
      workingDirectory: "project",
      taskPrefix: "HUB",
      releaseWorkflowEnabled: true,
      catalogFolder: "Важные проекты",
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(workspaceFolderMutation({
    ...workspace,
    settings: { ...workspace.settings, catalogFolder: "Старая" },
  }, ""))), {
    workspaceId: "workspace-1",
    folderName: "",
    settings: workspace.settings,
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

test("Workspace archive presentation keeps expiry and exact-name confirmation", async () => {
  const { workspaceArchiveNameMatches, workspaceArchivePresentation } = await streamTabsApi();
  assert.deepEqual(JSON.parse(JSON.stringify(workspaceArchivePresentation([{
    id: "archived",
    name: "Удалённый",
    streamCount: 2,
    threadCount: 5,
    purgeAfterMs: 1_700_000_000_000 + (26 * 60 * 60 * 1000),
  }], 1_700_000_000_000))), [{
    id: "archived",
    name: "Удалённый",
    streamCount: 2,
    threadCount: 5,
    purgeAfterMs: 1_700_093_600_000,
    remainingLabel: "Осталось 2 дн.",
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

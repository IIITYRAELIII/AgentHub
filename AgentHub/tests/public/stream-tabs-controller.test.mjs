import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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

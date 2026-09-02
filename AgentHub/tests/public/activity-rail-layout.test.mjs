import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function layoutApi() {
  const source = await readFile(
    new URL("../../assets/web-app/activity-rail-layout.js", import.meta.url),
    "utf8",
  );
  const window = { document: { documentElement: null, querySelector: () => null } };
  vm.runInNewContext(source, { window });
  return window.AgentHubActivityRailLayout;
}

test("separate activity rail removes either collapsed column", async () => {
  const { activityRailColumnState } = await layoutApi();
  assert.deepEqual(
    { ...activityRailColumnState({ separate: true }) },
    { separate: true, tasksVisible: true, streamsVisible: true, visibleColumns: 2 },
  );
  assert.deepEqual(
    { ...activityRailColumnState({ separate: true, tasksCollapsed: true }) },
    { separate: true, tasksVisible: false, streamsVisible: true, visibleColumns: 1 },
  );
  assert.deepEqual(
    { ...activityRailColumnState({ separate: true, streamsCollapsed: true }) },
    { separate: true, tasksVisible: true, streamsVisible: false, visibleColumns: 1 },
  );
  assert.equal(activityRailColumnState({
    separate: true,
    tasksCollapsed: true,
    streamsCollapsed: true,
  }).visibleColumns, 0);
});

test("activity rail layout preferences survive reload and unavailable storage", async () => {
  const { persistBoolean, storedBoolean } = await layoutApi();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(storedBoolean(storage, "layout"), false);
  assert.equal(storedBoolean(storage, "new-layout", true), true);
  assert.equal(persistBoolean(storage, "layout", true), true);
  assert.equal(storedBoolean(storage, "layout"), true);
  assert.equal(storedBoolean({ getItem: () => { throw new Error("blocked"); } }, "layout", true), true);
});

test("workspace tasks and recent streams collapse independently and persist", async () => {
  const {
    RECENT_STREAMS_COLLAPSED_STORAGE_KEY,
    WORKSPACE_TASKS_COLLAPSED_STORAGE_KEY,
    installCollapsibleSection,
  } = await layoutApi();
  const values = new Map([[RECENT_STREAMS_COLLAPSED_STORAGE_KEY, "true"]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const fakeElement = () => {
    const attributes = new Map();
    const listeners = new Map();
    return {
      attributes,
      listeners,
      title: "",
      addEventListener: (name, listener) => listeners.set(name, listener),
      setAttribute: (name, value) => attributes.set(name, String(value)),
      toggleAttribute: (name, force) => {
        if (force) attributes.set(name, "");
        else attributes.delete(name);
      },
    };
  };
  const workspaceSection = fakeElement();
  const workspaceToggle = fakeElement();
  const recentSection = fakeElement();
  const recentToggle = fakeElement();
  let workspaceChanges = 0;

  const workspaceControl = installCollapsibleSection({
    section: workspaceSection,
    toggle: workspaceToggle,
    storage,
    key: WORKSPACE_TASKS_COLLAPSED_STORAGE_KEY,
    collapsedTitle: "Развернуть задачи Workspace",
    expandedTitle: "Свернуть задачи Workspace",
    onChange: () => { workspaceChanges += 1; },
  });
  const recentControl = installCollapsibleSection({
    section: recentSection,
    toggle: recentToggle,
    storage,
    key: RECENT_STREAMS_COLLAPSED_STORAGE_KEY,
  });

  assert.equal(workspaceControl.collapsed, false);
  assert.equal(workspaceToggle.attributes.get("aria-expanded"), "true");
  assert.equal(recentControl.collapsed, true);
  assert.equal(recentToggle.attributes.get("aria-expanded"), "false");
  assert.equal(recentSection.attributes.has("data-section-collapsed"), true);

  workspaceToggle.listeners.get("click")();
  assert.equal(workspaceControl.collapsed, true);
  assert.equal(workspaceSection.attributes.has("data-section-collapsed"), true);
  assert.equal(workspaceToggle.title, "Развернуть задачи Workspace");
  assert.equal(values.get(WORKSPACE_TASKS_COLLAPSED_STORAGE_KEY), "true");
  assert.equal(workspaceChanges, 1);

  recentToggle.listeners.get("click")();
  assert.equal(recentControl.collapsed, false);
  assert.equal(recentSection.attributes.has("data-section-collapsed"), false);
  assert.equal(values.get(RECENT_STREAMS_COLLAPSED_STORAGE_KEY), "false");
});

test("task column is automatic by default and can be forced or disabled", async () => {
  const { resolveActivityColumnSeparation, shouldSeparateActivityColumns } = await layoutApi();
  assert.equal(shouldSeparateActivityColumns({
    availableHeight: 600,
    requiredHeight: 580,
  }), false);
  assert.equal(shouldSeparateActivityColumns({
    availableHeight: 600,
    requiredHeight: 720,
  }), true);
  assert.equal(shouldSeparateActivityColumns({
    alwaysSeparate: true,
    availableHeight: 600,
    requiredHeight: 580,
  }), true);
  assert.equal(shouldSeparateActivityColumns({
    autoSeparate: false,
    alwaysSeparate: true,
    availableHeight: 600,
    requiredHeight: 720,
  }), false);
  assert.equal(shouldSeparateActivityColumns({
    tasksAvailable: false,
    availableHeight: 600,
    requiredHeight: 720,
  }), false);
  assert.equal(shouldSeparateActivityColumns({
    tasksPresent: false,
    availableHeight: 600,
    requiredHeight: 720,
  }), false);
  assert.equal(shouldSeparateActivityColumns({
    alwaysSeparate: true,
    tasksPresent: false,
    availableHeight: 600,
    requiredHeight: 720,
  }), true);
  assert.equal(resolveActivityColumnSeparation({
    autoSeparate: true,
    columnCollapsed: true,
    wasSeparate: true,
    availableHeight: 600,
    requiredHeight: 580,
  }), true);
  assert.equal(resolveActivityColumnSeparation({
    autoSeparate: false,
    columnCollapsed: true,
    wasSeparate: true,
    availableHeight: 600,
    requiredHeight: 720,
  }), false);
});

test("automatic task layout measures list content instead of stretched list height", async () => {
  const { naturalStackHeight } = await layoutApi();
  assert.equal(naturalStackHeight({
    chrome: 16,
    gap: 6,
    itemHeights: [40, 52],
  }), 114);
  assert.equal(naturalStackHeight({
    chrome: 16,
    gap: 6,
    itemHeights: [],
  }), 16);
});

test("task column detects cards from either task section", async () => {
  const { taskPanelHasCards } = await layoutApi();
  assert.equal(taskPanelHasCards({ querySelector: () => ({ id: "stream-card" }) }), true);
  assert.equal(taskPanelHasCards({ querySelector: () => null }), false);
  assert.equal(taskPanelHasCards(null), false);
});

test("activity column divider clamps, restores, and persists its ratio", async () => {
  const {
    COLUMN_RATIO_STORAGE_KEY,
    columnRatioFromPointer,
    normalizeColumnRatio,
    persistColumnRatio,
    storedColumnRatio,
  } = await layoutApi();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(storedColumnRatio(storage), 0.5);
  assert.equal(columnRatioFromPointer({ left: 100, width: 400, pointerX: 180 }), 0.25);
  assert.equal(columnRatioFromPointer({ left: 100, width: 400, pointerX: 340 }), 0.6);
  assert.equal(columnRatioFromPointer({ left: 100, width: 400, pointerX: 500 }), 0.75);
  assert.equal(normalizeColumnRatio("invalid"), 0.5);
  assert.equal(persistColumnRatio(storage, 0.63), 0.63);
  assert.equal(values.get(COLUMN_RATIO_STORAGE_KEY), "0.63");
  assert.equal(storedColumnRatio(storage), 0.63);
});

test("single activity column keeps its share of the expanded rail", async () => {
  const { activityRailColumnState, activityRailWidthFactor } = await layoutApi();
  assert.equal(activityRailWidthFactor(activityRailColumnState({ separate: true }), 0.4), 1);
  assert.equal(activityRailWidthFactor(activityRailColumnState({
    separate: true,
    streamsCollapsed: true,
  }), 0.4), 0.4);
  assert.equal(activityRailWidthFactor(activityRailColumnState({
    separate: true,
    tasksCollapsed: true,
  }), 0.4), 0.6);
  assert.equal(activityRailWidthFactor(
    activityRailColumnState({ separate: false }),
    0.4,
    { autoCombined: true },
  ), 0.6);
  assert.equal(activityRailWidthFactor(
    activityRailColumnState({ separate: false }),
    0.7,
    { autoCombined: true },
  ), 0.7);
});

test("activity rail headings show task and attention-stream counts", async () => {
  const { countedActivityHeading } = await layoutApi();
  assert.equal(countedActivityHeading("Задачи", 7), "Задачи (7)");
  assert.equal(countedActivityHeading("Потоки", 3), "Потоки (3)");
  assert.equal(countedActivityHeading("Потоки", -2), "Потоки (0)");
});

test("activity headings stack when either allocated column is too narrow", async () => {
  const { activityHeadingsShouldStack } = await layoutApi();
  assert.equal(activityHeadingsShouldStack({
    availableWidth: 300,
    columnRatio: 0.5,
    gap: 8,
    taskWidth: 120,
    streamWidth: 130,
  }), false);
  assert.equal(activityHeadingsShouldStack({
    availableWidth: 300,
    columnRatio: 0.25,
    gap: 8,
    taskWidth: 120,
    streamWidth: 130,
  }), true);
});

test("fully collapsed activity rail fits the wider stacked heading", async () => {
  const { minimumCollapsedRailWidth } = await layoutApi();
  assert.equal(minimumCollapsedRailWidth({
    horizontalPadding: 16,
    taskWidth: 112.2,
    streamWidth: 126.8,
  }), 143);
});

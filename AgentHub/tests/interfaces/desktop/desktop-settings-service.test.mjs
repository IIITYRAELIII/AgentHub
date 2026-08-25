import assert from "node:assert/strict";
import test from "node:test";
import { DesktopSettingsService } from "../../../src/interfaces/desktop/desktop-settings-service.mjs";

test("Desktop settings service rejects a stale task-scoped mutation", async () => {
  const noop = () => {};
  const service = new DesktopSettingsService({
    isSelected: () => false, selectedTask: () => ({}), switchProvider: async () => ({}), isCodex: () => true,
    threadId: () => "t1", isCompacting: () => false, switchCodexModel: () => ({}), switchClaudeModel: () => ({}),
    updateCodexThreadSettings: async () => {}, saveState: async () => {}, getCodexReasoning: () => "high",
    setCodexReasoning: noop, getClaudeReasoning: () => "high", setClaudeReasoning: noop,
    getCodexMode: () => "default", setCodexMode: noop, getClaudeMode: () => "default", setClaudeMode: noop,
    getAutoApprove: () => true, setAutoApprove: noop, getIncludeClaudeUsage: () => true, setIncludeClaudeUsage: noop,
    getActivityRecentMinutes: () => 180, setActivityRecentMinutes: noop,
    getStreamOrderMode: () => "activity", setStreamOrderMode: noop,
    getStreamCardWidthMode: () => "auto", setStreamCardWidthMode: noop,
    getStreamCardFixedWidth: () => 90, setStreamCardFixedWidth: noop,
    getStreamCardGapEnabled: () => false, setStreamCardGapEnabled: noop,
    getPinnedWorkspaceStreams: () => ({}), setPinnedWorkspaceStreams: noop,
    projectUsage: async () => {}, findProjectIndex: () => 0, switchProject: async () => ({}), snapshot: async () => ({}),
    reasoningEfforts: ["high"], collaborationModes: ["default"],
  });
  await assert.rejects(service.update({ name: "model", value: "gpt" }), /уже не к выбранному/u);
});

test("Desktop settings service rejects a stale project mutation before switching", async () => {
  let switched = false;
  const noop = () => {};
  const service = new DesktopSettingsService({
    isSelected: () => false, selectedTask: () => ({ streamId: "other" }), switchProvider: async () => ({}), isCodex: () => true,
    threadId: () => "t1", isCompacting: () => false, switchCodexModel: () => ({}), switchClaudeModel: () => ({}),
    updateCodexThreadSettings: async () => {}, saveState: async () => {}, getCodexReasoning: () => "high",
    setCodexReasoning: noop, getClaudeReasoning: () => "high", setClaudeReasoning: noop,
    getCodexMode: () => "default", setCodexMode: noop, getClaudeMode: () => "default", setClaudeMode: noop,
    getAutoApprove: () => true, setAutoApprove: noop, getIncludeClaudeUsage: () => true, setIncludeClaudeUsage: noop,
    getActivityRecentMinutes: () => 180, setActivityRecentMinutes: noop,
    getStreamOrderMode: () => "activity", setStreamOrderMode: noop,
    getStreamCardWidthMode: () => "auto", setStreamCardWidthMode: noop,
    getStreamCardFixedWidth: () => 90, setStreamCardFixedWidth: noop,
    getStreamCardGapEnabled: () => false, setStreamCardGapEnabled: noop,
    getPinnedWorkspaceStreams: () => ({}), setPinnedWorkspaceStreams: noop,
    projectUsage: async () => {}, findProjectIndex: () => 0, switchProject: async () => { switched = true; return {}; }, snapshot: async () => ({}),
    reasoningEfforts: ["high"], collaborationModes: ["default"],
  });
  await assert.rejects(service.update({
    name: "project",
    value: "D:/client",
    streamId: "stream-client",
    provider: "codex",
    threadId: "thread-client",
  }), /уже не к выбранному/u);
  assert.equal(switched, false);
});

test("Desktop settings service persists the shared recent activity period", async () => {
  let current = 180;
  let saveCount = 0;
  const noop = () => {};
  const service = new DesktopSettingsService({
    isSelected: () => true, selectedTask: () => ({}), switchProvider: async () => ({}), isCodex: () => true,
    threadId: () => "t1", isCompacting: () => false, switchCodexModel: () => ({}), switchClaudeModel: () => ({}),
    updateCodexThreadSettings: async () => {}, saveState: async () => { saveCount += 1; }, getCodexReasoning: () => "high",
    setCodexReasoning: noop, getClaudeReasoning: () => "high", setClaudeReasoning: noop,
    getCodexMode: () => "default", setCodexMode: noop, getClaudeMode: () => "default", setClaudeMode: noop,
    getAutoApprove: () => true, setAutoApprove: noop, getIncludeClaudeUsage: () => true, setIncludeClaudeUsage: noop,
    getActivityRecentMinutes: () => current, setActivityRecentMinutes: (value) => { current = value; },
    getStreamOrderMode: () => "activity", setStreamOrderMode: noop,
    getStreamCardWidthMode: () => "auto", setStreamCardWidthMode: noop,
    getStreamCardFixedWidth: () => 90, setStreamCardFixedWidth: noop,
    getStreamCardGapEnabled: () => false, setStreamCardGapEnabled: noop,
    getPinnedWorkspaceStreams: () => ({}), setPinnedWorkspaceStreams: noop,
    projectUsage: async () => {}, findProjectIndex: () => 0, switchProject: async () => ({}),
    snapshot: async () => ({ settings: { activityRecentMinutes: current } }),
    reasoningEfforts: ["high"], collaborationModes: ["default"],
  });

  const result = await service.update({ name: "activityRecentMinutes", value: "245" });

  assert.equal(current, 245);
  assert.equal(saveCount, 1);
  assert.equal(result.setting.changed, true);
  await assert.rejects(
    service.update({ name: "activityRecentMinutes", value: "50000" }),
    /Неизвестный период/u,
  );
});

test("Desktop settings service persists shared Stream card settings", async () => {
  const current = {
    streamOrderMode: "activity",
    streamCardWidthMode: "auto",
    streamCardFixedWidth: 90,
    streamCardGapEnabled: false,
    pinnedWorkspaceStreams: {},
  };
  let saveCount = 0;
  const noop = () => {};
  const service = new DesktopSettingsService({
    isSelected: () => true, selectedTask: () => ({}), switchProvider: async () => ({}), isCodex: () => true,
    threadId: () => "t1", isCompacting: () => false, switchCodexModel: () => ({}), switchClaudeModel: () => ({}),
    updateCodexThreadSettings: async () => {}, saveState: async () => { saveCount += 1; }, getCodexReasoning: () => "high",
    setCodexReasoning: noop, getClaudeReasoning: () => "high", setClaudeReasoning: noop,
    getCodexMode: () => "default", setCodexMode: noop, getClaudeMode: () => "default", setClaudeMode: noop,
    getAutoApprove: () => true, setAutoApprove: noop, getIncludeClaudeUsage: () => true, setIncludeClaudeUsage: noop,
    getActivityRecentMinutes: () => 180, setActivityRecentMinutes: noop,
    getStreamOrderMode: () => current.streamOrderMode,
    setStreamOrderMode: (value) => { current.streamOrderMode = value; },
    getStreamCardWidthMode: () => current.streamCardWidthMode,
    setStreamCardWidthMode: (value) => { current.streamCardWidthMode = value; },
    getStreamCardFixedWidth: () => current.streamCardFixedWidth,
    setStreamCardFixedWidth: (value) => { current.streamCardFixedWidth = value; },
    getStreamCardGapEnabled: () => current.streamCardGapEnabled,
    setStreamCardGapEnabled: (value) => { current.streamCardGapEnabled = value; },
    getPinnedWorkspaceStreams: () => current.pinnedWorkspaceStreams,
    setPinnedWorkspaceStreams: (value) => { current.pinnedWorkspaceStreams = value; },
    projectUsage: async () => {}, findProjectIndex: () => 0, switchProject: async () => ({}),
    snapshot: async () => ({ settings: { ...current } }),
    reasoningEfforts: ["high"], collaborationModes: ["default"],
  });

  await service.update({ name: "streamOrderMode", value: "manual" });
  await service.update({ name: "streamCardWidthMode", value: "fixed" });
  await service.update({ name: "streamCardFixedWidth", value: "237" });
  const result = await service.update({ name: "streamCardGapEnabled", value: "true" });
  await service.update({
    name: "pinnedWorkspaceStreams",
    value: JSON.stringify({ "workspace-1": ["stream-1"] }),
  });

  assert.deepEqual(current, {
    streamOrderMode: "manual",
    streamCardWidthMode: "fixed",
    streamCardFixedWidth: 237,
    streamCardGapEnabled: true,
    pinnedWorkspaceStreams: { "workspace-1": ["stream-1"] },
  });
  assert.equal(saveCount, 5);
  assert.equal(result.settings.streamCardGapEnabled, true);
  await assert.rejects(
    service.update({ name: "streamCardFixedWidth", value: "451" }),
    /Неизвестная ширина/u,
  );
});

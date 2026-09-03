import assert from "node:assert/strict";
import test from "node:test";

import { createDesktopCommandComposition } from "../../src/composition/desktop-command-composition.mjs";

const noop = () => undefined;

function dependencyProxy(overrides = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      return property in target ? target[property] : noop;
    },
  });
}

test("desktop command composition exposes Workspace archive and restore commands", async () => {
  const calls = [];
  const workspaceActions = Object.fromEntries([
    "renameWorkspace", "updateWorkspaceSettings", "moveWorkspaceToFolder", "renameWorkspaceFolder", "updateWorkspaceDeveloperRules",
    "readWorkspaceReleasePlan", "completeWorkspaceRelease", "createWorkspace",
    "archiveWorkspace", "restoreWorkspace", "createWorkspaceFromStream", "mergeWorkspaces",
    "createStream", "renameStream", "archiveStream", "updateStreamSettings",
    "updateStreamDeveloperRules", "moveStream",
  ].map((name) => [name, (params) => {
    calls.push({ name, params });
    return name;
  }]));
  const composition = createDesktopCommandComposition({
    taskService: dependencyProxy(),
    taskCommands: dependencyProxy(),
    restart: dependencyProxy({ operationStore: {} }),
    navigation: dependencyProxy(),
    settings: dependencyProxy(),
    application: dependencyProxy(),
    telegramActions: dependencyProxy(),
    workspaceActions,
  });

  await composition.applicationCommands.dispatch(
    "workspace.archive",
    { workspaceId: "workspace-1" },
    { source: "desktop", userId: "7" },
  );
  await composition.applicationCommands.dispatch(
    "workspace.restore",
    { workspaceId: "workspace-1" },
    { source: "desktop", userId: "7" },
  );

  assert.deepEqual(calls, [
    { name: "archiveWorkspace", params: { workspaceId: "workspace-1" } },
    { name: "restoreWorkspace", params: { workspaceId: "workspace-1" } },
  ]);
});

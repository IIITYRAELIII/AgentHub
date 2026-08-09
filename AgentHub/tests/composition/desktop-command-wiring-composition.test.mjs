import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceActions } from "../../src/composition/desktop-command-wiring-composition.mjs";

function fixture({ sourceSurvives = false } = {}) {
  const calls = [];
  const workspaces = new Set(["source", "target"]);
  const services = {
    workspaceMutation: async (run) => run(),
    workspaceCatalog: {
      stream: () => ({ workspaceId: "source" }),
      workspace: (id) => (workspaces.has(id) ? { id } : null),
    },
    workspaceCatalogService: {
      createWorkspaceFromStream: () => {
        workspaces.add("created");
        if (!sourceSurvives) workspaces.delete("source");
        return { workspace: { id: "created" }, stream: { id: "stream" } };
      },
      mergeWorkspaces: () => {
        workspaces.delete("source");
        return { id: "target" };
      },
      moveStream: ({ workspaceId }) => {
        if (!sourceSurvives) workspaces.delete("source");
        return { id: "stream", workspaceId };
      },
    },
    taskBoard: {
      reassignWorkspace: (...args) => calls.push(args),
    },
  };
  return { actions: createWorkspaceActions(services), calls };
}

test("workspace merge reassigns board cards to the surviving Workspace", async () => {
  const { actions, calls } = fixture();
  await actions.mergeWorkspaces({ sourceWorkspaceId: "source", targetWorkspaceId: "target" });
  assert.deepEqual(calls, [["source", "target"]]);
});

test("moving the last Stream reassigns cards from the removed Workspace", async () => {
  const { actions, calls } = fixture();
  await actions.moveStream({ streamId: "stream", workspaceId: "target" });
  assert.deepEqual(calls, [["source", "target"]]);
});

test("moving a Stream keeps cards when the source Workspace survives", async () => {
  const { actions, calls } = fixture({ sourceSurvives: true });
  await actions.moveStream({ streamId: "stream", workspaceId: "target" });
  assert.deepEqual(calls, []);
});

test("creating a Workspace from the last Stream reassigns source cards", async () => {
  const { actions, calls } = fixture();
  await actions.createWorkspaceFromStream({ streamId: "stream", name: "Created" });
  assert.deepEqual(calls, [["source", "created"]]);
});

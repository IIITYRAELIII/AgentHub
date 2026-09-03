import assert from "node:assert/strict";
import test from "node:test";

import { createWorkspaceActions } from "../../src/composition/desktop-command-wiring-composition.mjs";

function fixture({ sourceSurvives = false } = {}) {
  const calls = [];
  const workspaces = new Set(["source", "target"]);
  const services = {
    workspaceMutation: async (run) => run(),
    catalogEntries: () => [],
    runForTask: () => null,
    workspaceCatalog: {
      stream: () => ({ workspaceId: "source" }),
      workspace: (id) => (workspaces.has(id) ? { id } : null),
    },
    workspaceCatalogService: {
      renameWorkspaceFolder: (params) => (calls.push(["folder", params]), params),
      archiveWorkspace: ({ workspaceId }) => ({ id: workspaceId, archivedAtMs: 1 }),
      restoreWorkspace: ({ workspaceId }) => ({ id: workspaceId, archivedAtMs: null }),
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
      archiveStream: ({ streamId }) => ({ id: streamId, archivedAtMs: 1 }),
    },
    taskBoard: {
      reassignWorkspace: (...args) => calls.push(args),
    },
    selectionStore: {
      streamId: "stream",
      activeProjectRoot: "D:/work",
      switchProject: (...args) => calls.push(["selection", ...args]),
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

test("archiving a Stream uses the Workspace mutation path", async () => {
  const { actions } = fixture();
  assert.deepEqual(await actions.archiveStream({ streamId: "stream" }), {
    id: "stream",
    archivedAtMs: 1,
  });
});

test("archiving a Stream is blocked while one of its Threads is running", async () => {
  const actions = createWorkspaceActions({
    workspaceMutation: async (run) => run(),
    catalogEntries: () => [{ streamId: "stream", threadId: "thread" }],
    runForTask: () => ({ id: "run" }),
    workspaceCatalogService: { archiveStream: () => assert.fail("must not archive") },
  });
  await assert.rejects(
    actions.archiveStream({ streamId: "stream" }),
    /завершите активный ход/u,
  );
});

test("renaming a Workspace folder uses one Workspace mutation", async () => {
  const { actions, calls } = fixture();
  assert.deepEqual(await actions.renameWorkspaceFolder({
    fromFolderName: "Клиенты",
    toFolderName: "Заказчики",
  }), {
    fromFolderName: "Клиенты",
    toFolderName: "Заказчики",
  });
  assert.deepEqual(calls, [["folder", {
    fromFolderName: "Клиенты",
    toFolderName: "Заказчики",
  }]]);
});

test("archiving a Workspace hides the selected Stream without deleting it", async () => {
  const { actions, calls } = fixture();
  assert.deepEqual(await actions.archiveWorkspace({ workspaceId: "source" }), {
    id: "source",
    archivedAtMs: 1,
  });
  assert.deepEqual(calls, [["selection", "D:/work"]]);
});

test("archiving a Workspace is blocked while one of its Threads is running", async () => {
  const actions = createWorkspaceActions({
    workspaceMutation: async (run) => run(),
    catalogEntries: () => [{ workspaceId: "source", streamId: "stream", threadId: "thread" }],
    runForTask: () => ({ id: "run" }),
    workspaceCatalog: { stream: () => ({ workspaceId: "source" }) },
    workspaceCatalogService: { archiveWorkspace: () => assert.fail("must not archive") },
    selectionStore: { streamId: "stream", activeProjectRoot: "D:/work" },
  });
  await assert.rejects(
    actions.archiveWorkspace({ workspaceId: "source" }),
    /завершите активные ходы/u,
  );
});

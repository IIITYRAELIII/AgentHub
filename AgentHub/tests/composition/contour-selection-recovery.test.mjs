import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClientTaskSelectionService } from "../../src/application/client-task-selection-service.mjs";
import { TaskSelectionStore } from "../../src/application/task-selection-store.mjs";
import { recoverRejectedContourSelection } from "../../src/composition/contour-selection-recovery.mjs";
import { createContourCommandMapping } from "../../src/infrastructure/filesystem/test-contour-command-mapping.mjs";
import { HubSessionState } from "../../src/runtime/hub-session-state.mjs";

// Тот же случай, что остановил Test Contour: выбор сохранён с содержащим
// проектом, а canonical binding Thread указывает на вложенный каталог.
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "contour-selection-"));
  const recording = path.join(root, "recording");
  const sourceRoot = path.join(root, "source-project");
  const nestedCwd = path.join(sourceRoot, "Utilities");
  await mkdir(recording);
  await writeFile(path.join(recording, "recording-provider.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "literal-recording-provider",
    root: recording,
    externalEffects: "deny",
    sources: [{ source: sourceRoot, kind: "project" }],
    threads: [{ provider: "codex", id: "thread-nested", streamId: "stream-nested", cwd: nestedCwd }],
  }));
  const mapping = createContourCommandMapping({ root: recording });
  const selectionStore = new TaskSelectionStore({
    activeProvider: "codex",
    activeProjectRoot: sourceRoot,
    streamId: "stream-nested",
    threadIds: { codex: "thread-nested", claude: "claude-thread" },
    activeThreadTitle: "Agent HUB - Chat",
  });
  const selectedTask = () => ({
    streamId: selectionStore.streamId,
    provider: selectionStore.activeProvider,
    projectRoot: selectionStore.activeProjectRoot,
    threadId: selectionStore.threadId,
  });
  const sessionState = new HubSessionState();
  sessionState.setChatId(42);
  const foreignSelection = {
    streamId: "other-stream", provider: "codex", projectRoot: sourceRoot, threadId: "other-thread", taskTitle: "Other",
  };
  sessionState.setClientTaskSelection("telegram:7", foreignSelection);
  const createSelectionService = () => new ClientTaskSelectionService({
    sessionState,
    fallbackSelection: () => mapping.target(selectedTask()),
    fallbackTitle: () => selectionStore.activeThreadTitle,
    findProject: () => ({ path: sourceRoot }),
    catalogEntries: () => [],
    catalogEntryIsSelected: () => false,
    preferences: { current: () => ({}) },
    samePath: (left, right) => left === right,
    save: async () => {},
  });
  return {
    root, mapping, selectionStore, selectedTask, sessionState, foreignSelection,
    sourceRoot, nestedCwd, createSelectionService,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("a stored containing-root selection no longer aborts startup and only its Thread is cleared", async () => {
  const f = await fixture();
  try {
    assert.throws(f.createSelectionService, /project differs/, "reproduces the startup construction failure");

    const warnings = [];
    const rejected = recoverRejectedContourSelection({
      mapping: f.mapping,
      selectionStore: f.selectionStore,
      selectedTask: f.selectedTask,
      logger: { warn: (message) => warnings.push(message) },
    });

    assert.deepEqual(rejected, {
      provider: "codex", streamId: "stream-nested", threadId: "thread-nested", projectRoot: f.sourceRoot,
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /thread-nested/u);
    assert.match(warnings[0], /project differs/u);
    assert.equal(f.selectionStore.threadId, null);
    assert.equal(f.selectionStore.streamId, null);
    assert.equal(f.selectionStore.activeProjectRoot, f.sourceRoot);
    assert.equal(f.selectionStore.snapshot().threadIds.claude, "claude-thread");

    const service = f.createSelectionService();
    assert.equal(service.selectedTask().threadId, null);
    assert.deepEqual(f.sessionState.clientTaskSelection("telegram:7"), f.foreignSelection);

    // Обычный выбор через binding по-прежнему даёт право на выполнение, а
    // содержащий проект его не получает.
    const selected = f.mapping.target({
      provider: "codex", streamId: "stream-nested", threadId: "thread-nested", projectRoot: f.nestedCwd,
    });
    f.selectionStore.selectTask({
      activeProvider: selected.provider,
      activeProjectRoot: selected.projectRoot,
      streamId: selected.streamId,
      threadId: selected.threadId,
      activeThreadTitle: "Agent HUB - Chat",
    });
    assert.equal(f.selectionStore.threadId, "thread-nested");
    assert.equal(recoverRejectedContourSelection({
      mapping: f.mapping, selectionStore: f.selectionStore, selectedTask: f.selectedTask, logger: { warn() {} },
    }), null);
    assert.throws(() => f.mapping.target({
      provider: "codex", streamId: "stream-nested", threadId: "thread-nested", projectRoot: f.sourceRoot,
    }), /project differs/u);
  } finally {
    await f.cleanup();
  }
});

test("other startup mapping failures stay fatal and leave the stored selection untouched", async () => {
  const f = await fixture();
  try {
    f.selectionStore.selectTask({
      activeProvider: "codex",
      activeProjectRoot: f.sourceRoot,
      streamId: "foreign-stream",
      threadId: "thread-nested",
      activeThreadTitle: "Foreign",
    });
    const warnings = [];
    assert.throws(() => recoverRejectedContourSelection({
      mapping: f.mapping,
      selectionStore: f.selectionStore,
      selectedTask: f.selectedTask,
      logger: { warn: (message) => warnings.push(message) },
    }), /Stream differs/u);
    assert.equal(warnings.length, 0);
    assert.equal(f.selectionStore.threadId, "thread-nested");
    assert.equal(f.selectionStore.streamId, "foreign-stream");
  } finally {
    await f.cleanup();
  }
});

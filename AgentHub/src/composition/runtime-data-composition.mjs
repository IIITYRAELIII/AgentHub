import path from "node:path";
import { DeferredInputStore } from "../application/deferred-input-store.mjs";
import { StreamMaintenanceRegistry } from "../application/stream-maintenance-registry.mjs";
import {
  TaskDismissalRegistry,
  TaskRunRegistry,
} from "../domain/task-runs.mjs";
import { MessageReceiptRegistry } from "../infrastructure/persistence/message-receipts.mjs";
import { TaskDiffStore } from "../infrastructure/persistence/task-diff-store.mjs";
import { LocalTaskSyncStore } from "../infrastructure/persistence/task-sync-store.mjs";
import { StreamMessagePinStore } from "../infrastructure/persistence/stream-message-pin-store.mjs";
import { DeferredComposerTransferRegistry } from "../application/deferred-composer-transfer-registry.mjs";

export async function createRuntimeDataComposition({
  config,
  projects,
  taskDiffsFile,
  taskSyncFile,
  findProject,
  canonicalizeProjectRoots,
}) {
  const taskRuns = new TaskRunRegistry();
  const dismissedExternalTasks = new TaskDismissalRegistry();
  const deferredInputs = new DeferredInputStore();
  const composerTransfers = new DeferredComposerTransferRegistry({
    ttlMs: config.deferredInputTtlHours * 60 * 60 * 1000,
  });
  const streamMaintenance = new StreamMaintenanceRegistry();
  const taskDiffs = new TaskDiffStore({ filePath: taskDiffsFile, limit: 100 });
  const taskSyncStore = new LocalTaskSyncStore({
    filePath: taskSyncFile,
    databaseFile: path.join(config.dataDir, "journal.sqlite"),
    canonicalizeProjectRoot: (projectRoot) => findProject(projectRoot)?.path ?? projectRoot,
    canonicalizeValue: (value) => canonicalizeProjectRoots(value, projects),
  });
  const messagePins = new StreamMessagePinStore({
    databaseFile: path.join(config.dataDir, "journal.sqlite"),
  });
  await Promise.all([taskDiffs.load(), taskSyncStore.load()]);
  await taskSyncStore.save();

  return {
    taskRuns,
    dismissedExternalTasks,
    deferredInputs,
    composerTransfers,
    streamMaintenance,
    pendingInputs: deferredInputs.pending,
    queuedInputs: deferredInputs.queued,
    taskDiffs,
    taskSyncStore,
    messagePins,
    lastSeenTaskTurnIds: new Map(),
    turnTemporaryFiles: new Map(),
    turnSpeechButtons: new Map(),
    cancelledManagedClaudeTasks: new Map(),
    forwardBundles: new Map(),
    desktopMessageReceipts: new MessageReceiptRegistry(),
    statusMediaFileIds: new Map(),
  };
}

import { samePath } from "../infrastructure/filesystem/config.mjs";
import {
  taskCatalogTitleSignature,
} from "../domain/task-catalog-titles.mjs";
import {
  taskOrderingActivityAtMs,
} from "../application/task-catalog-projection.mjs";
import { catalogEntryIsSelected } from "../domain/task-catalog-identity.mjs";
import { statusTaskEntries } from "../interfaces/telegram/task-catalog-presentation.mjs";
import { taskDisplayTitle } from "../domain/task-display-title.mjs";
import { updateTaskRunTitle } from "../domain/task-runs.mjs";

export function createTaskCatalogFinalizationComposition({
  projects,
  titleReconcileIntervalMs,
  journalDatabaseFile,
  projectionProjectRoots,
  workLogUsageStore,
  taskRuns,
  savedLastTaskMessageRecord,
  deferredTaskMessageAtMs,
  selectedTask,
  getActiveThreadTitle,
  selectionStore,
  taskSyncStore,
  saveState,
}) {
  let synchronizedTitleSignature = "";
  let titlesSynchronizedAt = 0;

  async function finalize(mergedEntries) {
    let nextCatalog = mergedEntries;
    for (const entry of nextCatalog) {
      entry.displayTitle = taskDisplayTitle(entry);
      taskRuns.bindStream?.(entry);
      entry.orderingActivityAtMs = taskOrderingActivityAtMs(entry, {
        run: taskRuns.forTask(entry),
        lastMessage: savedLastTaskMessageRecord(entry),
        userMessageAtMs: deferredTaskMessageAtMs(entry),
      });
    }
    nextCatalog = statusTaskEntries(nextCatalog, nextCatalog.length);
    const nextTitleSignature = taskCatalogTitleSignature(nextCatalog);
    const shouldSynchronizeTitles = nextTitleSignature !== synchronizedTitleSignature
      || Date.now() - titlesSynchronizedAt >= titleReconcileIntervalMs;
    if (shouldSynchronizeTitles) {
      for (const project of projects) {
        await workLogUsageStore.synchronizeTaskTitlesAndProject({
          titles: nextCatalog
            .filter((entry) => samePath(entry.projectRoot, project.path))
            .map((entry) => ({
              provider: entry.provider,
              threadId: entry.threadId,
              taskTitle: entry.title,
            })),
          projectRoot: project.path,
          journalDatabaseFile,
          projectionProjectRoots,
        });
      }
      synchronizedTitleSignature = nextTitleSignature;
      titlesSynchronizedAt = Date.now();
    }

    let titleChanged = false;
    for (const run of taskRuns.values()) {
      const entry = nextCatalog.find((item) => catalogEntryIsSelected(item, run));
      if (entry) titleChanged = updateTaskRunTitle(run, entry.displayTitle) || titleChanged;
    }
    const current = nextCatalog.find((entry) => catalogEntryIsSelected(entry, selectedTask()));
    if (current?.streamId && current.streamId !== selectionStore.streamId) {
      selectionStore.setThread(current.threadId, {
        provider: current.provider,
        streamId: current.streamId,
      });
      titleChanged = true;
    }
    if (current?.displayTitle && current.displayTitle !== getActiveThreadTitle()) {
      selectionStore.setTitle(current.displayTitle);
      titleChanged = true;
    }
    await taskSyncStore.recordCatalog(nextCatalog);
    await taskSyncStore.save();
    if (titleChanged) await saveState();
    return nextCatalog;
  }

  return { finalize };
}

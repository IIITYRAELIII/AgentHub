import { writeTextAtomic } from "../infrastructure/persistence/state-store.mjs";

export function createStatePersistenceComposition({
  rememberProviderSettings,
  selectionStore,
  runtimeStateCoordinator,
  pinnedTaskTitlesFile,
  taskMetadata,
}) {
  function saveState() {
    rememberProviderSettings();
    selectionStore.rememberCurrentThread();
    return runtimeStateCoordinator.save();
  }

  function savePinnedTaskTitles() {
    return writeTextAtomic(
      pinnedTaskTitlesFile,
      `${JSON.stringify(taskMetadata.pinnedTitlesSnapshot(), null, 2)}\n`,
    );
  }

  return { saveState, savePinnedTaskTitles };
}

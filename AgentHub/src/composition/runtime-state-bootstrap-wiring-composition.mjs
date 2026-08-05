import { createRuntimeStateRestorationComposition } from "./runtime-state-restoration-composition.mjs";
import { runStartupMaintenance } from "./startup-maintenance-composition.mjs";

export async function createRuntimeStateBootstrapWiring({
  restoration,
  applyRestoredState,
  initializeJournal,
  startupMaintenance,
  logger = console,
}) {
  const {
    runtimeStateCoordinator,
    stateLoadFailed,
    restoredState,
  } = await createRuntimeStateRestorationComposition(restoration);

  const restoredTurnEndSnapshot = restoredState
    ? applyRestoredState(restoredState) ?? {}
    : {};
  const journalStartupReady = initializeJournal(restoredTurnEndSnapshot).catch((error) => {
    logger.error("Cannot initialize journal projection:", error.message);
  });

  await runStartupMaintenance({
    ...startupMaintenance,
    stateLoadFailed,
  });

  return {
    runtimeStateCoordinator,
    restoredState,
    journalStartupReady,
  };
}

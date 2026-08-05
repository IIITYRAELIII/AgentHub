import { taskHasUnreadAnswer } from "../infrastructure/persistence/task-read-state-store.mjs";
import { DesktopReadModelService } from "../interfaces/desktop/desktop-read-model-service.mjs";
import { createDesktopSnapshotFactory } from "../interfaces/desktop/desktop-snapshot.mjs";
import { createDesktopTaskHistoryFactory } from "../interfaces/desktop/desktop-task-history.mjs";

export function createDesktopReadComposition({
  snapshot,
  readModel,
  history,
}) {
  const {
    desktopContextSnapshot,
    desktopRunSnapshot,
    desktopTaskSnapshot,
    desktopSnapshot: rawDesktopSnapshot,
  } = createDesktopSnapshotFactory({
    ...snapshot,
    readState: {
      hasUnread: (answer) => taskHasUnreadAnswer(answer, readModel.readStateStore.get(answer)),
    },
  });

  const desktopReadModel = new DesktopReadModelService({
    snapshot: rawDesktopSnapshot,
    readStateStore: readModel.readStateStore,
    trustedDeviceUserId: readModel.trustedDeviceUserId,
    hasAllowedUsers: readModel.hasAllowedUsers,
    androidEnabled: readModel.androidEnabled,
    lastTaskMessage: readModel.lastTaskMessage,
  });

  const desktopSnapshot = (...args) => desktopReadModel.snapshot(...args);
  const desktopTaskHistory = createDesktopTaskHistoryFactory(history);

  return {
    desktopContextSnapshot,
    desktopRunSnapshot,
    desktopTaskSnapshot,
    desktopSnapshot,
    desktopTaskHistory,
    markDesktopTaskRead: (...args) => desktopReadModel.markTaskRead(...args),
  };
}

/* Source revision of the Desktop snapshot. While transient work is in flight
   the revision is null, which disables the notModified cache. The recent
   restart failure is part of the revision: a settled failure, a later success
   and the end of its notice window each invalidate a cached snapshot. */
export function createDesktopSnapshotRevision({
  pendingInputs,
  queuedInputs,
  approvalController,
  hostState,
  contextCompactions,
  taskCatalogService,
  streamMaintenance,
  taskRuns,
  selectionStore,
  agentPreferences,
  modelCatalogRevision = () => 0,
  taskBoard,
  lastTaskMessageRevision,
  taskReadStateStore,
  desktopMessageReceipts,
  messagePins,
  taskSyncStore,
  usdRubRateStore,
  serverControlController,
  recentRestartFailure,
}) {
  return async function desktopSnapshotRevision() {
    if (
      pendingInputs.size
      || queuedInputs.size
      || approvalController.pending.size
      || hostState.restartRequest
      || contextCompactions.runningCount()
    ) return null;
    const entries = taskCatalogService.entries;
    if (entries.some((entry) => streamMaintenance.entry(entry))) return null;
    return JSON.stringify({
      catalog: taskCatalogService.snapshotRevision,
      runs: taskRuns.revision,
      selection: selectionStore.revision,
      preferences: agentPreferences.snapshot(),
      modelCatalog: modelCatalogRevision(),
      autoApprove: hostState.autoApprove,
      board: taskBoard.snapshotRevision,
      messages: lastTaskMessageRevision(),
      readState: taskReadStateStore.revision,
      receipts: desktopMessageReceipts.revision,
      messagePins: messagePins.revision, taskHistory: taskSyncStore.revision,
      exchangeRates: usdRubRateStore.snapshot(),
      server: await serverControlController.snapshot({ activeCount: 0, restart: null }),
      restartFailure: recentRestartFailure(),
    });
  };
}

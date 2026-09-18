import { rapidDeferredInputDuplicate } from "../domain/deferred-input.mjs";

function setBoundedMapValue(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

export class HubRuntimeStateCoordinator {
  constructor({ store, canonicalize, restoreSnapshot, createSnapshot, log = console }) {
    this.store = store;
    this.canonicalize = canonicalize;
    this.restoreSnapshot = restoreSnapshot;
    this.createSnapshot = createSnapshot;
    this.log = log;
    this.writeQueue = Promise.resolve();
    this.pendingSave = false;
    this.pendingSaveWaiters = [];
    this.draining = false;
  }

  async restore() {
    try {
      const loaded = await this.store.load();
      if (!loaded.value) throw Object.assign(new Error("state file is missing"), { code: "ENOENT" });
      if (loaded.recovered) this.log.warn(`Recovered runtime state from ${loaded.source}`);
      if (loaded.migrated) this.log.log(`Runtime state migrated to runtime.sqlite from ${loaded.source}`);
      return {
        failed: false,
        value: await this.restoreSnapshot(this.canonicalize(loaded.value)),
      };
    } catch (error) {
      if (error?.code === "ENOENT") return { failed: false, value: null };
      this.log.error("Cannot read state:", error.message);
      return { failed: true, value: null, error };
    }
  }

  save() {
    const saved = new Promise((resolve, reject) => {
      this.pendingSave = true;
      this.pendingSaveWaiters.push({ resolve, reject });
    });
    if (!this.draining) this.#startDrain();
    return saved;
  }

  flush() {
    return this.writeQueue;
  }

  #startDrain() {
    this.draining = true;
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(() => new Promise((resolve) => setImmediate(resolve)))
      .then(() => this.#drain())
      .finally(() => {
        this.draining = false;
        if (this.pendingSave) this.#startDrain();
      });
  }

  async #drain() {
    let failure = null;
    while (this.pendingSave) {
      const waiters = this.pendingSaveWaiters;
      this.pendingSave = false;
      this.pendingSaveWaiters = [];
      try {
        const snapshot = this.createSnapshot();
        await this.store.save(snapshot);
        for (const waiter of waiters) waiter.resolve();
      } catch (error) {
        failure ??= error;
        for (const waiter of waiters) waiter.reject(error);
      }
    }
    if (failure) throw failure;
  }
}

export async function restoreHubRuntimeSnapshot(saved, context) {
  const {
    selectionStore,
    findProject,
    taskMetadata,
    preferences,
    statusMediaFileIds,
    runJournal,
    lastSeenTaskTurnIds,
    codexUsageTracker,
    contextCompactions,
    codexTurnStarts,
    codexTerminalAudit,
    turnEndNotifications,
    dismissedExternalTasks,
    cancelledManagedClaudeTasks,
    pendingInputs,
    queuedInputs,
    composerTransfers,
    restoreDeferredInput,
    deferredInputOptions,
    isRetryableDeferredLaunchError,
    desktopMessageReceipts,
    updateDeferredDesktopReceipt,
    forwardBundles,
    restoreForwardBundle,
    forwardBundleAttachmentPaths,
    removeFiles,
    deferredInputTtlMs,
    maximumDeferredInputs,
    taskRuns,
    restoreTaskRun,
    warn = console.warn,
  } = context;

  if (Array.isArray(saved.statusMediaFileIds)) {
    for (const [name, fileId] of saved.statusMediaFileIds.slice(-50)) {
      if (typeof name === "string" && typeof fileId === "string" && fileId) {
        statusMediaFileIds.set(name, fileId);
      }
    }
  }

  const restoredSelection = selectionStore.snapshot();
  if (typeof saved.activeProjectRoot === "string") {
    const savedProject = findProject(saved.activeProjectRoot);
    if (savedProject) restoredSelection.activeProjectRoot = savedProject.path;
  }
  const savedProvider = saved.activeProvider ?? saved.provider;
  if (savedProvider === "codex" || savedProvider === "claude") restoredSelection.activeProvider = savedProvider;
  if (saved.threadIds && typeof saved.threadIds === "object") {
    if (typeof saved.threadIds.codex === "string") restoredSelection.threadIds.codex = saved.threadIds.codex;
    if (typeof saved.threadIds.claude === "string") restoredSelection.threadIds.claude = saved.threadIds.claude;
  } else if (typeof saved.threadId === "string" && ["codex", "claude"].includes(saved.provider)) {
    restoredSelection.threadIds[saved.provider] = saved.threadId;
  }
  restoredSelection.threadId = restoredSelection.threadIds[restoredSelection.activeProvider] ?? null;
  restoredSelection.streamId = typeof saved.streamId === "string" ? saved.streamId : null;
  if (typeof saved.activeThreadTitle === "string") restoredSelection.activeThreadTitle = saved.activeThreadTitle;
  selectionStore.restore(restoredSelection);
  taskMetadata.restore(saved);
  preferences.restore(saved);

  const chatId = Number.isSafeInteger(saved.chatId) ? saved.chatId : null;
  const updateOffset = Number.isSafeInteger(saved.updateOffset) && saved.updateOffset >= 0
    ? saved.updateOffset
    : 0;
  runJournal.restoreLastMessages(saved.lastTaskMessages);
  if (Array.isArray(saved.lastSeenTaskTurnIds)) {
    for (const entry of saved.lastSeenTaskTurnIds.slice(-500)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
        lastSeenTaskTurnIds.set(entry[0], entry[1]);
      }
    }
  }
  contextCompactions.restore(saved.contextCompactions);
  codexUsageTracker.restore(saved);
  if (Array.isArray(saved.codexTurnStarts)) {
    for (const entry of saved.codexTurnStarts.slice(-500)) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && entry[1]) {
        codexTurnStarts.set(entry[0], entry[1]);
      }
    }
  }
  const codexHookReceipts = saved.codexHookReceipts && typeof saved.codexHookReceipts === "object"
    ? { start: saved.codexHookReceipts.start ?? null, stop: saved.codexHookReceipts.stop ?? null }
    : { start: null, stop: null };
  codexTerminalAudit.restore(saved.codexTerminalAudit);
  const restoredTurnEndSnapshot = saved.turnEndNotifications ?? {};
  const notificationStats = turnEndNotifications.restore(restoredTurnEndSnapshot);
  if (notificationStats.droppedLegacyPending || notificationStats.droppedStalePending) {
    warn(`Discarded deferred turn-end messages: legacy=${notificationStats.droppedLegacyPending}, stale=${notificationStats.droppedStalePending}`);
  }
  if (Array.isArray(saved.dismissedExternalTasks)) dismissedExternalTasks.restore(saved.dismissedExternalTasks);
  for (const [key, cancelledAtMs] of Array.isArray(saved.cancelledManagedClaudeTasks)
    ? saved.cancelledManagedClaudeTasks
    : []) {
    if (typeof key === "string" && Number.isFinite(Number(cancelledAtMs))) {
      setBoundedMapValue(cancelledManagedClaudeTasks, key, Number(cancelledAtMs), 200);
    }
  }

  const restoredDuplicateInputs = [];
  for (const item of Array.isArray(saved.pendingInputs) ? saved.pendingInputs : []) {
    const restored = restoreDeferredInput(item, deferredInputOptions);
    if (!restored) continue;
    const destination = restored.destination === "pending"
      && restored.item.lastError
      && isRetryableDeferredLaunchError(new Error(restored.item.lastError))
      ? "queued"
      : restored.destination;
    (destination === "queued" ? queuedInputs : pendingInputs).set(restored.item.id, restored.item);
  }
  for (const item of Array.isArray(saved.queuedInputs) ? saved.queuedInputs : []) {
    const restored = restoreDeferredInput(item, deferredInputOptions);
    if (!restored) continue;
    const duplicate = [...queuedInputs.values()].find((candidate) => (
      rapidDeferredInputDuplicate(candidate, restored.item)
    ));
    if (duplicate) restoredDuplicateInputs.push(restored.item);
    else queuedInputs.set(restored.item.id, restored.item);
  }
  desktopMessageReceipts.restore(saved.desktopMessageReceipts);
  await composerTransfers?.restore?.(saved.deferredComposerTransfers, {
    cleanup: (item) => removeFiles(item?.temporaryFiles ?? []),
  });
  for (const item of restoredDuplicateInputs) updateDeferredDesktopReceipt(item, "cancelled");
  if (restoredDuplicateInputs.length) {
    warn(`Discarded ${restoredDuplicateInputs.length} rapid duplicate queued input(s)`);
  }
  for (const item of pendingInputs.values()) updateDeferredDesktopReceipt(item, "pending");
  for (const item of queuedInputs.values()) {
    updateDeferredDesktopReceipt(item, item.dispatchingAt ? "dispatching" : "queued");
  }

  for (const value of Array.isArray(saved.forwardBundles) ? saved.forwardBundles : []) {
    const restored = restoreForwardBundle(value, { maxAgeMs: deferredInputTtlMs });
    if (restored) forwardBundles.set(String(restored.chatId), restored);
    else await removeFiles(forwardBundleAttachmentPaths(value));
  }

  const restoredDeferred = [
    ...[...pendingInputs.values()].map((item) => ({ collection: pendingInputs, item })),
    ...[...queuedInputs.values()].map((item) => ({ collection: queuedInputs, item })),
  ].sort((left, right) => (
    (Date.parse(left.item.createdAt ?? "") || 0) - (Date.parse(right.item.createdAt ?? "") || 0)
  ));
  const deferredCutoff = Date.now() - deferredInputTtlMs;
  for (let index = restoredDeferred.length - 1; index >= 0; index -= 1) {
    const entry = restoredDeferred[index];
    const createdAt = Date.parse(String(entry.item.createdAt ?? ""));
    if (!Number.isFinite(createdAt) || createdAt >= deferredCutoff) continue;
    entry.collection.delete(entry.item.id);
    restoredDeferred.splice(index, 1);
    await removeFiles(entry.item.temporaryFiles ?? []);
  }
  while (restoredDeferred.length > maximumDeferredInputs) {
    const oldest = restoredDeferred.shift();
    oldest.collection.delete(oldest.item.id);
    await removeFiles(oldest.item.temporaryFiles ?? []);
  }

  const restartRequest = saved.restartRequest && typeof saved.restartRequest === "object"
    && (String(saved.restartRequest.operationId ?? "").trim()
      || Number.isSafeInteger(saved.restartRequest.chatId))
    && (saved.restartRequest.messageId == null || Number.isSafeInteger(saved.restartRequest.messageId))
    ? {
        ...(String(saved.restartRequest.operationId ?? "").trim()
          ? { operationId: String(saved.restartRequest.operationId).trim() }
          : {}),
        chatId: Number.isSafeInteger(saved.restartRequest.chatId)
          ? saved.restartRequest.chatId
          : null,
        messageId: Number.isSafeInteger(saved.restartRequest.messageId)
          ? saved.restartRequest.messageId
          : null,
        requestedAt: String(saved.restartRequest.requestedAt ?? ""),
        waitingForRuns: saved.restartRequest.waitingForRuns === true,
        notifyTelegram: saved.restartRequest.notifyTelegram === true,
        minimumUpdateOffset: Number.isSafeInteger(saved.restartRequest.minimumUpdateOffset)
          ? saved.restartRequest.minimumUpdateOffset
          : 0,
      }
    : null;

  const savedRuns = Array.isArray(saved.activeRuns)
    ? saved.activeRuns
    : saved.activeRun && typeof saved.activeRun === "object"
      ? [saved.activeRun]
      : [];
  for (const savedRun of savedRuns) {
    const run = restoreTaskRun(savedRun, chatId);
    if (run) taskRuns.add(run);
  }

  return {
    chatId,
    updateOffset,
    restartRequest,
    clientTaskSelections: Array.isArray(saved.clientTaskSelections) ? saved.clientTaskSelections : [],
    codexHookReceipts,
    restoredTurnEndSnapshot,
  };
}

export function createHubRuntimeSnapshot(context) {
  const selection = context.selectionStore.serialize();
  return {
    chatId: context.chatId,
    clientTaskSelections: typeof context.getClientTaskSelections === "function"
      ? context.getClientTaskSelections()
      : [],
    activeProjectRoot: selection.activeProjectRoot,
    streamId: selection.streamId,
    activeThreadTitle: selection.activeThreadTitle,
    activeProvider: selection.activeProvider,
    threadIds: selection.threadIds,
    ...context.taskMetadata.snapshot(),
    ...context.preferences.snapshot(),
    updateOffset: context.updateOffset,
    activeRuns: context.taskRuns.values().map(context.serializableTaskRun),
    dismissedExternalTasks: context.dismissedExternalTasks.values(),
    cancelledManagedClaudeTasks: [...context.cancelledManagedClaudeTasks.entries()],
    pendingInputs: [...context.pendingInputs.values()],
    queuedInputs: [...context.queuedInputs.values()],
    deferredComposerTransfers: context.composerTransfers?.snapshot?.() ?? [],
    desktopMessageReceipts: context.desktopMessageReceipts.snapshot(),
    forwardBundles: [...context.forwardBundles.values()].map((bundle) => ({
      ...bundle,
      submitting: false,
    })),
    lastTaskMessages: context.runJournal.lastMessageSnapshot(),
    lastSeenTaskTurnIds: [...context.lastSeenTaskTurnIds.entries()].slice(-500),
    contextCompactions: context.contextCompactions.snapshot(),
    ...context.codexUsageTracker.snapshot(),
    codexTurnStarts: [...context.codexTurnStarts.entries()].slice(-500),
    codexHookReceipts: context.codexHookReceipts,
    codexTerminalAudit: context.codexTerminalAudit.snapshot(),
    turnEndNotifications: context.turnEndNotifications.snapshot(),
    statusMediaFileIds: [...context.statusMediaFileIds.entries()].slice(-50),
    restartRequest: context.restartRequest,
  };
}

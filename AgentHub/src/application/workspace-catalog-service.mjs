import { workspaceTaskPrefix } from "../domain/task-number.mjs";

function requiredStore(value) {
  if (!value || typeof value.hierarchy !== "function") {
    throw new TypeError("workspace catalog store is required");
  }
  return value;
}

export class WorkspaceCatalogService {
  #store;
  #pendingPermanentDeletions = new Map();

  constructor({
    store,
    taskBoard = null,
    blockingRunForWorkspace = () => null,
  } = {}) {
    this.#store = requiredStore(store);
    this.taskBoard = taskBoard;
    this.blockingRunForWorkspace = blockingRunForWorkspace;
  }

  hierarchy() {
    return this.#store.hierarchy();
  }

  createWorkspace({ name, comment = "", streamName = null, settings = {}, folderTarget } = {}) {
    if (settings?.catalogFolder && !folderTarget) throw new Error("Обновите каталог: для выбранной папки требуются точные identity/revision.");
    if (typeof this.#store.createWorkspaceWithStream === "function") {
      return this.#store.createWorkspaceWithStream({ name, comment, streamName, settings,
        ...(folderTarget ? { folderTarget } : {}) });
    }
    return this.#store.transaction(() => {
      const workspace = this.#store.createWorkspace({ name, comment, settings });
      const stream = this.#store.createStream({ workspaceId: workspace.id, name: streamName });
      return { workspace, stream };
    });
  }

  renameWorkspace({ workspaceId, name } = {}) {
    return this.#store.renameWorkspace(workspaceId, name);
  }

  async updateWorkspaceSettings({ workspaceId, settings = {} } = {}) {
    const workspace = await this.#store.updateWorkspaceSettings(workspaceId, settings);
    if (workspaceTaskPrefix(workspace.settings) && this.taskBoard?.assignWorkspaceTaskNumbers) {
      await this.taskBoard.assignWorkspaceTaskNumbers(workspaceId);
    }
    return workspace;
  }

  workspaceFolderCatalog() { return this.#store.workspaceFolderCatalog(); }
  previewWorkspaceFolderDeletion({ folderId } = {}) { return this.#store.previewWorkspaceFolderDeletion(folderId); }
  workspaceFolderCommand(input) { return this.#store.workspaceFolderCommand(input); }
  workspaceFolderCommandResult(input) { return this.#store.workspaceFolderCommandResult(input); }

  moveWorkspaceToFolder({ requestId, workspaceId, sourceFolderId, target, folderName } = {}) {
    if (folderName !== undefined || !requestId || sourceFolderId === undefined || target === undefined) {
      throw new Error("Обновите каталог: для перемещения требуются точные identity/revision папки и исходная команда.");
    }
    return this.workspaceFolderCommand({ requestId, action: "move", payload: { workspaceId, sourceFolderId, target } });
  }

  renameWorkspaceFolder({ requestId, folderId, expectedRevision, name } = {}) {
    if (!requestId || !folderId || !Number.isSafeInteger(expectedRevision)) {
      throw new Error("Обновите каталог: для переименования требуются точные identity/revision папки.");
    }
    return this.workspaceFolderCommand({ requestId, action: "rename", payload: { folderId, expectedRevision, name } });
  }

  archiveWorkspace({ workspaceId } = {}) {
    return this.#store.archiveWorkspace(workspaceId);
  }

  restoreWorkspace({ workspaceId } = {}) {
    return this.#store.restoreWorkspace(workspaceId);
  }

  permanentDeletionPending(workspaceId) {
    return (this.#pendingPermanentDeletions.get(String(workspaceId ?? "").trim()) ?? 0) > 0;
  }

  deleteArchivedWorkspace({ workspaceId, confirmationName } = {}) {
    const id = String(workspaceId ?? "").trim();
    if (this.blockingRunForWorkspace(id)) {
      const error = new Error("Сначала завершите активные ходы в этом Workspace");
      error.code = "WORKSPACE_LIFECYCLE_CONFLICT";
      error.statusCode = 409;
      throw error;
    }
    this.#pendingPermanentDeletions.set(id, (this.#pendingPermanentDeletions.get(id) ?? 0) + 1);
    const release = () => {
      const remaining = (this.#pendingPermanentDeletions.get(id) ?? 1) - 1;
      if (remaining > 0) this.#pendingPermanentDeletions.set(id, remaining);
      else this.#pendingPermanentDeletions.delete(id);
    };
    let result;
    try {
      result = this.#store.deleteArchivedWorkspace(workspaceId, confirmationName);
    } catch (error) {
      release();
      throw error;
    }
    if (typeof result?.then !== "function") {
      release();
      return result;
    }
    return Promise.resolve(result).finally(release);
  }

  archivedWorkspaces() {
    return this.#store.archivedWorkspaces();
  }

  workspaceDeveloperRules({ workspaceId } = {}) {
    return this.#store.workspaceDeveloperRules(workspaceId);
  }

  updateWorkspaceDeveloperRules({ workspaceId, content = "" } = {}) {
    return this.#store.updateWorkspaceDeveloperRules(workspaceId, content);
  }

  createWorkspaceFromStream({ streamId, name } = {}) {
    if (typeof this.#store.createWorkspaceFromStream === "function") {
      return this.#store.createWorkspaceFromStream({ streamId, name });
    }
    return this.#store.transaction(() => {
      const workspace = this.#store.createWorkspace({ name });
      const stream = this.#store.moveStream(streamId, workspace.id);
      return { workspace, stream };
    });
  }

  mergeWorkspaces({ sourceWorkspaceId, targetWorkspaceId } = {}) {
    return this.#store.mergeWorkspaces(sourceWorkspaceId, targetWorkspaceId);
  }

  createStream({ workspaceId, name = null, settings = {} } = {}) {
    const next = settings?.provider === "codex"
      ? { ...settings, model: settings.model || "gpt-5.6-terra",
        reasoning: settings.reasoning || "high" }
      : settings;
    return this.#store.createStream({ workspaceId, name, settings: next });
  }

  renameStream({ streamId, name = null } = {}) {
    return this.#store.renameStream(streamId, name);
  }

  archiveStream({ streamId } = {}) {
    return this.#store.archiveStream(streamId);
  }

  updateStreamSettings({ streamId, settings = {} } = {}) {
    return this.#store.updateStreamSettings(streamId, settings);
  }

  streamDeveloperRules({ streamId } = {}) {
    return this.#store.streamDeveloperRules(streamId);
  }

  updateStreamDeveloperRules({ streamId, content = "" } = {}) {
    return this.#store.updateStreamDeveloperRules(streamId, content);
  }

  moveStream({ streamId, workspaceId, beforeStreamId = undefined } = {}) {
    if (typeof this.#store.moveStreamOrdered === "function") {
      return this.#store.moveStreamOrdered({ streamId, workspaceId, beforeStreamId });
    }
    return this.#store.transaction(() => {
      const moved = this.#store.moveStream(streamId, workspaceId);
      return beforeStreamId === undefined ? moved : this.#store.reorderStream(streamId, beforeStreamId);
    });
  }

  bindThread({ streamId, provider, threadId, projectRoot = "", source = "rebirth" } = {}) {
    return this.#store.bindThread({ streamId, provider, threadId, projectRoot, source });
  }

  currentThread({ streamId } = {}) {
    return this.#store.activeThread(streamId);
  }

  resolveThread({ provider, threadId } = {}) {
    return this.#store.resolveThread({ provider, threadId });
  }

  developerRulesForThread({ provider, threadId } = {}) {
    return this.#store.developerRulesForThread({ provider, threadId });
  }

  developerRulesForStream({ streamId } = {}) {
    return this.#store.developerRulesForStream(streamId);
  }
}

import { workspaceTaskPrefix } from "../domain/task-number.mjs";

function requiredStore(value) {
  if (!value || typeof value.hierarchy !== "function") {
    throw new TypeError("workspace catalog store is required");
  }
  return value;
}

export class WorkspaceCatalogService {
  #store;

  constructor({ store, taskBoard = null, releasePlanner = null, releaseCompleter = null } = {}) {
    this.#store = requiredStore(store);
    this.taskBoard = taskBoard;
    this.releasePlanner = releasePlanner;
    this.releaseCompleter = releaseCompleter;
  }

  hierarchy() {
    return this.#store.hierarchy();
  }

  createWorkspace({ name, comment = "", streamName = null, settings = {} } = {}) {
    return this.#store.transaction(() => {
      const workspace = this.#store.createWorkspace({ name, comment, settings });
      const stream = this.#store.createStream({ workspaceId: workspace.id, name: streamName });
      return { workspace, stream };
    });
  }

  renameWorkspace({ workspaceId, name } = {}) {
    return this.#store.renameWorkspace(workspaceId, name);
  }

  updateWorkspaceSettings({ workspaceId, settings = {} } = {}) {
    const workspace = this.#store.updateWorkspaceSettings(workspaceId, settings);
    if (workspaceTaskPrefix(workspace.settings)) this.taskBoard?.assignWorkspaceTaskNumbers?.(workspaceId);
    return workspace;
  }

  renameWorkspaceFolder({ fromFolderName, toFolderName } = {}) {
    return this.#store.renameWorkspaceFolder(fromFolderName, toFolderName);
  }

  workspaceDeveloperRules({ workspaceId } = {}) {
    return this.#store.workspaceDeveloperRules(workspaceId);
  }

  updateWorkspaceDeveloperRules({ workspaceId, content = "" } = {}) {
    return this.#store.updateWorkspaceDeveloperRules(workspaceId, content);
  }

  releasePlan({ workspaceId } = {}) {
    if (typeof this.releasePlanner?.plan !== "function") throw new Error("Task release plan is unavailable");
    return this.releasePlanner.plan(workspaceId);
  }

  completeRelease(params = {}) {
    if (typeof this.releaseCompleter?.completeRelease !== "function") {
      throw new Error("Task release completion is unavailable");
    }
    return this.releaseCompleter.completeRelease(params);
  }

  createWorkspaceFromStream({ streamId, name } = {}) {
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
    return this.#store.createStream({ workspaceId, name, settings });
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
    return this.#store.transaction(() => {
      const moved = this.#store.moveStream(streamId, workspaceId);
      return beforeStreamId === undefined
        ? moved
        : this.#store.reorderStream(streamId, beforeStreamId);
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

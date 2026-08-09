function requiredStore(value) {
  if (!value || typeof value.hierarchy !== "function") {
    throw new TypeError("workspace catalog store is required");
  }
  return value;
}

export class WorkspaceCatalogService {
  #store;

  constructor({ store } = {}) {
    this.#store = requiredStore(store);
  }

  hierarchy() {
    return this.#store.hierarchy();
  }

  createWorkspace({ name, comment = "", streamName = null } = {}) {
    return this.#store.transaction(() => {
      const workspace = this.#store.createWorkspace({ name, comment });
      const stream = this.#store.createStream({ workspaceId: workspace.id, name: streamName });
      return { workspace, stream };
    });
  }

  renameWorkspace({ workspaceId, name } = {}) {
    return this.#store.renameWorkspace(workspaceId, name);
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

  updateStreamSettings({ streamId, settings = {} } = {}) {
    return this.#store.updateStreamSettings(streamId, settings);
  }

  moveStream({ streamId, workspaceId } = {}) {
    return this.#store.transaction(() => this.#store.moveStream(streamId, workspaceId));
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
}

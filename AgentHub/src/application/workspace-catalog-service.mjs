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

  updateWorkspaceSettings({ workspaceId, settings = {}, discardReleaseEntries = false } = {}) {
    return this.#store.updateWorkspaceSettings(workspaceId, settings, { discardReleaseEntries });
  }

  workspaceDeveloperRules({ workspaceId } = {}) {
    return this.#store.workspaceDeveloperRules(workspaceId);
  }

  updateWorkspaceDeveloperRules({ workspaceId, content = "" } = {}) {
    return this.#store.updateWorkspaceDeveloperRules(workspaceId, content);
  }

  releasePlan({ workspaceId } = {}) {
    return this.#store.releasePlan(workspaceId);
  }

  releaseRegistry({ workspaceId, limit } = {}) {
    return this.#store.releaseRegistry(workspaceId, { limit });
  }

  updateReleaseChangeStatus({ changeId, status } = {}) {
    return this.#store.updateReleaseChangeStatus(changeId, status);
  }

  updateReleaseChangeFiles({ changeId, files = [] } = {}) {
    return this.#store.updateReleaseChangeFiles(changeId, files);
  }

  completeRelease({ workspaceId, expectedPlanRevision, verificationEvidence, conflictsResolved = false } = {}) {
    return this.#store.completeRelease(workspaceId, {
      expectedPlanRevision, verificationEvidence, conflictsResolved,
    });
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

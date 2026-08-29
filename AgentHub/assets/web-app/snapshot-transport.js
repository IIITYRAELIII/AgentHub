(function snapshotTransportModule(global) {
  function receiptKey(item) {
    return [item?.provider, item?.threadId, item?.clientUserMessageId].join("\u0000");
  }

  const collectionKeys = Object.freeze({
    conversations: (item) => [item?.streamId, item?.provider, item?.threadId].join("\u0000"),
    workspaces: (item) => String(item?.id ?? ""),
    boardTasks: (item) => String(item?.id ?? ""),
    messageReceipts: receiptKey,
  });

  class SnapshotCollectionBaselineError extends Error {
    constructor(message) {
      super(message);
      this.name = "SnapshotCollectionBaselineError";
    }
  }

  function baselineError(message) {
    return new SnapshotCollectionBaselineError(message);
  }

  function applyCollection(previous, delta, keyOf, previousVersion) {
    if (Array.isArray(delta?.reset)) return delta.reset.slice();
    if (!Array.isArray(previous)) throw baselineError("Snapshot delta has no local baseline");
    if (String(delta?.baseVersion ?? "") !== String(previousVersion ?? "")) {
      throw baselineError("Snapshot delta does not match the local baseline");
    }
    if (!delta || (!Array.isArray(delta.upserts) && !Array.isArray(delta.removed))) {
      return previous;
    }
    const values = new Map(previous.map((item) => [keyOf(item), item]));
    for (const key of delta.removed ?? []) values.delete(String(key));
    for (const item of delta.upserts ?? []) values.set(keyOf(item), item);
    if (!Array.isArray(delta.order)) throw baselineError("Snapshot delta has no authoritative order");
    const order = delta.order.map(String);
    if (new Set(order).size !== order.length) {
      throw baselineError("Snapshot delta order contains duplicate keys");
    }
    return order.map((key) => {
      if (!values.has(key)) throw baselineError(`Snapshot delta order references missing key: ${key}`);
      return values.get(key);
    });
  }

  function materialize(previous, payload) {
    if (!payload || payload.notModified === true) return payload;
    const deltas = payload.collectionDeltas;
    if (Number(payload.apiVersion) < 4 || !deltas) return payload;
    const result = { ...payload };
    result.collectionVersions = { ...(previous?.collectionVersions ?? {}) };
    for (const [name, keyOf] of Object.entries(collectionKeys)) {
      const delta = deltas[name];
      const target = name === "conversations" ? "tasks" : name;
      result[target] = applyCollection(
        previous?.[target],
        delta,
        keyOf,
        previous?.collectionVersions?.[name],
      );
      if (delta?.version) result.collectionVersions[name] = String(delta.version);
    }
    delete result.conversations;
    delete result.collectionDeltas;
    return result;
  }

  function requestParams(snapshot) {
    const versions = snapshot?.collectionVersions ?? {};
    return {
      knownVersion: String(snapshot?.version ?? ""),
      compactSnapshot: true,
      snapshotProtocol: 4,
      conversationsVersion: String(versions.conversations ?? ""),
      workspacesVersion: String(versions.workspaces ?? ""),
      boardTasksVersion: String(versions.boardTasks ?? ""),
      messageReceiptsVersion: String(versions.messageReceipts ?? ""),
    };
  }

  function selectionFromSnapshotSettings(settings = {}, streamSettings = {}) {
    return {
      provider: settings.provider,
      model: settings.model,
      reasoning: settings.reasoning,
      mode: settings.mode,
      autoApprove: settings.approvalMode === "auto",
      includeClaudeUsage: settings.includeClaudeUsage !== false,
      activityRecentMinutes: settings.activityRecentMinutes,
      streamOrderMode: settings.streamOrderMode,
      streamCardWidthMode: settings.streamCardWidthMode,
      streamCardFixedWidth: settings.streamCardFixedWidth,
      streamCardGapEnabled: settings.streamCardGapEnabled,
      pinnedWorkspaceStreams: settings.pinnedWorkspaceStreams ?? {},
      quickMessages: settings.quickMessages ?? { global: [], streams: {}, workspaces: {} },
      ...(streamSettings ?? {}),
    };
  }

  global.AgentHubSnapshotTransport = Object.freeze({
    isBaselineError: (error) => error instanceof SnapshotCollectionBaselineError,
    materialize,
    requestParams,
    selectionFromSnapshotSettings,
  });
})(window);

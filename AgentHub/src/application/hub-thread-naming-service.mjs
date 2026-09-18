const normalized = (value) => String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, 80);

export function workspaceProviderThreadTitle(workspace, stream) {
  const workspaceName = normalized(workspace?.name);
  if (!workspaceName || !stream?.id) return "";
  const streamName = normalized(stream.name) || `Поток ${Math.max(1, Number(stream.ordinal) || 1)}`;
  const suffix = ` — ${streamName}`;
  return `${workspaceName.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`.slice(0, 80);
}

export function createHubThreadNamingService({
  workspaceCatalog, taskMetadata, sendRpc, saveTitles, saveState,
}) {
  function context(reference) {
    const binding = workspaceCatalog.thread(reference);
    const stream = binding ? workspaceCatalog.stream(binding.streamId) : null;
    const workspace = stream ? workspaceCatalog.workspace(stream.workspaceId) : null;
    return binding && stream && workspace ? { binding, stream, workspace } : null;
  }

  async function apply(reference, title, currentTitle = "", rpcOptions = {}) {
    reference = { provider: reference.provider, threadId: reference.threadId };
    const name = normalized(title);
    if (!name) throw new Error("Workspace and Stream are required to name a Hub Thread");
    if (taskMetadata.pinnedTitle(reference) !== name || normalized(currentTitle) !== name) {
      taskMetadata.pinTitle(reference, name);
      taskMetadata.expectTitle(reference, name);
      await saveTitles();
      await saveState();
    }
    if (reference.provider === "codex" && normalized(currentTitle) !== name) {
      await sendRpc("thread/name/set", { threadId: reference.threadId, name }, rpcOptions);
    }
    return name;
  }

  async function nameCreatedThread(reference) {
    const resolved = context(reference);
    if (!resolved) throw new Error("Created Hub Thread has no Workspace/Stream binding");
    return apply({ provider: reference.provider, threadId: reference.threadId },
      workspaceProviderThreadTitle(resolved.workspace, resolved.stream));
  }

  return { nameCreatedThread };
}

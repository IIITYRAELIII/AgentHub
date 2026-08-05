export function createRuntimeCommandRoutingComposition({
  pinnedTaskTitle,
  codexThreadResponseTitle,
  runTaskTitle,
  getTaskCatalog,
  getActiveProvider,
  getThreadId,
  getActiveThreadTitle,
  threadTitle,
  storedCodexThreadTitle,
  runtimeNotificationController,
  codexLifecycleController,
}) {
  function taskTitleFallback({
    provider,
    threadId: targetThreadId,
    run = null,
    thread = null,
  }) {
    const pinnedTitle = pinnedTaskTitle(provider, targetThreadId);
    if (pinnedTitle) return pinnedTitle;
    const currentThreadTitle = provider === "codex" ? codexThreadResponseTitle(thread) : "";
    if (currentThreadTitle) return currentThreadTitle;
    if (run) return runTaskTitle(run);
    const catalogTask = getTaskCatalog().find((task) => (
      task.provider === provider && task.threadId === targetThreadId
    ));
    if (catalogTask?.title) return catalogTask.title;
    if (getActiveProvider() === provider
      && getThreadId() === targetThreadId
      && getActiveThreadTitle()) {
      return getActiveThreadTitle();
    }
    if (thread) return threadTitle(thread);
    return `${provider === "codex" ? "Codex" : "Claude"} · ${targetThreadId.slice(0, 8)}`;
  }

  async function taskTitle(options) {
    const fallback = taskTitleFallback(options);
    return options.provider === "codex"
      ? storedCodexThreadTitle(options.threadId, fallback)
      : fallback;
  }

  async function authorize(request) {
    return codexLifecycleController.authorize(request);
  }

  async function reconcile(request) {
    return codexLifecycleController.reconcile(request);
  }

  async function handle(request) {
    if (runtimeNotificationController.supports(request.command)) {
      return runtimeNotificationController.handle(request);
    }
    if (codexLifecycleController.supports(request.command)) {
      return codexLifecycleController.handle(request);
    }
    throw new Error(`Unsupported runtime command: ${request.command}`);
  }

  return {
    taskTitle,
    authorize,
    reconcile,
    handle,
  };
}

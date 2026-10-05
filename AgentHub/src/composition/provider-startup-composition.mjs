import { pathInsideOrSame } from "../infrastructure/filesystem/config.mjs";
import { codexThreadSandboxSettings } from "../providers/codex/codex-sandbox.mjs";
import { reconcileCodexThreadSubscriptions } from "../providers/codex/codex-thread-subscriptions.mjs";

export function createProviderStartupComposition({
  config,
  threadListLimit,
  selectionStore,
  taskRuns,
  agentProviders,
  codexProviderTasks,
  getProvider,
  getProjectRoot,
  getThreadId,
  isCodex,
  startCodex,
  initializeCodex,
  sendRpc,
  refreshCodexModels = async () => {},
  refreshClaudeModels = async () => {},
  waitForModelRetry = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  resolveResumedCodexThreadTitle,
  applyCodexThreadSettings,
  saveState,
  logger = console,
}) {
  function isWorkspaceThread(thread) {
    if (!thread.cwd) return false;
    return pathInsideOrSame(thread.cwd, getProjectRoot());
  }

  function threadTitle(thread) {
    const title = thread.name?.trim() || thread.preview?.trim() || "Без названия";
    return title.replace(/\s+/g, " ").slice(0, 60);
  }

  async function createThread() {
    return agentProviders.call(getProvider(), "createTask");
  }

  async function initializeProvider() {
    // Claude discovery remains available even when Codex startup fails.
    void Promise.resolve().then(refreshClaudeModels)
      .catch((error) => logger.warn?.("Cannot refresh Claude models:", error.message));
    const startAt = performance.now();
    await startCodex();
    const initializedAt = performance.now();
    await initializeCodex({ attachSelectedThread: false });
    try {
      logger.info?.("Codex model catalog startup readiness", {
        transportStartMs: Math.round(initializedAt - startAt),
        initializeMs: Math.round(performance.now() - initializedAt),
      });
    } catch {
      // Diagnostics must not affect provider startup.
    }
    // Discovery is best effort and must not delay Hub readiness or run recovery.
    void Promise.resolve().then(async () => {
      if (await refreshCodexModels({ source: "startup" }) !== false) return;
      for (const [index, delayMs] of [10_000, 30_000].entries()) {
        await waitForModelRetry(delayMs);
        if (await refreshCodexModels({ source: `startup-retry-${index + 1}` }) !== false) return;
      }
    })
      .catch((error) => logger.warn?.("Cannot refresh Codex models:", error.message));
    if (config.telegramEnabled && config.createInitialThreadOnStartup !== false && !getThreadId()) {
      await createThread();
    }
  }

  async function attachCodexThread() {
    const threadId = getThreadId();
    if (threadId) {
      try {
        const result = await sendRpc("thread/resume", {
          threadId,
          ...codexThreadSandboxSettings(config.codexSandboxMode),
        });
        if (!isWorkspaceThread(result.thread ?? {})) {
          throw new Error("saved thread belongs to another project");
        }
        selectionStore.setTitle(await resolveResumedCodexThreadTitle(threadId, result.thread));
        applyCodexThreadSettings(threadId, result);
        await saveState();
        void reconcileCodexThreadSubscriptions({
          sendRpc,
          selectedThreadId: threadId,
          activeRuns: taskRuns.values(),
        }).catch((error) => logger.warn?.("Cannot reconcile Codex thread subscriptions:", error.message));
        return true;
      } catch (error) {
        logger.error("Cannot resume saved thread:", error.message);
        const savedActiveRun = taskRuns.forTask({
          provider: "codex",
          projectRoot: getProjectRoot(),
          threadId,
        });
        if (savedActiveRun) {
          logger.error(`Keeping active task ${threadId}; recovery will inspect its saved turn.`);
          return false;
        }
        selectionStore.setThread(null, { provider: "codex" });
      }
    }
    await createThread();
    return true;
  }

  async function listThreads() {
    if (!isCodex()) {
      const threadId = getThreadId();
      return threadId ? [{
        id: threadId,
        cwd: getProjectRoot(),
        name: "Текущая сессия Claude",
        updatedAt: Math.floor(Date.now() / 1000),
      }] : [];
    }
    return (await codexProviderTasks.discoverTasks())
      .filter(isWorkspaceThread)
      .slice(0, threadListLimit);
  }

  return {
    initializeProvider,
    attachCodexThread,
    createThread,
    listThreads,
    isWorkspaceThread,
    threadTitle,
  };
}

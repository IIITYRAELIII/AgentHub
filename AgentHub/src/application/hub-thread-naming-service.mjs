export { workspaceProviderThreadTitle } from "../domain/workspace-stream-identity.mjs";
import { workspaceProviderThreadTitle, normalizedThreadIdentity } from "../domain/workspace-stream-identity.mjs";

export function createHubThreadNamingService({
  workspaceCatalog, taskMetadata, sendRpc, saveTitles, saveState,
}) {
  const inFlight = new Map();

  function assertCurrentIntent(reference, intent, status = "pending") {
    const binding = workspaceCatalog.thread(reference);
    const current = workspaceCatalog.threadNaming(reference);
    if (!binding || !current || current.status !== status
      || binding.streamId !== intent.streamId || binding.position !== intent.position
      || current.streamId !== intent.streamId || current.position !== intent.position
      || current.title !== intent.title) {
      const error = new Error("Hub Thread naming authority was superseded");
      error.code = "HUB_THREAD_NAMING_SUPERSEDED";
      error.thread = { ...reference };
      throw error;
    }
  }

  async function apply(reference, intent, observedThread) {
    const name = intent.title;
    try {
      assertCurrentIntent(reference, intent);
      if (reference.provider === "codex") {
        let writeError;
        let observed = observedThread;
        if (!observed && intent.recovering) {
          observed = (await sendRpc("thread/read", { threadId: reference.threadId, includeTurns: false })).thread;
        }
        // Synchronous catalog reads and the next dispatch have no local await gap.
        // Never hold a SQLite transaction across a provider RPC.
        assertCurrentIntent(reference, intent);
        if (observed && observed.id !== reference.threadId) throw new Error("Provider Thread identity mismatch");
        if (observed?.id !== reference.threadId || observed?.name !== name) {
          try { await sendRpc("thread/name/set", { threadId: reference.threadId, name }); }
          catch (error) { writeError = error; }
          assertCurrentIntent(reference, intent);
        }
        let confirmed;
        try {
          confirmed = (await sendRpc("thread/read", { threadId: reference.threadId, includeTurns: false })).thread;
        } catch (error) { throw writeError ?? error; }
        assertCurrentIntent(reference, intent);
        if (confirmed?.id !== reference.threadId || confirmed.name !== name) {
          throw writeError ?? new Error("Provider Thread name is not confirmed");
        }
      }
      assertCurrentIntent(reference, intent);
      taskMetadata.pinTitle(reference, name);
      taskMetadata.expectTitle(reference, name);
      await saveTitles();
      assertCurrentIntent(reference, intent);
      await saveState();
      assertCurrentIntent(reference, intent);
      await workspaceCatalog.completeThreadNaming(reference, name);
      assertCurrentIntent(reference, intent, "complete");
      return name;
    } catch (cause) {
      if (cause.code === "HUB_THREAD_NAMING_SUPERSEDED") throw cause;
      assertCurrentIntent(reference, intent);
      const error = new Error(`Hub Thread naming remains pending: ${cause.message}`, { cause });
      error.code = "HUB_THREAD_NAMING_PENDING";
      error.thread = { ...reference };
      throw error;
    }
  }

  async function name(reference, { recovery = false, observedThread } = {}) {
    reference = { provider: reference.provider, threadId: reference.threadId };
    const binding = workspaceCatalog.thread(reference);
    const intent = workspaceCatalog.threadNaming(reference);
    if (!binding || !intent) {
      if (recovery) return null;
      throw new Error("Created Hub Thread has no durable naming intent");
    }
    if (intent.streamId !== binding.streamId || intent.position !== binding.position
      || intent.status === "superseded") return null;
    if (intent.status === "complete") return recovery ? null : intent.title;
    const key = JSON.stringify(reference);
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = apply(reference, { ...intent, recovering: recovery }, observedThread);
    inFlight.set(key, pending);
    try { return await pending; } finally { inFlight.delete(key); }
  }

  return {
    previewThreadNaming: (references) => {
      if (!Array.isArray(references) || references.length > 20) throw new Error("Naming preview is limited to 20 exact Threads");
      return references.map((value) => {
        const reference = normalizedThreadIdentity(value);
        const binding = workspaceCatalog.thread(reference);
        if (!binding) throw new Error("Preview Thread has no catalog binding");
        const stream = workspaceCatalog.stream(binding.streamId);
        const workspace = stream && workspaceCatalog.workspace(stream.workspaceId);
        const title = workspaceProviderThreadTitle(workspace, stream, binding.position);
        return { ...reference, streamId: stream.id, position: binding.position, title,
          numberAuthority: "confirmed-catalog-position; unknown prior history not recovered",
          nativeTitle: null, nativeTitleVerified: false,
          providerRename: reference.provider === "codex" ? "supported" : "unsupported",
          command: { name: "task.rename", params: { ...reference, streamId: stream.id, title } },
          requiresApproval: true };
      });
    },
    nameCreatedThread: (reference) => name(reference, { recovery: reference.recovering === true }),
    recoverThreadNaming: (reference, observedThread) => name(reference, { recovery: true, observedThread }),
  };
}

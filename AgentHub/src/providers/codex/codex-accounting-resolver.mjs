import { resolveCodexAccountingThread } from "./codex-subagent-accounting.mjs";

export class CodexAccountingResolver {
  #d;
  #roots = new Map();

  constructor(dependencies) {
    this.#d = dependencies;
  }

  async accountingThread(thread) {
    const targetThreadId = String(thread?.id ?? "").trim();
    const cached = this.#roots.get(targetThreadId);
    if (cached) return cached;
    const d = this.#d;
    const resolved = await resolveCodexAccountingThread(thread, {
      readThread: async (parentThreadId) => {
        try {
          const response = await d.readThread(parentThreadId);
          if (response?.thread?.id) return response.thread;
        } catch {
          // Archived threads may no longer be readable through the App Server.
        }
        const transcriptPath = await d.findRollout(parentThreadId);
        if (!transcriptPath) return null;
        return d.readRolloutSession(transcriptPath);
      },
    });
    if (resolved.isSubagent) this.#remember(targetThreadId, resolved);
    return resolved;
  }

  async subagentParentTurnId(thread, accountingThread) {
    const childThreadId = String(thread?.id ?? "").trim();
    const parentThreadId = String(accountingThread?.parentThreadId ?? "").trim();
    if (!childThreadId || !parentThreadId) return "";
    const d = this.#d;
    const transcriptPath = await d.findRollout(parentThreadId);
    if (!transcriptPath) return "";
    const recent = await d.readSubagentSpawn(transcriptPath, childThreadId).catch(() => null);
    if (recent?.parentTurnId) return recent.parentTurnId;
    const historical = await d.scanHistoricalRollout(transcriptPath).catch(() => null);
    for (const turn of historical?.turns ?? []) {
      if ((turn.spawnedSubagents ?? []).some((spawned) => spawned.threadId === childThreadId)) {
        return String(turn.turnId ?? "").trim();
      }
    }
    return "";
  }

  #remember(key, value) {
    if (this.#roots.has(key)) this.#roots.delete(key);
    this.#roots.set(key, value);
    while (this.#roots.size > 2_000) this.#roots.delete(this.#roots.keys().next().value);
  }
}

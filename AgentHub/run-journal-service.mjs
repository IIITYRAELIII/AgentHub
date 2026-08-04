import { stat } from "node:fs/promises";

import { taskRunKey } from "./task-runs.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";

export class RunJournalService {
  constructor({
    usageStore,
    findProject,
    defaultProjectRoot,
    projectionProjectRoots,
    legacyLedgerFile,
    legacyWorkLogFile,
    messageLimit = 500,
    now = () => new Date(),
    statImpl = stat,
    logger = console,
  }) {
    this.usageStore = usageStore;
    this.findProject = findProject;
    this.defaultProjectRoot = defaultProjectRoot;
    this.projectionProjectRoots = projectionProjectRoots;
    this.legacyLedgerFile = legacyLedgerFile;
    this.legacyWorkLogFile = legacyWorkLogFile;
    this.messageLimit = messageLimit;
    this.now = now;
    this.statImpl = statImpl;
    this.logger = logger;
    this.lastTaskMessages = new Map();
  }

  rememberLastMessage(run, text) {
    const value = String(text ?? "").trim();
    if (!run?.threadId || !value) return false;
    const key = taskRunKey(run);
    this.lastTaskMessages.delete(key);
    this.lastTaskMessages.set(key, {
      text: value,
      updatedAt: this.now().toISOString(),
      turnId: String(run.turnId ?? "").trim() || null,
    });
    while (this.lastTaskMessages.size > this.messageLimit) {
      this.lastTaskMessages.delete(this.lastTaskMessages.keys().next().value);
    }
    return true;
  }

  lastMessage(task) {
    return this.lastMessageRecord(task)?.text ?? "";
  }

  lastMessageRecord(task) {
    return this.lastTaskMessages.get(taskRunKey(task)) ?? null;
  }

  restoreLastMessages(entries) {
    if (!Array.isArray(entries)) return 0;
    let restored = 0;
    for (const entry of entries.slice(-this.messageLimit)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1]?.text !== "string") {
        continue;
      }
      this.lastTaskMessages.set(entry[0], { ...entry[1] });
      restored += 1;
    }
    return restored;
  }

  lastMessageSnapshot() {
    return [...this.lastTaskMessages.entries()].slice(-this.messageLimit);
  }

  async projectTurn(completion, { title = "", body = "" } = {}) {
    const workLogId = completion?.message?.workLogId;
    const project = this.findProject(completion.projectRoot);
    if (!project) throw new Error(`Cannot find journal project for ${completion.projectRoot}`);
    const fields = {
      provider: completion.provider,
      threadId: completion.threadId,
      turnId: completion.turnId,
      usage: completion.usage,
      usageReported: completion.usageReported,
      estimatedCredits: completion.estimatedCredits,
      estimateKind: completion.estimateKind,
      model: completion.model,
      serviceTier: completion.serviceTier,
      taskThreadId: completion.taskThreadId,
      parentThreadId: completion.parentThreadId,
      parentTurnId: completion.parentTurnId,
      aggregateOnly: completion.aggregateOnly,
      provisional: completion.provisional,
      taskTitle: completion.taskTitle,
      title: title || (body ? conciseTurnTitle(body, completion.status) : ""),
      body,
      prompt: completion.prompt,
      changedFiles: completion.changedFiles,
      diff: completion.diff,
      skillsUsed: completion.skillsUsed,
      mcpCalls: completion.mcpCalls,
      toolMetricsKnown: completion.toolMetricsKnown,
      startedAt: completion.startedAt,
      completedAt: completion.completedAt,
      status: completion.status,
      projectRoot: project.path,
      projectionProjectRoots: this.projectionProjectRoots,
    };
    if (!workLogId) return this.usageStore.recordAutomaticAndProject(fields);
    return this.usageStore.recordAndProject({ ...fields, workLogId });
  }

  async initialize(restoredTurnEndSnapshot = {}) {
    const restoredTurnMessages = [
      ...(Array.isArray(restoredTurnEndSnapshot.pending) ? restoredTurnEndSnapshot.pending : []),
      ...(Array.isArray(restoredTurnEndSnapshot.completions)
        ? restoredTurnEndSnapshot.completions.map((completion) => completion?.message)
        : []),
    ].filter(Boolean);
    await this.usageStore.mergeTurnTexts(restoredTurnMessages).catch((error) => {
      this.logger.error("Cannot restore journal turn texts:", error.message);
    });
    let projectionReady = false;
    try {
      await this.usageStore.project(null, {
        projectRoot: this.defaultProjectRoot,
        projectionProjectRoots: this.projectionProjectRoots,
      });
      projectionReady = true;
    } catch (error) {
      this.logger.error("Cannot refresh global journal usage:", error.message);
    }
    if (!projectionReady || !await this.statImpl(this.legacyLedgerFile).then(() => true).catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    })) return null;
    const retirement = await this.usageStore.retireLegacyStorage({
      workLogFile: this.legacyWorkLogFile,
    });
    this.logger.log(
      `Retired ${retirement.removed.length} legacy journal file(s) after verified SQLite cutover`,
    );
    return retirement;
  }
}

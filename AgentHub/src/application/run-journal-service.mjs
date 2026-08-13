import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { taskRunKey } from "../domain/task-runs.mjs";
import { displayUserPrompt } from "./task-history.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";

function normalizedIsoTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function journalPrompt(completion) {
  const prompts = Array.isArray(completion?.prompts) && completion.prompts.length
    ? completion.prompts
    : [completion?.prompt];
  return prompts
    .map((prompt) => displayUserPrompt(prompt))
    .map((prompt) => String(prompt ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export class RunJournalService {
  constructor({
    usageStore,
    workspaceCatalogStore = null,
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
    this.workspaceCatalogStore = workspaceCatalogStore;
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

  rememberLastMessage(run, text, { updatedAt = null } = {}) {
    const value = String(text ?? "").trim();
    if (!run?.threadId || !value) return false;
    const key = taskRunKey(run);
    const current = this.lastTaskMessages.get(key) ?? null;
    const turnId = String(run.turnId ?? "").trim() || null;
    const authoritativeUpdatedAt = normalizedIsoTimestamp(updatedAt);
    const sameTurn = Boolean(turnId) && current?.turnId === turnId;
    if (
      current
      && !sameTurn
      && authoritativeUpdatedAt
      && Date.parse(authoritativeUpdatedAt) < Date.parse(String(current.updatedAt ?? ""))
    ) return false;
    this.lastTaskMessages.delete(key);
    this.lastTaskMessages.set(key, {
      text: value,
      provider: String(run.provider ?? "").trim() || null,
      threadId: String(run.threadId ?? "").trim(),
      updatedAt: authoritativeUpdatedAt
        || (sameTurn ? current.updatedAt : null)
        || this.now().toISOString(),
      turnId,
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
      prompt: journalPrompt(completion),
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
    const result = !workLogId
      ? await this.usageStore.recordAutomaticAndProject(fields)
      : await this.usageStore.recordAndProject({ ...fields, workLogId });
    if (Array.isArray(completion.changedFiles) && completion.changedFiles.length) {
      try {
        this.workspaceCatalogStore?.recordReleaseChange?.({
          provider: completion.provider,
          threadId: completion.threadId,
          turnId: completion.turnId,
          projectRoot: project.path,
          summary: fields.title || body,
          changedFiles: completion.changedFiles,
          status: String(completion.status ?? "").trim().toLowerCase() === "completed"
            ? "ready"
            : "blocked",
          diffHash: completion.diff
            ? createHash("sha256").update(String(completion.diff)).digest("hex")
            : "",
        });
      } catch (error) {
        this.logger.error(`Cannot register release change for ${completion.turnId}:`, error.message);
      }
    }
    try {
      const resolved = this.workspaceCatalogStore?.resolveThread?.({
        provider: completion.provider,
        threadId: completion.threadId,
      });
      if (resolved) {
        this.workspaceCatalogStore.recordWorkspaceEvent?.({
          workspaceId: resolved.workspaceId,
          streamId: resolved.streamId,
          type: "run.completed",
          subjectId: completion.turnId,
          dedupeKey: `run.completed:${createHash("sha256").update([
            completion.provider, completion.threadId, completion.turnId,
          ].join("\0")).digest("hex")}`,
          payload: {
            provider: completion.provider,
            threadId: completion.threadId,
            turnId: completion.turnId,
            status: completion.status,
            title: fields.title,
          },
        });
      }
    } catch (error) {
      this.logger.error(`Cannot record Workspace event for ${completion.turnId}:`, error.message);
    }
    return result;
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

import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import { legacyTaskRunKeys, taskRunKey } from "../domain/task-runs.mjs";
import { isCodexContextProbeTurn } from "../domain/codex-context-probe.mjs";
import { normalizeInterstreamClientUserMessageId } from "../domain/interstream-message.mjs";
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

function lastMessageMatchesTask(record, task) {
  const threadId = String(task?.threadId ?? "").trim();
  const recordThreadId = String(record?.threadId ?? "").trim();
  if (threadId && recordThreadId !== threadId) return false;
  const provider = String(task?.provider ?? "").trim().toLowerCase();
  const recordProvider = String(record?.provider ?? "").trim().toLowerCase();
  return !provider || !recordProvider || provider === recordProvider;
}

function lastMessageTimestamp(record) {
  return Date.parse(String(record?.updatedAt ?? "")) || 0;
}

export class RunJournalService {
  #revision = 0;

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

  rememberLastMessage(run, text, { updatedAt = null, terminalRevision = null } = {}) {
    const value = String(text ?? "").trim();
    if (!run?.threadId || !value) return false;
    if (String(run.provider ?? "").trim().toLowerCase() === "codex"
      && isCodexContextProbeTurn({ ...run, finalAnswer: value })) return false;
    const key = taskRunKey(run);
    const current = this.lastMessageRecord(run);
    const turnId = String(run.turnId ?? "").trim() || null;
    const authoritativeUpdatedAt = normalizedIsoTimestamp(updatedAt);
    const startedAt = normalizedIsoTimestamp(run.startedAt);
    const sameTurn = Boolean(turnId) && current?.turnId === turnId;
    const currentStartedAt = normalizedIsoTimestamp(current?.startedAt);
    if (
      current
      && !sameTurn
      && (
        (startedAt && currentStartedAt && Date.parse(startedAt) < Date.parse(currentStartedAt))
        || (
          authoritativeUpdatedAt
          && Date.parse(authoritativeUpdatedAt) < Date.parse(String(current.updatedAt ?? ""))
        )
      )
    ) return false;
    const next = {
      text: value,
      provider: String(run.provider ?? "").trim() || null,
      threadId: String(run.threadId ?? "").trim(),
      updatedAt: authoritativeUpdatedAt
        || (sameTurn ? current.updatedAt : null)
        || this.now().toISOString(),
      startedAt: startedAt || (sameTurn ? current.startedAt : null) || null,
      turnId,
      terminalRevision: Number(terminalRevision) || (sameTurn ? current?.terminalRevision : null) || null,
      operationKind: String(run.operationKind ?? "").trim()
        || (run.contextProbe === true ? "probe" : "user-turn"),
      contextProbe: run.contextProbe === true,
      clientUserMessageId: normalizeInterstreamClientUserMessageId(run.clientUserMessageId),
    };
    if (
      current
      && current.text === next.text
      && current.provider === next.provider
      && current.threadId === next.threadId
      && current.updatedAt === next.updatedAt
      && current.startedAt === next.startedAt
      && current.turnId === next.turnId
      && current.terminalRevision === next.terminalRevision
      && current.operationKind === next.operationKind
      && current.contextProbe === next.contextProbe
      && current.clientUserMessageId === next.clientUserMessageId
    ) return false;
    this.lastTaskMessages.delete(key);
    this.lastTaskMessages.set(key, next);
    while (this.lastTaskMessages.size > this.messageLimit) {
      this.lastTaskMessages.delete(this.lastTaskMessages.keys().next().value);
    }
    this.#revision += 1;
    return true;
  }

  get revision() {
    return this.#revision;
  }

  lastMessage(task) {
    return this.lastMessageRecord(task)?.text ?? "";
  }

  lastMessageRecord(task) {
    const key = taskRunKey(task);
    const exact = this.lastTaskMessages.get(key) ?? null;
    if (exact) return exact;
    const legacyMatches = legacyTaskRunKeys(task)
      .map((legacyKey) => [legacyKey, this.lastTaskMessages.get(legacyKey) ?? null])
      .filter(([, record]) => record && lastMessageMatchesTask(record, task));
    if (!legacyMatches.length) return null;
    const [, migrated] = legacyMatches.reduce((latest, candidate) => (
      lastMessageTimestamp(candidate[1]) > lastMessageTimestamp(latest[1]) ? candidate : latest
    ));
    for (const [legacyKey] of legacyMatches) this.lastTaskMessages.delete(legacyKey);
    this.lastTaskMessages.set(key, migrated);
    this.#revision += 1;
    return migrated;
  }

  restoreLastMessages(entries) {
    if (!Array.isArray(entries)) return 0;
    let restored = 0;
    for (const entry of entries.slice(-this.messageLimit)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1]?.text !== "string") {
        continue;
      }
      if (String(entry[1].provider ?? "").trim().toLowerCase() === "codex"
        && isCodexContextProbeTurn({ ...entry[1], finalAnswer: entry[1].text })) continue;
      this.lastTaskMessages.set(entry[0], { ...entry[1] });
      restored += 1;
    }
    if (restored) this.#revision += 1;
    return restored;
  }

  lastMessageSnapshot() {
    return [...this.lastTaskMessages.entries()].slice(-this.messageLimit);
  }

  async projectTurn(completion, { title = "", body = "", deferProjection = false } = {}) {
    const workLogId = completion?.message?.workLogId;
    const project = this.findProject(completion.projectRoot);
    if (!project) throw new Error(`Cannot find journal project for ${completion.projectRoot}`);
    const fields = {
      provider: completion.provider,
      threadId: completion.threadId,
      turnId: completion.turnId,
      runId: completion.runId,
      terminalRevision: completion.terminalRevision,
      usage: completion.usage,
      usageReported: completion.usageReported,
      estimatedCredits: completion.estimatedCredits,
      estimateKind: completion.estimateKind,
      imageGenerationCount: completion.imageGenerationCount,
      contextProbe: completion.contextProbe,
      limitSamples: completion.limitSamples,
      resolveAccount: completion.resolveAccount,
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
      clientUserMessageId: completion.clientUserMessageId,
      messageOrigin: completion.messageOrigin,
      changedFiles: completion.changedFiles,
      diff: completion.diff,
      skillsUsed: completion.skillsUsed,
      mcpCalls: completion.mcpCalls,
      toolMetricsKnown: completion.toolMetricsKnown,
      startedAt: completion.startedAt,
      completedAt: completion.completedAt,
      status: completion.status,
      deferProjection,
      projectRoot: project.path,
      projectionProjectRoots: this.projectionProjectRoots,
    };
    const result = !workLogId
      ? await this.usageStore.recordAutomaticAndProject(fields)
      : await this.usageStore.recordAndProject({ ...fields, workLogId });
    try {
      const resolved = this.workspaceCatalogStore?.resolveThread?.({
        provider: completion.provider,
        threadId: completion.threadId,
      });
      if (resolved) {
        await this.workspaceCatalogStore.recordWorkspaceEvent?.({
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

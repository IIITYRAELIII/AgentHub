import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { legacyTaskRunKeys, taskRunKey } from "../domain/task-runs.mjs";
import { isCodexContextProbeResponseText } from "../domain/codex-context-probe.mjs";
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

function changedFileOperations(diff) {
  const operations = new Map();
  let current = null;
  for (const line of String(diff ?? "").split(/\r?\n/u)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (header) {
      current = header[2];
      operations.set(current, "modified");
    } else if (current && line.startsWith("new file mode ")) {
      operations.set(current, "added");
    } else if (current && line.startsWith("deleted file mode ")) {
      operations.set(current, "deleted");
    }
  }
  return operations;
}

function repositorySnapshots(snapshot) {
  if (Array.isArray(snapshot?.repositories)) return snapshot.repositories;
  return snapshot?.repoRoot ? [snapshot] : [];
}

function pathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function exactTaskChangedFiles({ projectRoot, files, operations, turnId, baseline }) {
  const repositories = repositorySnapshots(baseline)
    .map((repository) => path.resolve(repository.repoRoot))
    .sort((left, right) => right.length - left.length);
  if (!repositories.length) throw new Error("terminal Task evidence requires a captured Git baseline");
  return files.map((file) => {
    const reported = String(file ?? "").replaceAll("\\", "/");
    const absolute = path.isAbsolute(reported) ? path.resolve(reported) : path.resolve(projectRoot, reported);
    const repositoryRoot = repositories.find((root) => pathInside(root, absolute));
    if (!repositoryRoot) throw new Error(`changed file is outside the captured Task repositories: ${reported}`);
    const relativePath = path.relative(repositoryRoot, absolute).replaceAll(path.sep, "/");
    return {
      projectRoot: repositoryRoot,
      path: relativePath,
      operation: operations.get(reported) ?? operations.get(relativePath) ?? "modified",
      turnId,
    };
  });
}

export class RunJournalService {
  #revision = 0;

  constructor({
    usageStore,
    workspaceCatalogStore = null,
    taskBoard = null,
    taskReleaseService = null,
    captureResultSnapshot = null,
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
    this.taskBoard = taskBoard;
    this.taskReleaseService = taskReleaseService;
    this.captureResultSnapshot = typeof captureResultSnapshot === "function" ? captureResultSnapshot : null;
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
    if (isCodexContextProbeResponseText(value)) return false;
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
      if (isCodexContextProbeResponseText(entry[1].text)) continue;
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
      terminalRevision: completion.terminalRevision,
      usage: completion.usage,
      usageReported: completion.usageReported,
      estimatedCredits: completion.estimatedCredits,
      estimateKind: completion.estimateKind,
      imageGenerationCount: completion.imageGenerationCount,
      contextProbe: completion.contextProbe,
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
    const releaseWorkflowEnabled = this.workspaceCatalogStore?.releaseWorkflowEnabledForThread?.({
      provider: completion.provider,
      threadId: completion.threadId,
    }) === true;
    if (releaseWorkflowEnabled && Array.isArray(completion.changedFiles) && completion.changedFiles.length) {
      try {
        const bound = this.taskBoard?.claimedTaskForTurn?.({
          provider: completion.provider,
          threadId: completion.threadId,
          turnId: completion.turnId,
        });
        const dashboardTaskId = String(completion.dashboardTaskId ?? "").trim() || null;
        const taskId = bound?.id ?? null;
        if (dashboardTaskId && bound && bound.id !== dashboardTaskId) {
          throw new Error("dashboardTaskId conflicts with the exact provider turn binding");
        }
        if (taskId) {
          const operations = changedFileOperations(completion.diff);
          const changedFiles = exactTaskChangedFiles({
            projectRoot: project.path,
            files: completion.changedFiles,
            operations,
            turnId: completion.turnId,
            baseline: bound.gitBaseline,
          });
          const resultSnapshot = this.captureResultSnapshot
            ? await this.captureResultSnapshot(project.path, completion.turnId)
            : null;
          this.taskBoard.recordTaskTurn({
            taskId,
            provider: completion.provider,
            threadId: completion.threadId,
            turnId: completion.turnId,
            projectRoot: project.path,
            summary: fields.title || body,
            status: completion.status,
            changedFiles,
            resultSnapshot,
          });
          if (bound?.requestedWorkflowStatus === "awaiting_implementation"
            && String(completion.status ?? "").trim().toLowerCase() === "completed") {
            await this.taskReleaseService?.freezeRecorded?.({
              taskId,
              workspaceId: bound.workspaceId,
              actorStreamId: bound.streamId,
            });
          }
        }
      } catch (error) {
        this.logger.error(`Cannot append exact Task release evidence for ${completion.turnId}:`, error.message);
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

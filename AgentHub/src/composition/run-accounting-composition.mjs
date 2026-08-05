import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  claudeResultEstimatedCredits,
  claudeResultTokenUsage,
  scanClaudeHistoricalTranscriptFile,
} from "../providers/claude/claude-work-log.mjs";
import { conciseTurnTitle } from "../application/turn-title.mjs";
import { readClaudeSessionSnapshot } from "../../last-message.mjs";

export function createRunAccountingComposition({
  runJournal,
  refreshTaskDiff,
  runTaskTitle,
  logger = console,
}) {
  function applyCodexRolloutContext(run, usageResult) {
    if (!run || !usageResult) return;
    if (usageResult.startedAt) run.startedAt = usageResult.startedAt;
    if (usageResult.model) run.modelId = usageResult.model;
    if (usageResult.serviceTier) run.serviceTier = usageResult.serviceTier;
    if (usageResult.prompt) run.promptPreview = String(usageResult.prompt);
    if (usageResult.toolMetricsKnown === true) {
      run.skillsUsed = [...new Set(usageResult.skillsUsed ?? [])];
      run.mcpCalls = Array.isArray(usageResult.mcpCalls) ? usageResult.mcpCalls : [];
      run.toolMetricsKnown = true;
    }
    const changedFiles = [];
    for (const file of Array.isArray(usageResult.changedFiles) ? usageResult.changedFiles : []) {
      const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(run.projectRoot, file);
      const relative = path.relative(run.projectRoot, absolute);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      changedFiles.push(relative.replaceAll(path.sep, "/"));
    }
    if (changedFiles.length) run.rolloutChangedFiles = [...new Set(changedFiles)];
  }

  function changedFilesForRun(run) {
    const diff = String(run?.latestDiff ?? "");
    const repoRoot = String(
      run?.gitBaseline?.projectRoot ?? run?.gitBaseline?.repoRoot ?? "",
    ).trim();
    if (!diff || !repoRoot) return [];
    const files = new Set(Array.isArray(run?.rolloutChangedFiles) ? run.rolloutChangedFiles : []);
    for (const match of diff.matchAll(/^(?:\+\+\+|---) (.+)$/gm)) {
      const token = match[1].trim();
      let gitPath = token;
      if (token.startsWith('"')) {
        try {
          gitPath = JSON.parse(token);
        } catch {
          continue;
        }
      }
      if (!gitPath || gitPath === "/dev/null" || !/^[ab]\//u.test(gitPath)) continue;
      const absolute = path.resolve(repoRoot, gitPath.slice(2).replaceAll("/", path.sep));
      const relative = path.relative(run.projectRoot, absolute);
      if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      files.add(relative.replaceAll(path.sep, "/"));
    }
    return [...files].sort((left, right) => left.localeCompare(right));
  }

  async function projectTurnUsageToWorkLog(completion, { title = "", body = "" } = {}) {
    return runJournal.projectTurn(completion, { title, body });
  }

  async function projectClaudeRunToWorkLog(run, {
    answer,
    status = "completed",
    result = null,
    snapshot = null,
  } = {}) {
    if (!run?.threadId) return null;
    await refreshTaskDiff(run);
    let transcriptTurn = null;
    let transcriptPath = String(snapshot?.transcriptPath ?? "").trim();
    if (!transcriptPath) {
      const current = await readClaudeSessionSnapshot(run.threadId).catch(() => null);
      transcriptPath = String(current?.transcriptPath ?? "").trim();
    }
    if (transcriptPath) {
      const scan = await scanClaudeHistoricalTranscriptFile(transcriptPath).catch((error) => {
        logger.error(`Cannot read Claude transcript for journal ${run.threadId}:`, error.message);
        return null;
      });
      transcriptTurn = scan?.turns?.at(-1) ?? null;
    }
    const resultUsage = claudeResultTokenUsage(result);
    const usage = transcriptTurn?.usageReported ? transcriptTurn.usage : resultUsage.usage;
    const usageReported = transcriptTurn?.usageReported === true || resultUsage.reported === true;
    const modelUsage = result?.modelUsage ?? result?.model_usage;
    const resultModels = modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)
      ? Object.keys(modelUsage).map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : [];
    const completedAt = transcriptTurn?.completedAt || new Date().toISOString();
    return projectTurnUsageToWorkLog({
      provider: "claude",
      threadId: run.threadId,
      turnId: transcriptTurn?.turnId || run.turnId || randomUUID(),
      projectRoot: run.projectRoot,
      taskTitle: runTaskTitle(run),
      status,
      usage,
      usageReported,
      estimatedCredits: claudeResultEstimatedCredits(result),
      estimateKind: result ? "claude-cli-total-cost-usd" : "",
      model: transcriptTurn?.model || resultModels.join(",") || run.modelId || "",
      serviceTier: transcriptTurn?.serviceTier || "default",
      startedAt: transcriptTurn?.startedAt || run.startedAt,
      completedAt,
      prompt: transcriptTurn?.prompt || run.promptPreview,
      changedFiles: changedFilesForRun(run),
      diff: run.latestDiff ?? "",
      skillsUsed: transcriptTurn?.skillsUsed ?? [],
      mcpCalls: transcriptTurn?.mcpCalls ?? [],
      toolMetricsKnown: transcriptTurn?.toolMetricsKnown === true,
      message: null,
    }, {
      title: conciseTurnTitle(answer, status),
      body: answer,
    });
  }

  return {
    applyCodexRolloutContext,
    changedFilesForRun,
    projectTurnUsageToWorkLog,
    projectClaudeRunToWorkLog,
  };
}

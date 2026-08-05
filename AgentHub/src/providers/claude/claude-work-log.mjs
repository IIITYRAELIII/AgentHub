import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findContainingProject } from "../../../config.mjs";
import { applyLedgerDelta } from "../../../incremental-ledger.mjs";
import { JournalDatabase } from "../../../journal-database.mjs";
import { creditsFromUsd } from "../../domain/token-usage.mjs";
import { readJsonWithBackup } from "../../../state-store.mjs";
import { conciseTurnTitle } from "../../application/turn-title.mjs";
import { WorkLogUsageStore, workLogTurnKey } from "../../../work-log-usage.mjs";

function contentBlocks(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

function promptText(entry) {
  return contentBlocks(entry?.message)
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? "")
      .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/gu, "")
      .trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isPromptEntry(entry) {
  return entry?.type === "user"
    && entry.message?.role === "user"
    && Boolean(promptText(entry));
}

function isUtilityPrompt(value) {
  const prompt = String(value ?? "").trim();
  return !prompt
    || /^<local-command-/iu.test(prompt)
    || /<command-name>\s*\/[^<]+\s*<\/command-name>/iu.test(prompt);
}

function textFromAssistant(entry) {
  return contentBlocks(entry?.message)
    .filter((block) => block?.type === "text" && String(block.text ?? "").trim())
    .map((block) => String(block.text).trim())
    .join("\n\n")
    .trim();
}

function parseLines(text) {
  return String(text ?? "")
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function stableTurnId(entry, index) {
  const explicit = String(entry?.uuid ?? "").trim();
  if (explicit) return explicit;
  return createHash("sha256")
    .update([
      String(entry?.sessionId ?? ""),
      String(entry?.timestamp ?? ""),
      promptText(entry),
      String(index),
    ].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

function sessionTitle(entries, fallback) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const value = entry?.type === "ai-title"
      ? entry.aiTitle
      : entry?.type === "custom-title"
        ? entry.customTitle
        : "";
    const title = String(value ?? "").replace(/\s+/gu, " ").trim();
    if (title) return title.slice(0, 80);
  }
  return String(fallback ?? "").replace(/\s+/gu, " ").trim().slice(0, 80) || "Без названия";
}

function uniqueAssistantEntries(entries) {
  const unique = new Map();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry?.type !== "assistant" || entry.message?.role !== "assistant") continue;
    const key = String(entry.message?.id ?? entry.requestId ?? entry.uuid ?? index);
    unique.set(key, entry);
  }
  return [...unique.values()];
}

function claudeToolMetrics(entries) {
  const toolResults = new Map();
  for (const entry of entries) {
    for (const block of contentBlocks(entry?.message)) {
      if (block?.type !== "tool_result") continue;
      const toolUseId = String(block.tool_use_id ?? "").trim();
      if (toolUseId) toolResults.set(toolUseId, block.is_error === true ? "failed" : "completed");
    }
  }

  const skillsUsed = new Set();
  const mcpCalls = new Map();
  for (const entry of entries) {
    if (entry?.type === "user" && entry.message?.role === "user") {
      for (const block of contentBlocks(entry.message)) {
        if (block?.type !== "text") continue;
        const match = String(block.text ?? "").match(
          /^Base directory for this skill:\s*(.+)$/imu,
        );
        const directory = String(match?.[1] ?? "").trim().replace(/^['"]|['"]$/gu, "");
        const skill = directory.split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
        if (skill) skillsUsed.add(skill);
      }
    }
    if (entry?.type !== "assistant" || entry.message?.role !== "assistant") continue;
    for (const block of contentBlocks(entry?.message)) {
      if (block?.type !== "tool_use") continue;
      const name = String(block.name ?? "").trim();
      if (name === "Skill") {
        const skill = String(block.input?.skill ?? "").trim();
        if (skill) skillsUsed.add(skill);
        continue;
      }
      const match = /^mcp__(.+?)__(.+)$/u.exec(name);
      const id = String(block.id ?? "").trim();
      if (!match || !id || !toolResults.has(id)) continue;
      mcpCalls.set(id, {
        id,
        server: match[1],
        tool: match[2],
        status: toolResults.get(id),
      });
    }
  }
  return {
    skillsUsed: [...skillsUsed],
    mcpCalls: [...mcpCalls.values()],
    toolMetricsKnown: true,
  };
}

function nonNegative(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

const TOKENS_PER_MTOK = 1_000_000;
const SONNET_5_INTRODUCTORY_PRICE_END = Date.parse("2026-09-01T00:00:00.000Z");

function claudeModelTokenRates(model, timestamp, speed = "standard") {
  const normalizedModel = String(model ?? "").trim().toLowerCase();
  const normalizedSpeed = String(speed ?? "standard").trim().toLowerCase();
  if (!normalizedModel || normalizedModel === "<synthetic>") return null;

  if (normalizedSpeed === "fast") {
    if (/claude-opus-(?:5|4-8)(?:-|$)/u.test(normalizedModel)) {
      return { input: 10, output: 50 };
    }
    if (/claude-opus-4-7(?:-|$)/u.test(normalizedModel)) {
      return { input: 30, output: 150 };
    }
  }
  if (/claude-(?:fable|mythos)-5(?:-|$)/u.test(normalizedModel)) {
    return { input: 10, output: 50 };
  }
  if (/claude-opus-(?:5|4-(?:8|7|6|5))(?:-|$)/u.test(normalizedModel)) {
    return { input: 5, output: 25 };
  }
  if (/claude-(?:opus-4(?:-1)?|3-opus)(?:-|$)/u.test(normalizedModel)) {
    return { input: 15, output: 75 };
  }
  if (/claude-sonnet-5(?:-|$)/u.test(normalizedModel)) {
    const observedAt = Date.parse(String(timestamp ?? ""));
    return Number.isFinite(observedAt) && observedAt < SONNET_5_INTRODUCTORY_PRICE_END
      ? { input: 2, output: 10 }
      : { input: 3, output: 15 };
  }
  if (/claude-(?:sonnet-4(?:-[65])?|3-(?:7|5)-sonnet)(?:-|$)/u.test(normalizedModel)) {
    return { input: 3, output: 15 };
  }
  if (/claude-(?:haiku-4-5|3-5-haiku)(?:-|$)/u.test(normalizedModel)) {
    return /haiku-4-5/u.test(normalizedModel)
      ? { input: 1, output: 5 }
      : { input: 0.8, output: 4 };
  }
  if (/claude-3-haiku(?:-|$)/u.test(normalizedModel)) {
    return { input: 0.25, output: 1.25 };
  }
  return null;
}

function claudeAssistantTokenCostUsd(entry) {
  const usage = entry?.message?.usage;
  if (!usage) return { costUsd: 0, priced: true };
  const tokenCounts = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
    usage.output_tokens,
  ].map(nonNegative);
  const totalTokens = tokenCounts.reduce((sum, value) => sum + value, 0);
  if (!totalTokens) return { costUsd: 0, priced: true };

  const rates = claudeModelTokenRates(
    entry?.message?.model,
    entry?.timestamp,
    usage.speed,
  );
  if (!rates) return { costUsd: 0, priced: false };

  const cacheCreation = usage.cache_creation ?? {};
  const oneHourCacheWrite = nonNegative(cacheCreation.ephemeral_1h_input_tokens);
  const reportedFiveMinuteCacheWrite = nonNegative(
    cacheCreation.ephemeral_5m_input_tokens,
  );
  const totalCacheWrite = nonNegative(usage.cache_creation_input_tokens);
  const fiveMinuteCacheWrite = reportedFiveMinuteCacheWrite
    + Math.max(0, totalCacheWrite - oneHourCacheWrite - reportedFiveMinuteCacheWrite);
  const cacheRead = nonNegative(usage.cache_read_input_tokens);
  const input = nonNegative(usage.input_tokens);
  const output = nonNegative(usage.output_tokens);
  const geoMultiplier = String(usage.inference_geo ?? "").trim().toLowerCase() === "us"
    ? 1.1
    : 1;
  const costUsd = (
    input * rates.input
    + fiveMinuteCacheWrite * rates.input * 1.25
    + oneHourCacheWrite * rates.input * 2
    + cacheRead * rates.input * 0.1
    + output * rates.output
  ) / TOKENS_PER_MTOK * geoMultiplier;
  return { costUsd, priced: true };
}

export function claudeTranscriptEstimatedCredits(assistantEntries) {
  let costUsd = 0;
  let foundUsage = false;
  for (const entry of uniqueAssistantEntries(assistantEntries)) {
    const priced = claudeAssistantTokenCostUsd(entry);
    if (!priced.priced) return 0;
    if (entry?.message?.usage) foundUsage = true;
    costUsd += priced.costUsd;
  }
  return foundUsage ? creditsFromUsd(costUsd) ?? 0 : 0;
}

export function claudeTranscriptTokenUsage(assistantEntries) {
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
  let reported = false;
  for (const entry of uniqueAssistantEntries(assistantEntries)) {
    const item = entry.message?.usage;
    if (!item) continue;
    reported = true;
    const cached = nonNegative(item.cache_read_input_tokens);
    const input = nonNegative(item.input_tokens)
      + nonNegative(item.cache_creation_input_tokens)
      + cached;
    const output = nonNegative(item.output_tokens);
    usage.inputTokens += input;
    usage.cachedInputTokens += cached;
    usage.outputTokens += output;
    usage.totalTokens += input + output;
  }
  return { usage, reported };
}

export function claudeResultTokenUsage(result) {
  const item = result?.usage;
  if (!item) return claudeTranscriptTokenUsage([]);
  const cached = nonNegative(item.cache_read_input_tokens);
  const input = nonNegative(item.input_tokens)
    + nonNegative(item.cache_creation_input_tokens)
    + cached;
  const output = nonNegative(item.output_tokens);
  return {
    usage: {
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      reasoningOutputTokens: 0,
      totalTokens: input + output,
    },
    reported: true,
  };
}

export function claudeResultEstimatedCredits(result) {
  const direct = Number(result?.total_cost_usd ?? result?.totalCostUsd);
  if (Number.isFinite(direct) && direct >= 0) return creditsFromUsd(direct) ?? 0;
  const modelUsage = result?.modelUsage ?? result?.model_usage;
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return 0;
  let total = 0;
  let found = false;
  for (const value of Object.values(modelUsage)) {
    const cost = Number(value?.costUSD ?? value?.cost_usd);
    if (!Number.isFinite(cost) || cost < 0) continue;
    found = true;
    total += cost;
  }
  return found ? creditsFromUsd(total) ?? 0 : 0;
}

export function scanClaudeHistoricalTranscript(text, { transcriptPath = "" } = {}) {
  const entries = parseLines(text);
  const promptIndexes = entries
    .map((entry, index) => (isPromptEntry(entry) ? index : -1))
    .filter((index) => index >= 0);
  const firstPrompt = promptIndexes.map((index) => promptText(entries[index])).find((value) => (
    !isUtilityPrompt(value)
  ));
  const threadId = String(
    entries.map((entry) => entry?.sessionId).filter(Boolean).at(-1)
      ?? path.basename(transcriptPath, path.extname(transcriptPath)),
  ).trim();
  const cwd = String(entries.map((entry) => entry?.cwd).filter(Boolean).at(-1) ?? "").trim();
  const title = sessionTitle(entries, firstPrompt);
  const isSidechain = entries.some((entry) => entry?.isSidechain === true)
    || String(transcriptPath).split(/[\\/]/u).includes("subagents");
  const turns = [];

  for (let promptNumber = 0; promptNumber < promptIndexes.length; promptNumber += 1) {
    const start = promptIndexes[promptNumber];
    const end = promptIndexes[promptNumber + 1] ?? entries.length;
    const promptEntry = entries[start];
    const prompt = promptText(promptEntry);
    if (isUtilityPrompt(prompt)) continue;
    const turnEntries = entries.slice(start + 1, end);
    const assistantEntries = uniqueAssistantEntries(turnEntries);
    if (!assistantEntries.length) continue;
    const completedEntries = assistantEntries.filter((entry) => (
      entry.message?.stop_reason === "end_turn"
    ));
    const finalEntry = completedEntries.at(-1)
      ?? assistantEntries.findLast((entry) => textFromAssistant(entry))
      ?? assistantEntries.at(-1);
    const body = textFromAssistant(finalEntry);
    const completed = completedEntries.length > 0;
    const terminal = completed || promptNumber + 1 < promptIndexes.length;
    if (!terminal) continue;
    const { usage, reported } = claudeTranscriptTokenUsage(assistantEntries);
    const estimatedCredits = claudeTranscriptEstimatedCredits(assistantEntries);
    const toolMetrics = claudeToolMetrics([promptEntry, ...turnEntries]);
    const models = [...new Set(assistantEntries
      .map((entry) => String(entry.message?.model ?? "").trim().toLowerCase())
      .filter(Boolean))];
    const completedAt = String(
      completedEntries.at(-1)?.timestamp
        ?? assistantEntries.at(-1)?.timestamp
        ?? promptEntry.timestamp
        ?? "",
    );
    turns.push({
      provider: "claude",
      threadId,
      turnId: stableTurnId(promptEntry, promptNumber),
      taskTitle: title,
      title: conciseTurnTitle(body, completed ? "completed" : "aborted"),
      body,
      prompt,
      usage,
      usageReported: reported,
      estimatedCredits,
      estimateKind: estimatedCredits > 0 ? "claude-api-token-pricing" : "",
      model: models.length === 1 ? models[0] : models.join(","),
      serviceTier: String(
        finalEntry?.message?.usage?.service_tier ?? "default",
      ).trim().toLowerCase() || "default",
      startedAt: String(promptEntry.timestamp ?? completedAt),
      completedAt,
      status: completed ? "completed" : "aborted",
      cwd,
      ...toolMetrics,
    });
  }

  return {
    session: { threadId, cwd, title, isSidechain, transcriptPath },
    turns,
  };
}

export async function scanClaudeHistoricalTranscriptFile(transcriptPath) {
  return scanClaudeHistoricalTranscript(
    await readFile(transcriptPath, "utf8"),
    { transcriptPath },
  );
}

async function transcriptFiles(root) {
  const files = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "subagents") await visit(candidate);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) files.push(candidate);
    }
  }
  await visit(root);
  return files;
}

export async function buildClaudeWorkLogBackfill({
  transcriptRoot = path.join(os.homedir(), ".claude", "projects"),
  databaseFile,
  ledgerFile,
  projects,
} = {}) {
  let currentLedger = { version: 8, turns: {} };
  if (databaseFile) {
    const database = new JournalDatabase(databaseFile);
    try {
      currentLedger = await database.loadLedger();
    } finally {
      database.close();
    }
  }
  if (!Object.keys(currentLedger.turns ?? {}).length && ledgerFile) {
    const loaded = await readJsonWithBackup(ledgerFile);
    currentLedger = (await applyLedgerDelta(
      loaded.value ?? currentLedger,
      `${ledgerFile}.delta.jsonl`,
    )).value;
  }
  const turns = { ...(currentLedger?.turns ?? {}) };
  const files = await transcriptFiles(path.resolve(transcriptRoot));
  files.sort((left, right) => left.localeCompare(right));
  const report = {
    transcriptFiles: files.length,
    sessions: 0,
    scannedTurns: 0,
    importedTurns: 0,
    updatedTurns: 0,
    existingTurns: 0,
    skippedSidechains: 0,
    skippedOutsideProjects: 0,
    recordsWithoutCost: 0,
  };

  for (const file of files) {
    const scan = await scanClaudeHistoricalTranscriptFile(file);
    if (scan.session.isSidechain) {
      report.skippedSidechains += 1;
      continue;
    }
    const project = findContainingProject(projects, scan.session.cwd);
    if (!project) {
      report.skippedOutsideProjects += 1;
      continue;
    }
    report.sessions += 1;
    for (const turn of scan.turns) {
      report.scannedTurns += 1;
      const record = {
        workLogId: null,
        projectRoot: project.path,
        ...turn,
        taskThreadId: turn.threadId,
        parentThreadId: "",
        aggregateOnly: false,
        provisional: false,
        pricingMetadataResolved: true,
        changedFiles: [],
        diff: "",
      };
      const key = workLogTurnKey(record);
      if (turns[key]) {
        report.existingTurns += 1;
        let updated = false;
        if (/^Ход (?:завершён|отменён)$/u.test(String(turns[key].title ?? ""))
          && record.title
          && record.title !== turns[key].title) {
          turns[key] = { ...turns[key], title: record.title };
          updated = true;
        }
        if (record.estimatedCredits > 0
          && Number(turns[key].estimatedCredits ?? 0) <= 0) {
          turns[key] = {
            ...turns[key],
            estimatedCredits: record.estimatedCredits,
            estimateKind: record.estimateKind,
          };
          updated = true;
        }
        if (record.toolMetricsKnown === true && (
          turns[key].toolMetricsKnown !== true
          || JSON.stringify(turns[key].skillsUsed ?? []) !== JSON.stringify(record.skillsUsed)
          || JSON.stringify(turns[key].mcpCalls ?? []) !== JSON.stringify(record.mcpCalls)
        )) {
          turns[key] = {
            ...turns[key],
            skillsUsed: record.skillsUsed,
            mcpCalls: record.mcpCalls,
            toolMetricsKnown: true,
          };
          updated = true;
        }
        if (updated) report.updatedTurns += 1;
        continue;
      }
      turns[key] = record;
      report.importedTurns += 1;
      if (!record.estimatedCredits) report.recordsWithoutCost += 1;
    }
  }
  return { ledger: { version: 8, turns }, report };
}

function migrationTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

export async function applyClaudeWorkLogBackfill({
  migration,
  databaseFile,
  ledgerFile,
  workLogFile,
  projectRoot = "",
  projectionProjectRoots,
  backupRoot,
  now = new Date(),
} = {}) {
  if (!databaseFile) throw new Error("SQLite journal database is required");
  const resolvedBackupRoot = backupRoot || path.join(path.dirname(databaseFile), "migrations");
  const legacyLedgerFile = ledgerFile || path.join(path.dirname(databaseFile), "work-log-usage.json");
  const backupDirectory = path.join(resolvedBackupRoot, `claude-${migrationTimestamp(now)}`);
  await mkdir(backupDirectory, { recursive: true });
  for (const file of [
    legacyLedgerFile,
    `${legacyLedgerFile}.bak`,
    `${legacyLedgerFile}.delta.jsonl`,
    workLogFile,
  ].filter(Boolean)) {
    try {
      await copyFile(file, path.join(backupDirectory, path.basename(file)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const database = new JournalDatabase(databaseFile);
  try {
    await database.importLegacyLedger(legacyLedgerFile);
    let applied;
    let mergedLedger;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = await database.currentRevision();
      const current = await database.loadLedger();
      mergedLedger = {
        version: 8,
        turns: { ...(current.turns ?? {}), ...(migration?.ledger?.turns ?? {}) },
      };
      try {
        applied = await database.replaceLedger(mergedLedger, { expectedRevision: revision });
        break;
      } catch (error) {
        if (!/revision conflict/iu.test(String(error?.message ?? "")) || attempt === 2) throw error;
      }
    }
    const roots = Array.isArray(projectionProjectRoots) && projectionProjectRoots.length
      ? projectionProjectRoots
      : [...new Set(Object.values(mergedLedger.turns)
        .map((record) => String(record?.projectRoot ?? "").trim()).filter(Boolean))];
    const resolvedProjectRoot = projectRoot || roots[0] || "";
    const store = new WorkLogUsageStore({
      ledgerFile: legacyLedgerFile,
      databaseFile,
      journalDatabase: database,
      defaultProjectRoot: resolvedProjectRoot,
    });
    try {
      await store.project(null, {
        projectRoot: resolvedProjectRoot,
        projectionProjectRoots: roots,
      });
    } finally {
      await store.close();
    }
    return { backupDirectory, databaseFile: path.resolve(databaseFile), ...applied };
  } finally {
    database.close();
  }
}

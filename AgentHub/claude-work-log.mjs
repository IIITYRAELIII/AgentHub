import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findContainingProject } from "./config.mjs";
import { creditsFromUsd } from "./token-usage.mjs";
import { writeTextAtomic } from "./state-store.mjs";
import { conciseTurnTitle } from "./turn-title.mjs";
import { projectWorkLogUsage, workLogTurnKey } from "./work-log-usage.mjs";

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

function nonNegative(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
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
    const assistantEntries = uniqueAssistantEntries(entries.slice(start + 1, end));
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
      estimatedCredits: 0,
      estimateKind: "",
      model: models.length === 1 ? models[0] : models.join(","),
      serviceTier: String(
        finalEntry?.message?.usage?.service_tier ?? "default",
      ).trim().toLowerCase() || "default",
      startedAt: String(promptEntry.timestamp ?? completedAt),
      completedAt,
      status: completed ? "completed" : "aborted",
      cwd,
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
  ledgerFile,
  projects,
} = {}) {
  const currentLedger = await readFile(ledgerFile, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error?.code === "ENOENT") return { version: 7, turns: {} };
      throw error;
    });
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
        if (/^Ход (?:завершён|отменён)$/u.test(String(turns[key].title ?? ""))
          && record.title
          && record.title !== turns[key].title) {
          turns[key] = { ...turns[key], title: record.title };
          report.updatedTurns += 1;
        }
        continue;
      }
      turns[key] = record;
      report.importedTurns += 1;
      if (!record.estimatedCredits) report.recordsWithoutCost += 1;
    }
  }
  return { ledger: { version: 7, turns }, report };
}

function migrationTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/gu, "-");
}

export async function applyClaudeWorkLogBackfill({
  migration,
  ledgerFile,
  workLogFile,
  backupRoot = path.join(path.dirname(ledgerFile), "migrations"),
  now = new Date(),
} = {}) {
  const backupDirectory = path.join(backupRoot, `claude-${migrationTimestamp(now)}`);
  await mkdir(backupDirectory, { recursive: true });
  for (const file of [ledgerFile, workLogFile]) {
    try {
      await copyFile(file, path.join(backupDirectory, path.basename(file)));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const ledgerText = `${JSON.stringify(migration.ledger, null, 2)}\n`;
  await writeTextAtomic(ledgerFile, ledgerText);
  await writeTextAtomic(`${ledgerFile}.bak`, ledgerText);
  await writeTextAtomic(
    workLogFile,
    projectWorkLogUsage("# Глобальный журнал работ\n", migration.ledger.turns),
  );
  return { backupDirectory };
}

import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  claudeTranscriptHistory,
  codexFinalTurnAnswer,
  codexTurnHasExplicitFinalAnswer,
} from "./task-history.mjs";

export { codexFinalTurnAnswer, codexTurnHasExplicitFinalAnswer };

const MAX_TRANSCRIPT_TAIL = 4 * 1024 * 1024;
const MAX_CATALOG_TRANSCRIPT_TAIL = 512 * 1024;
const MAX_CATALOG_TRANSCRIPT_HEAD = 64 * 1024;
const MAX_CLAUDE_TRANSCRIPT_CACHE_ENTRIES = 1000;
const claudeTranscriptCache = new Map();
let claudeTranscriptCacheHits = 0;
let claudeTranscriptCacheMisses = 0;

export function claudeTranscriptCacheStats() {
  return {
    entries: claudeTranscriptCache.size,
    hits: claudeTranscriptCacheHits,
    misses: claudeTranscriptCacheMisses,
  };
}

export function resetClaudeTranscriptCache() {
  claudeTranscriptCache.clear();
  claudeTranscriptCacheHits = 0;
  claudeTranscriptCacheMisses = 0;
}

function cacheKey(mode, transcriptPath) {
  return `${mode}:${path.resolve(transcriptPath).toLowerCase()}`;
}

function cachedTranscriptSnapshot(mode, transcriptPath, info) {
  const key = cacheKey(mode, transcriptPath);
  const cached = claudeTranscriptCache.get(key);
  if (!cached || cached.size !== info.size || cached.modifiedAtMs !== info.mtimeMs) {
    claudeTranscriptCacheMisses += 1;
    return null;
  }
  claudeTranscriptCacheHits += 1;
  // Refresh insertion order so frequently used sessions survive bounded eviction.
  claudeTranscriptCache.delete(key);
  claudeTranscriptCache.set(key, cached);
  return cached.snapshot;
}

function rememberTranscriptSnapshot(mode, transcriptPath, info, snapshot) {
  const key = cacheKey(mode, transcriptPath);
  claudeTranscriptCache.delete(key);
  claudeTranscriptCache.set(key, {
    size: info.size,
    modifiedAtMs: info.mtimeMs,
    snapshot,
  });
  while (claudeTranscriptCache.size > MAX_CLAUDE_TRANSCRIPT_CACHE_ENTRIES) {
    claudeTranscriptCache.delete(claudeTranscriptCache.keys().next().value);
  }
  return snapshot;
}

function contentBlocks(message) {
  if (Array.isArray(message?.content)) return message.content;
  if (typeof message?.content === "string") return [{ type: "text", text: message.content }];
  return [];
}

function isUserPrompt(entry) {
  if (entry?.type !== "user" || entry.message?.role !== "user") return false;
  const blocks = contentBlocks(entry.message);
  return blocks.some((block) => block?.type === "text" && String(block.text ?? "").trim());
}

function promptText(entry) {
  return contentBlocks(entry?.message)
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text ?? "")
      .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/g, "")
      .trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function catalogPromptTitle(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!isUserPrompt(entries[index])) continue;
    const value = promptText(entries[index]).replace(/\s+/g, " ").trim();
    if (!value || /<command-name>\s*\/[^<]+\s*<\/command-name>/i.test(value)
      || /^<local-command-/i.test(value)) continue;
    return value.slice(0, 80);
  }
  return null;
}

// Claude Code сам генерирует короткое название задачи и пишет его записями
// {"type":"ai-title","aiTitle":"…"} — это то, что видно в списке /resume. Оно куда
// осмысленнее последнего сообщения; берём самое свежее (последнее по транскрипту).
function claudeAiTitle(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "ai-title") continue;
    const value = String(entry.aiTitle ?? "").replace(/\s+/g, " ").trim();
    if (value) return value.slice(0, 80);
  }
  return null;
}

export function codexTurnAnswer(turn) {
  return (turn?.items ?? [])
    .filter((item) => item?.type === "agentMessage" && String(item.text ?? "").trim())
    .map((item) => String(item.text).trim())
    .join("\n\n")
    .trim();
}

export function lastCompletedCodexAnswer(turns) {
  const completed = (Array.isArray(turns) ? turns : [])
    .findLast((turn) => turn?.status === "completed" && codexFinalTurnAnswer(turn));
  return completed ? codexFinalTurnAnswer(completed) : "";
}

export function parseClaudeTranscript(text) {
  const entries = String(text)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  let promptIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (isUserPrompt(entries[index])) promptIndex = index;
  }
  const turnEntries = entries.slice(promptIndex + 1);
  const promptEntry = promptIndex >= 0 ? entries[promptIndex] : null;
  const assistantEntries = turnEntries.filter((entry) => (
    entry?.type === "assistant" && entry.message?.role === "assistant"
  ));
  const answerParts = [];
  const thinkingParts = [];
  let lastTool = "";
  for (const entry of assistantEntries) {
    for (const block of contentBlocks(entry.message)) {
      if (block?.type === "text" && String(block.text ?? "").trim()) {
        answerParts.push(String(block.text).trim());
      } else if (block?.type === "thinking" && String(block.thinking ?? "").trim()) {
        thinkingParts.push(String(block.thinking).trim());
      } else if (block?.type === "tool_use") {
        lastTool = String(block.name ?? "").trim();
      }
    }
  }
  const completed = turnEntries.some((entry) => entry?.type === "last-prompt")
    || assistantEntries.some((entry) => entry.message?.stop_reason === "end_turn");
  const answer = answerParts.join("\n\n").trim();
  const reasoning = thinkingParts.at(-1)?.slice(-1500) ?? "";
  const aiTitle = claudeAiTitle(entries);
  const stage = completed
    ? "Задача завершена."
    : lastTool
      ? `Claude использует инструмент ${lastTool}…`
      : answer
        ? "Ответ формируется…"
        : "Claude выполняет задачу…";
  return {
    answer,
    reasoning,
    completed,
    active: promptIndex >= 0 && !completed,
    stage,
    updatedAt: turnEntries.map((entry) => entry?.timestamp).filter(Boolean).at(-1) ?? null,
    sessionId: entries.map((entry) => entry?.sessionId).filter(Boolean).at(-1) ?? null,
    cwd: entries.map((entry) => entry?.cwd).filter(Boolean).at(-1) ?? null,
    title: aiTitle || promptText(promptEntry).replace(/\s+/g, " ").slice(0, 80) || null,
    catalogTitle: aiTitle || catalogPromptTitle(entries),
    isSidechain: entries.some((entry) => entry?.isSidechain === true),
  };
}

async function findTranscript(directory, fileName) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === fileName) return path.join(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findTranscript(path.join(directory, entry.name), fileName);
    if (found) return found;
  }
  return null;
}

async function readTail(filePath, maximumBytes = MAX_TRANSCRIPT_TAIL) {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maximumBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    let text = buffer.toString("utf8");
    if (stats.size > length) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } finally {
    await handle.close();
  }
}

async function readHead(filePath, maximumBytes) {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maximumBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    let text = buffer.toString("utf8");
    if (stats.size > length) text = text.slice(0, text.lastIndexOf("\n"));
    return text;
  } finally {
    await handle.close();
  }
}

async function readCatalogSample(filePath, size) {
  if (size <= MAX_CATALOG_TRANSCRIPT_HEAD + MAX_CATALOG_TRANSCRIPT_TAIL) {
    return readTail(filePath, size);
  }
  const [head, tail] = await Promise.all([
    readHead(filePath, MAX_CATALOG_TRANSCRIPT_HEAD),
    readTail(filePath, MAX_CATALOG_TRANSCRIPT_TAIL),
  ]);
  return `${head}\n${tail}`;
}

async function findTranscriptFiles(directory, results = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return results;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(path.join(directory, entry.name));
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "subagents") continue;
    await findTranscriptFiles(path.join(directory, entry.name), results);
  }
  return results;
}

export async function readClaudeSessionSnapshot(
  sessionId,
  { projectsRoot = path.join(os.homedir(), ".claude", "projects") } = {},
) {
  const normalized = String(sessionId ?? "").trim();
  if (!normalized) return null;
  const transcriptPath = await findTranscript(projectsRoot, `${normalized}.jsonl`);
  if (!transcriptPath) return null;
  const info = await stat(transcriptPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  const cached = cachedTranscriptSnapshot("session", transcriptPath, info);
  if (cached) return { ...cached };
  const transcript = await readTail(transcriptPath);
  // Время последней записи нужно вызывающему коду, чтобы отличить действительно
  // выполняющийся ход от давно брошенного незавершённого транскрипта.
  const snapshot = {
    ...parseClaudeTranscript(transcript),
    history: claudeTranscriptHistory(transcript),
    transcriptPath,
    modifiedAtMs: info.mtimeMs,
  };
  rememberTranscriptSnapshot("session", transcriptPath, info, snapshot);
  return { ...snapshot };
}

export async function listClaudeSessionSnapshots(
  { projectsRoot = path.join(os.homedir(), ".claude", "projects") } = {},
) {
  const transcriptPaths = await findTranscriptFiles(projectsRoot);
  const snapshots = [];
  const batchSize = 12;
  for (let start = 0; start < transcriptPaths.length; start += batchSize) {
    const batch = transcriptPaths.slice(start, start + batchSize);
    const values = await Promise.all(batch.map(async (transcriptPath) => {
      try {
        const info = await stat(transcriptPath);
        let snapshot = cachedTranscriptSnapshot("catalog", transcriptPath, info);
        if (!snapshot) {
          snapshot = parseClaudeTranscript(await readCatalogSample(transcriptPath, info.size));
          rememberTranscriptSnapshot("catalog", transcriptPath, info, snapshot);
        }
        if (snapshot.isSidechain || !snapshot.catalogTitle) return null;
        return {
          ...snapshot,
          sessionId: snapshot.sessionId || path.basename(transcriptPath, ".jsonl"),
          transcriptPath,
          modifiedAtMs: info.mtimeMs,
        };
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    }));
    snapshots.push(...values.filter(Boolean));
  }
  return snapshots;
}

import { open, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_TRANSCRIPT_TAIL = 4 * 1024 * 1024;

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

export async function readClaudeSessionSnapshot(
  sessionId,
  { projectsRoot = path.join(os.homedir(), ".claude", "projects") } = {},
) {
  const normalized = String(sessionId ?? "").trim();
  if (!normalized) return null;
  const transcriptPath = await findTranscript(projectsRoot, `${normalized}.jsonl`);
  if (!transcriptPath) return null;
  return {
    ...parseClaudeTranscript(await readTail(transcriptPath)),
    transcriptPath,
  };
}

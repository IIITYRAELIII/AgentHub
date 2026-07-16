import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const MAX_BINDINGS = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function bindingsPath(dataDir) {
  return path.join(dataDir, "telegram-thread-bindings.json");
}

function validBinding(binding) {
  return binding
    && Number.isSafeInteger(binding.chatId)
    && Number.isSafeInteger(binding.messageId)
    && (binding.provider === "codex" || binding.provider === "claude")
    && typeof binding.threadId === "string" && binding.threadId.trim()
    && typeof binding.projectRoot === "string" && binding.projectRoot.trim()
    && (binding.taskTitle == null || typeof binding.taskTitle === "string");
}

function recentBindings(bindings, now = Date.now()) {
  return bindings
    .filter(validBinding)
    .filter((binding) => !binding.createdAt || now - Date.parse(binding.createdAt) <= MAX_AGE_MS)
    .slice(-MAX_BINDINGS);
}

export async function readMessageBindings(dataDir) {
  try {
    const value = JSON.parse(await readFile(bindingsPath(dataDir), "utf8"));
    return recentBindings(Array.isArray(value) ? value : []);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function appendMessageBindings(dataDir, additions) {
  const current = await readMessageBindings(dataDir);
  const keys = new Set(additions.map((item) => `${item.chatId}:${item.messageId}`));
  const merged = recentBindings([
    ...current.filter((item) => !keys.has(`${item.chatId}:${item.messageId}`)),
    ...additions,
  ]);
  await mkdir(dataDir, { recursive: true });
  const target = bindingsPath(dataDir);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export async function findMessageBinding(dataDir, chatId, messageId) {
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) return null;
  const bindings = await readMessageBindings(dataDir);
  return bindings.findLast((item) => item.chatId === chatId && item.messageId === messageId) ?? null;
}

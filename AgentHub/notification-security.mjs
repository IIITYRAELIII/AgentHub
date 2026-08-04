import { realpath } from "node:fs/promises";
import path from "node:path";

const CALLER_ENVIRONMENT_NAMES = [
  "AI_PROVIDER",
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CODEX_PROJECT_ROOT",
  "CODEX_THREAD_ID",
];

function sameOrInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function allowedNotificationChatIds(config) {
  return new Set([
    ...(config?.allowedUserIds ?? []),
    ...(config?.allowedChatIds ?? []),
  ].map(Number).filter(Number.isSafeInteger));
}

export function resolveAllowedNotificationChatId(config, explicitChatId = null) {
  const allowed = allowedNotificationChatIds(config);
  if (explicitChatId != null) {
    const value = Number(explicitChatId);
    if (!Number.isSafeInteger(value)) throw new Error("--chat-id must be an integer");
    if (!allowed.has(value)) throw new Error(`Telegram chat ${value} is not in the configured allowlist`);
    return value;
  }
  const allowedChats = [...(config?.allowedChatIds ?? [])];
  if (allowedChats.length === 1) return allowedChats[0];
  const allowedUsers = [...(config?.allowedUserIds ?? [])];
  if (allowedChats.length === 0 && allowedUsers.length === 1) return allowedUsers[0];
  throw new Error("Cannot choose the recipient automatically; specify --chat-id <id>");
}

export async function resolveAllowedNotificationPath(value, {
  roots = [],
  cwd = process.cwd(),
  realpathImpl = realpath,
} = {}) {
  const requested = path.resolve(cwd, String(value ?? ""));
  const [resolved, resolvedRoots] = await Promise.all([
    realpathImpl(requested),
    Promise.all(roots.map((root) => realpathImpl(path.resolve(root)))),
  ]);
  if (!resolvedRoots.some((root) => sameOrInside(resolved, root))) {
    throw new Error(`Notification file is outside the configured project roots: ${requested}`);
  }
  return resolved;
}

export async function resolveAllowedNotificationCwd(value, options = {}) {
  return resolveAllowedNotificationPath(value, options);
}

export function cleanRuntimeCallerEnvironment(base = {}, caller = {}) {
  const result = { ...base };
  for (const name of CALLER_ENVIRONMENT_NAMES) delete result[name];
  for (const [name, value] of Object.entries(caller)) {
    if (CALLER_ENVIRONMENT_NAMES.includes(name) && typeof value === "string") {
      result[name] = value;
    }
  }
  return result;
}

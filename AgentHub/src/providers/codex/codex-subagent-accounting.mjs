export const CODEX_TASK_SOURCE_KINDS = Object.freeze([
  "cli",
  "vscode",
  "exec",
  "appServer",
  "unknown",
]);

export const CODEX_SUBAGENT_SOURCE_KINDS = Object.freeze([
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
]);

export const CODEX_AUDIT_SOURCE_KINDS = Object.freeze([
  ...CODEX_TASK_SOURCE_KINDS,
  ...CODEX_SUBAGENT_SOURCE_KINDS,
]);

function threadId(value) {
  return String(value ?? "").trim();
}

const UUID_V7_PATTERN = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function uuidV7TimestampMs(value) {
  const match = String(value ?? "").trim().match(UUID_V7_PATTERN);
  if (!match) return 0;
  return Number.parseInt(`${match[1]}${match[2]}`, 16);
}

export function isInheritedSubagentTurn({ aggregateOnly, threadId: childThreadId, turnId }) {
  if (aggregateOnly !== true) return false;
  const childCreatedAt = uuidV7TimestampMs(childThreadId);
  const turnCreatedAt = uuidV7TimestampMs(turnId);
  return childCreatedAt > 0 && turnCreatedAt > 0 && turnCreatedAt < childCreatedAt;
}

export function codexParentThreadId(thread) {
  return threadId(thread?.parentThreadId);
}

export async function resolveCodexAccountingThread(thread, {
  readThread,
  maxDepth = 32,
} = {}) {
  const initialThreadId = threadId(thread?.id);
  if (!initialThreadId) throw new Error("Codex accounting requires a thread id");

  let current = thread;
  let currentId = initialThreadId;
  let parentId = codexParentThreadId(current);
  if (!parentId) {
    return {
      thread: current,
      threadId: currentId,
      parentThreadId: "",
      isSubagent: false,
      depth: 0,
    };
  }
  if (typeof readThread !== "function") {
    throw new Error("Codex subagent accounting requires a thread reader");
  }

  const directParentThreadId = parentId;
  const visited = new Set([initialThreadId]);
  let depth = 0;
  while (parentId) {
    if (visited.has(parentId)) {
      throw new Error(`Codex subagent parent cycle detected at ${parentId}`);
    }
    if (depth >= maxDepth) {
      throw new Error(`Codex subagent parent depth exceeds ${maxDepth}`);
    }
    visited.add(parentId);
    const response = await readThread(parentId);
    current = response?.thread ?? response;
    currentId = threadId(current?.id);
    if (!currentId || currentId !== parentId) {
      throw new Error(`Cannot read Codex parent thread ${parentId}`);
    }
    depth += 1;
    parentId = codexParentThreadId(current);
  }

  return {
    thread: current,
    threadId: currentId,
    parentThreadId: directParentThreadId,
    isSubagent: true,
    depth,
  };
}

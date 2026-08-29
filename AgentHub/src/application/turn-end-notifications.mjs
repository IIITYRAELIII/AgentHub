import path from "node:path";

import { estimateMissingCodexUsage } from "../domain/codex-usage-estimate.mjs";
import { normalizeServiceTier, normalizeTokenUsage } from "../domain/token-usage.mjs";
import { normalizeWorkLogId } from "./work-log-usage-projection.mjs";

export const TURN_END_TITLE_LIMIT = 100;
export const TURN_END_BODY_LIMIT = 700;

export function turnEndThreadKey({ provider, threadId }) {
  return `${String(provider ?? "").trim().toLowerCase()}\0${String(threadId ?? "").trim()}`;
}

export function turnEndKey({ provider, threadId, turnId }) {
  return `${turnEndThreadKey({ provider, threadId })}\0${String(turnId ?? "").trim()}`;
}

function validBase(value) {
  if (!value || typeof value !== "object") return null;
  const provider = String(value.provider ?? "").trim().toLowerCase();
  const threadId = String(value.threadId ?? "").trim();
  if (!["codex", "claude"].includes(provider) || !threadId) return null;
  return { provider, threadId };
}

function normalizedMessage(value) {
  const base = validBase(value);
  const text = String(value?.text ?? "").trim().slice(0, TURN_END_BODY_LIMIT);
  const title = String(value?.title ?? "").trim().replace(/\s+/g, " ").slice(0, TURN_END_TITLE_LIMIT);
  const projectRoot = String(value?.projectRoot ?? "").trim();
  if (!base || !text || !projectRoot) return null;
  let workLogId = null;
  try {
    workLogId = value.workLogId ? normalizeWorkLogId(value.workLogId) : null;
  } catch {
    workLogId = null;
  }
  return {
    ...base,
    id: String(value.id ?? crypto.randomUUID()),
    turnId: String(value.turnId ?? "").trim() || null,
    projectRoot: path.resolve(projectRoot),
    taskTitle: String(value.taskTitle ?? "").trim(),
    chatId: Number(value.chatId),
    category: String(value.category ?? "done").trim() || "done",
    silent: value.silent === true,
    workLogId,
    title,
    text,
    createdAt: String(value.createdAt ?? new Date().toISOString()),
  };
}

function normalizedPrompts(value) {
  const values = [
    ...(Array.isArray(value?.prompts) ? value.prompts : []),
    ...(Array.isArray(value?.userMessages)
      ? value.userMessages.map((message) => message?.text)
      : []),
  ]
    .map((prompt) => String(prompt ?? "").trim())
    .filter(Boolean);
  const legacy = String(value?.prompt ?? "").trim();
  if (legacy && !values.includes(legacy)) values.unshift(legacy);
  return [...new Set(values)].slice(0, 100);
}

function normalizedCompletion(value) {
  const base = validBase(value);
  const turnId = String(value?.turnId ?? "").trim();
  const projectRoot = String(value?.projectRoot ?? "").trim();
  if (!base || !turnId || !projectRoot) return null;
  const usageReported = value.usageReported === true;
  const prompts = normalizedPrompts(value);
  const estimate = base.provider === "codex"
    ? estimateMissingCodexUsage({
      status: value.status,
      usageReported,
      prompt: prompts.join("\n\n"),
      imageGenerationCount: value.imageGenerationCount,
    })
    : null;
  const estimatedCredits = Math.max(
    0,
    Number(
      value.estimatedCredits
        ?? (value.estimatedUnits != null ? Number(value.estimatedUnits) / 8_000 : null)
        ?? estimate?.estimatedCredits,
    ) || 0,
  );
  const skillsUsed = [...new Set(
    (Array.isArray(value.skillsUsed) ? value.skillsUsed : [])
      .map((name) => String(name ?? "").trim())
      .filter(Boolean),
  )];
  const mcpCalls = (Array.isArray(value.mcpCalls) ? value.mcpCalls : []).flatMap((call) => {
    const id = String(call?.id ?? "").trim();
    if (!id) return [];
    return [{
      id,
      server: String(call?.server ?? "").trim(),
      tool: String(call?.tool ?? "").trim(),
      status: String(call?.status ?? "completed").trim() || "completed",
    }];
  });
  return {
    ...base,
    turnId,
    projectRoot: path.resolve(projectRoot),
    taskTitle: String(value.taskTitle ?? "").trim(),
    chatId: Number(value.chatId),
    status: String(value.status ?? "completed").trim() || "completed",
    usage: normalizeTokenUsage(value.usage),
    usageReported,
    estimatedCredits,
    estimateKind: estimatedCredits > 0
      ? String(value.estimateKind ?? estimate?.estimateKind ?? "").trim()
      : "",
    model: String(value.model ?? "").trim().toLowerCase(),
    serviceTier: value.serviceTier != null || value.service_tier != null
      ? normalizeServiceTier(value.serviceTier ?? value.service_tier)
      : "",
    provisional: value.provisional === true,
    deliveryGroupId: String(value.deliveryGroupId ?? "").trim() || null,
    deliverySequence: Number.isSafeInteger(value.deliverySequence) ? value.deliverySequence : null,
    startedAt: String(value.startedAt ?? ""),
    completedAt: String(value.completedAt ?? new Date().toISOString()),
    prompt: prompts[0] ?? "",
    prompts,
    finalAnswer: String(value.finalAnswer ?? "").trim(),
    changedFiles: Array.isArray(value.changedFiles)
      ? value.changedFiles.map((file) => String(file).trim()).filter(Boolean)
      : [],
    diff: String(value.diff ?? ""),
    gitBaseline: value.gitBaseline && typeof value.gitBaseline === "object"
      ? structuredClone(value.gitBaseline)
      : null,
    skillsUsed,
    mcpCalls,
    toolMetricsKnown: value.toolMetricsKnown === true,
    message: value.message ? normalizedMessage(value.message) : null,
  };
}

export class TurnEndNotificationRegistry {
  #pendingByThread = new Map();
  #completions = new Map();
  #delivered = new Set();
  #limit;
  #pendingTtlMs;
  #now;

  constructor(snapshot = {}, {
    limit = 1_000,
    pendingTtlMs = 7 * 24 * 60 * 60 * 1_000,
    now = Date.now,
  } = {}) {
    this.#limit = Math.max(10, Number(limit) || 1_000);
    this.#pendingTtlMs = Math.max(60_000, Number(pendingTtlMs) || 7 * 24 * 60 * 60 * 1_000);
    this.#now = now;
    this.restore(snapshot);
  }

  restore(snapshot = {}) {
    this.#pendingByThread.clear();
    this.#completions.clear();
    this.#delivered.clear();
    let droppedLegacyPending = 0;
    let droppedStalePending = 0;
    const cutoff = this.#now() - this.#pendingTtlMs;
    for (const value of Array.isArray(snapshot.pending) ? snapshot.pending : []) {
      const message = normalizedMessage(value);
      if (!message) continue;
      if (!message.turnId) {
        droppedLegacyPending += 1;
        continue;
      }
      const createdAt = Date.parse(message.createdAt);
      if (!Number.isFinite(createdAt) || createdAt < cutoff) {
        droppedStalePending += 1;
        continue;
      }
      this.#queueMessage(message);
    }
    for (const value of Array.isArray(snapshot.completions) ? snapshot.completions : []) {
      const completion = normalizedCompletion(value);
      if (completion) this.#completions.set(turnEndKey(completion), completion);
    }
    for (const key of Array.isArray(snapshot.delivered) ? snapshot.delivered : []) {
      if (typeof key === "string" && key) this.#delivered.add(key);
    }
    this.#trim();
    return { droppedLegacyPending, droppedStalePending };
  }

  #queueMessage(message) {
    const key = turnEndThreadKey(message);
    const values = this.#pendingByThread.get(key) ?? [];
    values.push(message);
    values.sort((left, right) => (
      (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0)
    ));
    this.#pendingByThread.set(key, values.slice(-20));
  }

  registerMessage(value) {
    const message = normalizedMessage(value);
    if (!message) throw new Error("Invalid deferred end-of-turn message");
    if (!message.turnId) {
      throw new Error("Deferred end-of-turn messages require an exact turn ID");
    }
    if (message.turnId) {
      const key = turnEndKey(message);
      const completion = this.#completions.get(key);
      if (completion) {
        completion.message = message;
        completion.taskTitle = message.taskTitle || completion.taskTitle;
        return message;
      }
    }
    this.#queueMessage(message);
    this.#trim();
    return message;
  }

  #takeMessage(completion) {
    const key = turnEndThreadKey(completion);
    const values = this.#pendingByThread.get(key) ?? [];
    const exactIndex = values.findIndex((message) => message.turnId === completion.turnId);
    if (exactIndex < 0) return null;
    const [message] = values.splice(exactIndex, 1);
    if (values.length) this.#pendingByThread.set(key, values);
    else this.#pendingByThread.delete(key);
    return message;
  }

  recordCompletion(value) {
    const incoming = normalizedCompletion(value);
    if (!incoming) throw new Error("Invalid turn completion");
    const key = turnEndKey(incoming);
    if (this.#delivered.has(key)) return null;
    const existing = this.#completions.get(key);
    const completion = existing ?? incoming;
    completion.projectRoot = incoming.projectRoot || completion.projectRoot;
    completion.chatId = Number.isSafeInteger(incoming.chatId) ? incoming.chatId : completion.chatId;
    completion.status = incoming.status || completion.status;
    completion.provisional = incoming.provisional === true;
    completion.completedAt = completion.completedAt || incoming.completedAt;
    completion.startedAt = completion.startedAt || incoming.startedAt;
    completion.prompts = [...new Set([
      ...(Array.isArray(completion.prompts) ? completion.prompts : [completion.prompt]),
      ...incoming.prompts,
    ].map((prompt) => String(prompt ?? "").trim()).filter(Boolean))].slice(0, 100);
    completion.prompt = completion.prompts[0] ?? incoming.prompt ?? completion.prompt;
    completion.finalAnswer = incoming.finalAnswer || completion.finalAnswer;
    if (incoming.changedFiles.length) completion.changedFiles = incoming.changedFiles;
    if (incoming.diff) completion.diff = incoming.diff;
    if (incoming.gitBaseline) completion.gitBaseline = incoming.gitBaseline;
    if (incoming.toolMetricsKnown) {
      completion.skillsUsed = incoming.skillsUsed;
      completion.mcpCalls = incoming.mcpCalls;
      completion.toolMetricsKnown = true;
    }
    completion.deliveryGroupId = incoming.deliveryGroupId ?? completion.deliveryGroupId;
    completion.deliverySequence = incoming.deliverySequence ?? completion.deliverySequence;
    if (incoming.usageReported || !completion.usageReported) {
      completion.usage = incoming.usage;
      completion.usageReported = incoming.usageReported;
    }
    if (incoming.estimatedCredits > 0) {
      completion.estimatedCredits = incoming.estimatedCredits;
      completion.estimateKind = incoming.estimateKind;
    }
    if (incoming.model) completion.model = incoming.model;
    completion.serviceTier = incoming.serviceTier || completion.serviceTier;
    completion.message = incoming.message ?? completion.message ?? this.#takeMessage(completion);
    completion.taskTitle = completion.message?.taskTitle || incoming.taskTitle || completion.taskTitle;
    this.#completions.set(key, completion);
    this.#trim();
    return completion;
  }

  get(value) {
    return this.#completions.get(typeof value === "string" ? value : turnEndKey(value)) ?? null;
  }

  takePendingMessage(value) {
    return this.#takeMessage(value);
  }

  retract(value) {
    const key = typeof value === "string" ? value : turnEndKey(value);
    this.#completions.delete(key);
    this.#delivered.delete(key);
  }

  values() {
    return [...this.#completions.values()];
  }

  markDelivered(value) {
    const key = typeof value === "string" ? value : turnEndKey(value);
    this.#completions.delete(key);
    this.#delivered.delete(key);
    this.#delivered.add(key);
    this.#trim();
  }

  hasDelivered(value) {
    return this.#delivered.has(typeof value === "string" ? value : turnEndKey(value));
  }

  snapshot() {
    return {
      pending: [...this.#pendingByThread.values()].flat(),
      completions: [...this.#completions.values()],
      delivered: [...this.#delivered],
    };
  }

  #trim() {
    while (this.#completions.size > this.#limit) {
      this.#completions.delete(this.#completions.keys().next().value);
    }
    while (this.#delivered.size > this.#limit) {
      this.#delivered.delete(this.#delivered.values().next().value);
    }
    const messages = [...this.#pendingByThread.values()].flat()
      .sort((left, right) => (Date.parse(left.createdAt) || 0) - (Date.parse(right.createdAt) || 0));
    for (let index = 0; index < messages.length - this.#limit; index += 1) {
      const stale = messages[index];
      const key = turnEndThreadKey(stale);
      const values = this.#pendingByThread.get(key) ?? [];
      const filtered = values.filter((message) => message.id !== stale.id);
      if (filtered.length) this.#pendingByThread.set(key, filtered);
      else this.#pendingByThread.delete(key);
    }
  }
}

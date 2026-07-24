import { readFile } from "node:fs/promises";
import { catalogTaskKey } from "./task-catalog.mjs";
import { writeTextAtomic } from "./state-store.mjs";

const FORMAT_VERSION = 1;
const DEFAULT_HISTORY_LIMIT = 50;
const DEFAULT_RUNNING_FRESHNESS_MS = 10 * 60 * 1000;
const DEFAULT_TASK_LIMIT = 1_000;

function cleanText(value, limit) {
  return String(value ?? "").trim().slice(0, limit);
}

function cleanHistory(history, limit) {
  return (Array.isArray(history) ? history : [])
    .slice(-limit)
    .map((item) => ({
      id: cleanText(item?.id, 100),
      prompt: cleanText(item?.prompt, 12_000),
      answer: cleanText(item?.answer, 40_000),
      status: cleanText(item?.status, 40),
      active: item?.active === true,
      completed: item?.completed === true,
    }));
}

function persistedTask(value = {}, canonicalizeProjectRoot = (projectRoot) => projectRoot) {
  const provider = cleanText(value.provider, 20).toLowerCase();
  const threadId = cleanText(value.threadId, 100);
  if (!provider || !threadId) return null;
  const projectRoot = cleanText(value.projectRoot, 2_000);
  return {
    provider,
    threadId,
    projectRoot: cleanText(canonicalizeProjectRoot(projectRoot), 2_000),
    projectName: cleanText(value.projectName, 200),
    title: cleanText(value.title ?? value.taskTitle, 200),
    updatedAtMs: Number(value.updatedAtMs) || 0,
    running: value.running === true,
    executionOwner: cleanText(value.executionOwner, 40) || null,
    turnId: cleanText(value.turnId, 100) || null,
    lastActivityAtMs: Number(value.lastActivityAtMs) || null,
    stage: cleanText(value.stage, 1_000),
    answer: cleanText(value.answer, 40_000),
    syncedAtMs: Number(value.syncedAtMs) || 0,
    history: cleanHistory(value.history, DEFAULT_HISTORY_LIMIT),
  };
}

function taskContent(value = {}) {
  const { syncedAtMs: _syncedAtMs, ...content } = value;
  return JSON.stringify(content);
}

function taskContentChanged(previous, next) {
  return taskContent(previous) !== taskContent(next);
}

export class LocalTaskSyncStore {
  #filePath;
  #historyLimit;
  #taskLimit;
  #canonicalizeProjectRoot;
  #canonicalizeValue;
  #tasks = new Map();
  #dirty = false;
  #writeQueue = Promise.resolve();

  constructor({
    filePath,
    historyLimit = DEFAULT_HISTORY_LIMIT,
    taskLimit = DEFAULT_TASK_LIMIT,
    canonicalizeProjectRoot = (projectRoot) => projectRoot,
    canonicalizeValue = (value) => value,
  }) {
    this.#filePath = filePath;
    this.#historyLimit = Math.max(1, Number(historyLimit) || DEFAULT_HISTORY_LIMIT);
    this.#taskLimit = Math.max(1, Number(taskLimit) || DEFAULT_TASK_LIMIT);
    this.#canonicalizeProjectRoot = canonicalizeProjectRoot;
    this.#canonicalizeValue = canonicalizeValue;
  }

  #prune() {
    if (this.#tasks.size <= this.#taskLimit) return false;
    const removable = [...this.#tasks.entries()]
      .filter(([, task]) => task.running !== true)
      .sort((left, right) => {
      const leftAt = Number(left[1].syncedAtMs ?? left[1].updatedAtMs) || 0;
      const rightAt = Number(right[1].syncedAtMs ?? right[1].updatedAtMs) || 0;
      return leftAt - rightAt;
      });
    while (this.#tasks.size > this.#taskLimit && removable.length) {
      this.#tasks.delete(removable.shift()[0]);
    }
    this.#dirty = true;
    return true;
  }

  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.#filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT" || error instanceof SyntaxError) return this;
      throw error;
    }
    if (Number(parsed?.version) !== FORMAT_VERSION) return this;
    const original = JSON.stringify(parsed);
    parsed = this.#canonicalizeValue(parsed);
    if (JSON.stringify(parsed) !== original) this.#dirty = true;
    for (const value of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
      const task = persistedTask(value, this.#canonicalizeProjectRoot);
      if (task) {
        this.#tasks.set(catalogTaskKey(task), task);
        if (task.projectRoot !== cleanText(value.projectRoot, 2_000)) this.#dirty = true;
      }
    }
    this.#prune();
    return this;
  }

  catalog({
    provider = null,
    nowMs = Date.now(),
    runningFreshnessMs = DEFAULT_RUNNING_FRESHNESS_MS,
  } = {}) {
    const normalizedProvider = provider ? String(provider).toLowerCase() : null;
    return [...this.#tasks.values()]
      .filter((task) => !normalizedProvider || task.provider === normalizedProvider)
      .map((task) => {
        const activityAtMs = Number(task.lastActivityAtMs ?? task.syncedAtMs);
        const running = task.running
          && Number.isFinite(activityAtMs)
          && nowMs - activityAtMs <= runningFreshnessMs;
        return {
          provider: task.provider,
          threadId: task.threadId,
          projectRoot: task.projectRoot,
          projectName: task.projectName,
          title: task.title,
          updatedAtMs: task.updatedAtMs,
          running,
          executionOwner: running ? task.executionOwner : null,
          turnId: running ? task.turnId : null,
          lastActivityAtMs: activityAtMs || null,
        };
      });
  }

  recordCatalog(entries, nowMs = Date.now()) {
    let changed = false;
    for (const entry of Array.isArray(entries) ? entries : []) {
      const key = catalogTaskKey(entry);
      const existing = this.#tasks.get(key) ?? {};
      const next = persistedTask({
        ...existing,
        ...entry,
        syncedAtMs: nowMs,
        history: existing.history,
      }, this.#canonicalizeProjectRoot);
      if (!next) continue;
      if (taskContentChanged(existing, next)) {
        this.#tasks.set(key, next);
        changed = true;
      }
    }
    this.#dirty ||= changed;
    this.#prune();
    return changed;
  }

  recordSnapshot(task, snapshot = {}, {
    executionOwner = null,
    nowMs = Date.now(),
  } = {}) {
    const key = catalogTaskKey(task);
    const existing = this.#tasks.get(key) ?? {};
    const activityAtMs = Number(snapshot.activityAtMs ?? snapshot.modifiedAtMs ?? nowMs) || nowMs;
    const next = persistedTask({
      ...existing,
      ...task,
      title: task.title ?? task.taskTitle ?? existing.title,
      running: snapshot.active === true,
      executionOwner: executionOwner ?? snapshot.executionOwner ?? existing.executionOwner,
      turnId: snapshot.turnId ?? existing.turnId,
      lastActivityAtMs: activityAtMs,
      stage: snapshot.stage ?? existing.stage,
      answer: snapshot.answer ?? existing.answer,
      syncedAtMs: nowMs,
      history: existing.history,
    }, this.#canonicalizeProjectRoot);
    if (!next || !taskContentChanged(existing, next)) return false;
    this.#tasks.set(key, next);
    this.#dirty = true;
    this.#prune();
    return true;
  }

  recordHistory(task, history, snapshot = null, nowMs = Date.now()) {
    const key = catalogTaskKey(task);
    const existing = this.#tasks.get(key) ?? {};
    const next = persistedTask({
      ...existing,
      ...task,
      title: task.title ?? task.taskTitle ?? existing.title,
      running: snapshot ? snapshot.active === true : existing.running === true,
      executionOwner: snapshot?.executionOwner ?? existing.executionOwner,
      turnId: snapshot?.turnId ?? existing.turnId,
      lastActivityAtMs: snapshot?.activityAtMs ?? existing.lastActivityAtMs,
      stage: snapshot?.stage ?? existing.stage,
      answer: snapshot?.answer ?? existing.answer,
      syncedAtMs: nowMs,
      history: cleanHistory(history, this.#historyLimit),
    }, this.#canonicalizeProjectRoot);
    if (!next || !taskContentChanged(existing, next)) return false;
    this.#tasks.set(key, next);
    this.#dirty = true;
    this.#prune();
    return true;
  }

  history(task) {
    const value = this.#tasks.get(catalogTaskKey(task));
    return value ? cleanHistory(value.history, this.#historyLimit) : [];
  }

  snapshot(task, {
    nowMs = Date.now(),
    runningFreshnessMs = DEFAULT_RUNNING_FRESHNESS_MS,
  } = {}) {
    const value = this.#tasks.get(catalogTaskKey(task));
    if (!value) return null;
    const activityAtMs = Number(value.lastActivityAtMs ?? value.syncedAtMs);
    const active = value.running
      && Number.isFinite(activityAtMs)
      && nowMs - activityAtMs <= runningFreshnessMs;
    return {
      active,
      completed: !active,
      turnId: active ? value.turnId : null,
      activityAtMs: activityAtMs || null,
      executionOwner: active ? value.executionOwner : null,
      stage: value.stage,
      answer: value.answer,
    };
  }

  save() {
    if (!this.#dirty) return this.#writeQueue;
    this.#dirty = false;
    const content = `${JSON.stringify({
      version: FORMAT_VERSION,
      updatedAt: new Date().toISOString(),
      tasks: [...this.#tasks.values()],
    }, null, 2)}\n`;
    this.#writeQueue = this.#writeQueue
      .catch(() => {})
      .then(() => writeTextAtomic(this.#filePath, content));
    return this.#writeQueue;
  }
}

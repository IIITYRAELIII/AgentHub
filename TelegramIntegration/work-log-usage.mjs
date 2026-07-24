import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeTextAtomic } from "./state-store.mjs";
import { formatTurnTokenUsage, normalizeTokenUsage } from "./token-usage.mjs";

const WORK_LOG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeWorkLogId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!WORK_LOG_ID_PATTERN.test(id)) {
    throw new Error("work-log id must be a UUID");
  }
  return id;
}

export function workLogTurnKey({ provider = "codex", threadId, turnId }) {
  const normalizedProvider = String(provider ?? "").trim().toLowerCase();
  const normalizedThreadId = String(threadId ?? "").trim();
  const normalizedTurnId = String(turnId ?? "").trim();
  if (!normalizedProvider || !normalizedThreadId || !normalizedTurnId) {
    throw new Error("work-log usage requires provider, threadId and turnId");
  }
  return `${normalizedProvider}\0${normalizedThreadId}\0${normalizedTurnId}`;
}

function normalizedLedger(value = {}) {
  const turns = {};
  for (const [key, record] of Object.entries(value?.turns ?? {})) {
    try {
      const workLogId = normalizeWorkLogId(record?.workLogId);
      turns[key] = {
        workLogId,
        usage: normalizeTokenUsage(record?.usage),
        completedAt: String(record?.completedAt ?? ""),
      };
    } catch {
      // A damaged record is ignored without making the whole ledger unusable.
    }
  }
  return { version: 1, turns };
}

export function formatWorkLogUsage(usage) {
  const telegramText = formatTurnTokenUsage({
    reported: true,
    usage: normalizeTokenUsage(usage),
  }).replace(/^📊\s*/, "");
  return telegramText
    .split("\n")
    .flatMap((line) => line.split(/\s+\|\s+/))
    .join("<br>");
}

export function applyWorkLogUsage(workLogText, workLogId, usage) {
  const id = normalizeWorkLogId(workLogId);
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(<span\\s+data-usage-id=["']${escapedId}["']\\s*>)[\\s\\S]*?(<\\/span>)`,
    "gi",
  );
  const matches = [...String(workLogText ?? "").matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`WORK_LOG must contain exactly one usage placeholder for ${id}; found ${matches.length}`);
  }
  return String(workLogText).replace(
    pattern,
    (_match, opening, closing) => `${opening}${formatWorkLogUsage(usage)}${closing}`,
  );
}

export class WorkLogUsageStore {
  #ledgerFile;
  #loaded = false;
  #ledger = normalizedLedger();
  #tail = Promise.resolve();

  constructor({ ledgerFile }) {
    this.#ledgerFile = path.resolve(ledgerFile);
  }

  async #load() {
    if (this.#loaded) return;
    try {
      this.#ledger = normalizedLedger(JSON.parse(await readFile(this.#ledgerFile, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.#loaded = true;
  }

  recordAndProject({
    provider = "codex",
    threadId,
    turnId,
    workLogId,
    usage,
    usageReported,
    completedAt,
    workLogFile,
  }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      if (usageReported !== true) return { recorded: false, reason: "usage-unavailable" };
      await this.#load();
      const id = normalizeWorkLogId(workLogId);
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      const reusedId = Object.entries(this.#ledger.turns)
        .find(([existingKey, record]) => existingKey !== key && record.workLogId === id);
      if (existing && existing.workLogId !== id) {
        throw new Error(`Turn ${turnId} is already assigned to another WORK_LOG placeholder`);
      }
      if (reusedId) {
        throw new Error(`WORK_LOG placeholder ${id} is already assigned to another turn`);
      }
      if (!existing) {
        const normalizedUsage = normalizeTokenUsage(usage);
        this.#ledger.turns[key] = {
          workLogId: id,
          usage: normalizedUsage,
          completedAt: String(completedAt ?? new Date().toISOString()),
        };
        await mkdir(path.dirname(this.#ledgerFile), { recursive: true });
        await writeTextAtomic(this.#ledgerFile, `${JSON.stringify(this.#ledger, null, 2)}\n`);
      }
      const recordedUsage = this.#ledger.turns[key].usage;
      const logPath = path.resolve(workLogFile);
      const updated = applyWorkLogUsage(await readFile(logPath, "utf8"), id, recordedUsage);
      await writeTextAtomic(logPath, updated);
      return { recorded: !existing, usage: recordedUsage, workLogId: id };
    });
    this.#tail = operation;
    return operation;
  }
}

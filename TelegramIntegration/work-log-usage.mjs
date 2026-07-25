import crypto from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { writeTextAtomic } from "./state-store.mjs";
import {
  addTokenUsage,
  emptyTokenUsage,
  formatConditionalUnits,
  formatTurnTokenUsage,
  normalizeTokenUsage,
  turnConditionalUnits,
} from "./token-usage.mjs";

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
  })
    .replace(/^📊\s*/, "")
    .replace(/^За задачу:\s*/u, "Итого ");
  return telegramText
    .split("\n")
    .flatMap((line) => line.split(/\s+\|\s+/))
    .join("<br>");
}

function formatTaskShare(usage, dayUnits) {
  const taskUnits = turnConditionalUnits(usage);
  const percent = dayUnits > 0 ? Math.round(taskUnits / dayUnits * 100) : 0;
  return formatWorkLogUsage(usage).replace(
    /^(Итого [^<\r\n]+?(?:к|М)ТЭ)/u,
    `$1 (${percent}%)`,
  );
}

function formatTaskUsageDetails(usage, dayUnits) {
  const [total, ...breakdown] = formatTaskShare(usage, dayUnits).split("<br>");
  return `<span data-task-usage>${total}</span>\n`
    + "<details data-task-usage-details><summary>Details</summary>"
    + `<span data-task-usage-breakdown>${breakdown
      .map((part) => `<span data-task-usage-part>${part}</span>`)
      .join("")}</span></details>\n`;
}

function formatDayUsageBreakdown(usage) {
  const [, ...breakdown] = formatWorkLogUsage(usage).split("<br>");
  return `<span data-day-usage-breakdown>${breakdown
    .map((part) => `<span data-day-usage-part>${part}</span>`)
    .join("")}</span>`;
}

function ledgerByWorkLogId(turns = {}) {
  const records = new Map();
  for (const record of Object.values(turns)) {
    const id = normalizeWorkLogId(record?.workLogId);
    if (records.has(id)) throw new Error(`WORK_LOG placeholder ${id} is assigned more than once`);
    records.set(id, { ...record, usage: normalizeTokenUsage(record?.usage) });
  }
  return records;
}

const twoDigits = (part) => String(part).padStart(2, "0");

function formatCompletedAt(value) {
  const completedAt = new Date(String(value ?? ""));
  if (!Number.isFinite(completedAt.getTime())) return "Время неизвестно";
  return `${twoDigits(completedAt.getHours())}:${twoDigits(completedAt.getMinutes())}`;
}

function formatTurnEntry(record) {
  const units = formatConditionalUnits(turnConditionalUnits(record?.usage));
  return `${formatCompletedAt(record?.completedAt)} — ${units}`;
}

function formatLocalDate(value) {
  const date = new Date(String(value ?? ""));
  const resolved = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    twoDigits(resolved.getDate()),
    twoDigits(resolved.getMonth() + 1),
    resolved.getFullYear(),
  ].join(".");
}

function escapeHtmlAttribute(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function daySectionRanges(text) {
  const starts = [...String(text ?? "").matchAll(
    /<details\b[^>]*>\s*<summary[^>]*><strong>(\d{2}\.\d{2}\.\d{4})<\/strong>[\s\S]*?<\/summary>/gi,
  )];
  return starts.map((match, index) => ({
    date: match[1],
    start: match.index,
    end: index + 1 < starts.length ? starts[index + 1].index : String(text).length,
  }));
}

function appendMarkerToRow(row, workLogId) {
  const cells = [...String(row).matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/gi)];
  if (cells.length < 3) throw new Error("WORK_LOG task row must contain a usage cell");
  const usageCell = cells[2];
  const marker = `<span data-usage-id="${workLogId}" hidden>${workLogId}</span>`;
  const updatedCell = usageCell[0].replace(/<\/td>$/i, `\n${marker}</td>`);
  return `${row.slice(0, usageCell.index)}${updatedCell}`
    + row.slice(usageCell.index + usageCell[0].length);
}

function fallbackTaskRow(threadId, workLogId) {
  const escapedThreadId = escapeHtmlAttribute(threadId);
  return [
    `<tr data-work-log-unbound-thread="${escapedThreadId}">`,
    `<td><a href="vscode://openai.chatgpt/local/${escapedThreadId}">Codex - Автоматически учтённые ходы</a></td>`,
    "<td>Расход ходов без зарегистрированного UUID; точная задача не выбрана автоматически.</td>",
    `<td><span data-usage-id="${workLogId}" hidden>${workLogId}</span></td>`,
    "<td data-work-log-turns></td>",
    "</tr>",
  ].join("\n");
}

function workLogDaySection(date, row, open = false) {
  return [
    `<details${open ? " open" : ""}>`,
    `<summary><strong>${date}</strong></summary>`,
    "<table>",
    "<colgroup>",
    "<col data-work-log-task-column>",
    "<col data-work-log-outcome-column>",
    "<col data-work-log-usage-column>",
    "<col data-work-log-turns-column>",
    "</colgroup>",
    "<thead>",
    "<tr>",
    "<th>Задача</th>",
    "<th>Итог <details data-work-log-turns-toggle><summary>Ходы</summary></details></th>",
    "<th>Расход</th>",
    "<th data-work-log-turns></th>",
    "</tr>",
    "</thead>",
    "<tbody>",
    row,
    "</tbody>",
    "</table>",
    "</details>",
  ].join("\n");
}

function attachAutomaticMarker(workLogText, {
  threadId,
  workLogId,
  completedAt,
}) {
  const text = String(workLogText ?? "");
  const date = formatLocalDate(completedAt);
  const range = daySectionRanges(text).find((item) => item.date === date);
  if (!range) {
    const section = workLogDaySection(
      date,
      fallbackTaskRow(threadId, workLogId),
      date === formatLocalDate(new Date()),
    );
    const first = daySectionRanges(text)[0];
    const insertion = first?.start ?? text.length;
    return {
      text: `${text.slice(0, insertion)}${section}\n\n${text.slice(insertion)}`,
      target: "fallback-new-day",
    };
  }

  const section = text.slice(range.start, range.end);
  const escapedThreadId = escapeHtmlAttribute(threadId);
  const linkedRows = [...section.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)]
    .filter((match) => (
      !/\bdata-work-log-unbound-thread=/i.test(match[0])
      && match[0].includes(`href="vscode://openai.chatgpt/local/${escapedThreadId}"`)
    ));
  const fallback = [...section.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)]
    .find((match) => match[0].includes(`data-work-log-unbound-thread="${escapedThreadId}"`));
  const target = linkedRows.length === 1 ? linkedRows[0] : fallback;

  let updatedSection;
  let targetKind;
  if (target) {
    const updatedRow = appendMarkerToRow(target[0], workLogId);
    updatedSection = `${section.slice(0, target.index)}${updatedRow}`
      + section.slice(target.index + target[0].length);
    targetKind = linkedRows.length === 1 ? "exact-thread-row" : "fallback-existing";
  } else {
    const row = fallbackTaskRow(threadId, workLogId);
    if (!/<\/tbody>/i.test(section)) throw new Error(`WORK_LOG day ${date} has no table body`);
    updatedSection = section.replace(/<\/tbody>/i, `${row}\n</tbody>`);
    targetKind = linkedRows.length > 1 ? "fallback-ambiguous" : "fallback-missing";
  }
  return {
    text: `${text.slice(0, range.start)}${updatedSection}${text.slice(range.end)}`,
    target: targetKind,
  };
}

function usageIds(source) {
  return [...source.matchAll(/data-usage-id=["']([^"']+)["']/gi)]
    .map((match) => normalizeWorkLogId(match[1]));
}

function replaceProjectedCells(row, usageContent, turnsContent) {
  const cells = [...row.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/gi)];
  if (cells.length < 3) return row;
  const opening = row.match(/^<tr\b[^>]*>/i)?.[0] ?? "<tr>";
  return `${opening}\n${cells[0][0]}\n${cells[1][0]}\n`
    + `<td data-work-log-usage>${usageContent}</td>\n`
    + `<td data-work-log-turns>${turnsContent}</td>\n</tr>`;
}

function markWorkLogTable(section) {
  let marked = section.replace(/<table\b([^>]*)>/i, (opening, attributes) => (
    /\bdata-work-log-table\b/i.test(attributes)
      ? opening
      : `<table data-work-log-table${attributes}>`
  ));
  marked = marked.replace(
    /<colgroup>[\s\S]*?<\/colgroup>/i,
    [
      "<colgroup>",
      "<col data-work-log-task-column>",
      "<col data-work-log-outcome-column>",
      "<col data-work-log-usage-column>",
      "<col data-work-log-turns-column>",
      "</colgroup>",
    ].join("\n"),
  );
  return marked.replace(
    /<thead>[\s\S]*?<\/thead>/i,
    "<thead>\n<tr><th>Задача</th><th>Итог <details data-work-log-turns-toggle><summary>Ходы</summary></details></th>"
      + "<th>Расход</th><th data-work-log-turns></th></tr>\n</thead>",
  );
}

function markDaySection(section) {
  return section.replace(/^<details\b([^>]*)>/i, (opening, attributes) => (
    /\bdata-work-log-day-section\b/i.test(attributes)
      ? opening
      : `<details data-work-log-day-section${attributes}>`
  ));
}

function projectDaySection(section, date, records) {
  const markedSection = markWorkLogTable(markDaySection(section));
  const rows = [...markedSection.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => {
      const ids = [...new Set(usageIds(match[0]))];
      const recorded = ids.map((id) => records.get(id)).filter(Boolean);
      const usage = recorded.reduce(
        (total, record) => addTokenUsage(total, record.usage),
        emptyTokenUsage(),
      );
      return { match, ids, recorded, usage, units: turnConditionalUnits(usage) };
    })
    .filter((row) => row.ids.length);
  const dayUsage = rows.reduce(
    (total, row) => addTokenUsage(total, row.usage),
    emptyTokenUsage(),
  );
  const dayUnits = rows.reduce((total, row) => total + row.units, 0);

  let projected = markedSection;
  for (const row of rows.reverse()) {
    const visible = row.units > 0
      ? formatTaskUsageDetails(row.usage, dayUnits)
      : "";
    const markers = row.ids.map((id) => (
      `<span data-usage-id="${id}" hidden>${records.has(id) ? "" : id}</span>`
    )).join("\n");
    const turns = [...row.recorded]
      .sort((left, right) => (Date.parse(left.completedAt) || 0) - (Date.parse(right.completedAt) || 0))
      .map(formatTurnEntry)
      .join("<br>\n");
    const replacement = replaceProjectedCells(
      row.match[0],
      `${visible}${markers}`,
      turns,
    );
    projected = `${projected.slice(0, row.match.index)}${replacement}`
      + projected.slice(row.match.index + row.match[0].length);
  }

  const summary = dayUnits > 0
    ? `<summary data-work-log-day><strong>${date}</strong> <span data-day-usage-table>`
      + `<span data-day-usage>Итого ${formatConditionalUnits(dayUnits)}</span>`
      + `${formatDayUsageBreakdown(dayUsage)}</span></summary>`
    : `<summary data-work-log-day><strong>${date}</strong></summary>`;
  return projected.replace(
    /<summary[^>]*>[\s\S]*?<\/summary>(?:\s*(?:<details data-day-usage-details[^>]*>[\s\S]*?<\/details>|<span data-day-usage-breakdown>[\s\S]*?<\/span>))?/i,
    summary,
  );
}

export function projectWorkLogUsage(workLogText, turns = {}) {
  const text = String(workLogText ?? "");
  const records = ledgerByWorkLogId(turns);
  const dayStarts = [...text.matchAll(
    /<details\b[^>]*>\s*<summary[^>]*><strong>(\d{2}\.\d{2}\.\d{4})<\/strong>[\s\S]*?<\/summary>/gi,
  )];
  let projected = text;
  for (let index = dayStarts.length - 1; index >= 0; index -= 1) {
    const start = dayStarts[index].index;
    const end = index + 1 < dayStarts.length ? dayStarts[index + 1].index : text.length;
    const section = text.slice(start, end);
    const replacement = projectDaySection(section, dayStarts[index][1], records);
    projected = `${projected.slice(0, start)}${replacement}${projected.slice(end)}`;
  }
  return projected;
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
  #randomUUID;
  #loaded = false;
  #ledger = normalizedLedger();
  #tail = Promise.resolve();

  constructor({ ledgerFile, randomUUID = crypto.randomUUID } = {}) {
    this.#ledgerFile = path.resolve(ledgerFile);
    this.#randomUUID = randomUUID;
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

  project(workLogFile) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const logPath = path.resolve(workLogFile);
      let current;
      try {
        current = await readFile(logPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return { projected: false, reason: "work-log-missing" };
        throw error;
      }
      const updated = projectWorkLogUsage(current, this.#ledger.turns);
      if (updated === current) return { projected: false, reason: "unchanged" };
      await writeTextAtomic(logPath, updated);
      return { projected: true };
    });
    this.#tail = operation;
    return operation;
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
      const current = await readFile(logPath, "utf8");
      const occurrences = usageIds(current).filter((workLogId) => workLogId === id).length;
      if (occurrences !== 1) {
        throw new Error(`WORK_LOG must contain exactly one usage placeholder for ${id}; found ${occurrences}`);
      }
      const updated = projectWorkLogUsage(current, this.#ledger.turns);
      await writeTextAtomic(logPath, updated);
      return { recorded: !existing, usage: recordedUsage, workLogId: id };
    });
    this.#tail = operation;
    return operation;
  }

  recordAutomaticAndProject({
    provider = "codex",
    threadId,
    turnId,
    usage,
    usageReported,
    completedAt,
    workLogFile,
  }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      if (usageReported !== true) return { recorded: false, reason: "usage-unavailable" };
      if (String(provider).toLowerCase() !== "codex") {
        return { recorded: false, reason: "provider-unsupported" };
      }
      await this.#load();
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      const workLogId = existing?.workLogId ?? normalizeWorkLogId(this.#randomUUID());
      const logPath = path.resolve(workLogFile);
      const current = await readFile(logPath, "utf8");
      const occurrences = usageIds(current).filter((id) => id === workLogId).length;
      const attached = occurrences === 1
        ? { text: current, target: "existing-marker" }
        : attachAutomaticMarker(current, {
          threadId,
          workLogId,
          completedAt,
        });
      if (!existing) {
        this.#ledger.turns[key] = {
          workLogId,
          usage: normalizeTokenUsage(usage),
          completedAt: String(completedAt ?? new Date().toISOString()),
        };
        await mkdir(path.dirname(this.#ledgerFile), { recursive: true });
        await writeTextAtomic(this.#ledgerFile, `${JSON.stringify(this.#ledger, null, 2)}\n`);
      }
      const updated = projectWorkLogUsage(attached.text, this.#ledger.turns);
      await writeTextAtomic(logPath, updated);
      return {
        recorded: !existing,
        usage: this.#ledger.turns[key].usage,
        workLogId,
        target: attached.target,
      };
    });
    this.#tail = operation;
    return operation;
  }
}

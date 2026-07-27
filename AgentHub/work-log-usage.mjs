import crypto from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { readJsonWithBackup, writeTextAtomic } from "./state-store.mjs";
import { displayUserPrompt } from "./task-history.mjs";
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

function normalizeProjectRoot(value, fallback = "") {
  const candidate = String(value ?? fallback).trim();
  return candidate ? path.resolve(candidate) : "";
}

function sameProjectRoot(left, right) {
  const normalizedLeft = normalizeProjectRoot(left);
  const normalizedRight = normalizeProjectRoot(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft === normalizedRight;
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function normalizedLedger(value = {}, { defaultProjectRoot = "" } = {}) {
  const turns = {};
  const invalidRecords = [];
  for (const [key, record] of Object.entries(value?.turns ?? {})) {
    try {
      const keyParts = key.split("\0");
      const provider = keyParts.length >= 3
        ? keyParts[0]
        : String(record?.provider ?? "codex").trim().toLowerCase();
      const threadId = keyParts.length >= 3 ? keyParts[1] : String(record?.threadId ?? "").trim();
      const turnId = keyParts.length >= 3 ? keyParts[2] : String(record?.turnId ?? key).trim();
      if (!provider || !turnId) continue;
      let workLogId = null;
      if (record?.workLogId) workLogId = normalizeWorkLogId(record.workLogId);
      turns[key] = {
        workLogId,
        projectRoot: normalizeProjectRoot(record?.projectRoot, defaultProjectRoot),
        usage: normalizeTokenUsage(record?.usage),
        usageReported: record?.usageReported !== false,
        provider,
        threadId,
        turnId,
        taskTitle: String(record?.taskTitle ?? "").trim(),
        title: String(record?.title ?? "").trim(),
        body: String(record?.body ?? record?.text ?? "").trim(),
        prompt: displayUserPrompt(record?.prompt),
        changedFiles: Array.isArray(record?.changedFiles)
          ? record.changedFiles.map((file) => String(file).trim()).filter(Boolean)
          : [],
        startedAt: String(record?.startedAt ?? ""),
        completedAt: String(record?.completedAt ?? ""),
        status: String(record?.status ?? "completed").trim() || "completed",
      };
    } catch (error) {
      invalidRecords.push({
        key,
        record,
        error: String(error?.message ?? error),
      });
    }
  }
  return { ledger: { version: 3, turns }, invalidRecords };
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
    /^(Итого [^<\r\n]+?(?:Кв|[кМГТПЭЗИР])ТЭ)/u,
    `$1 (${percent}%)`,
  );
}

function alignUsagePercent(text) {
  return String(text).replace(
    /\s+(\([^()]+%\))$/u,
    " <span data-usage-percent>$1</span>",
  );
}

function highlightUsageUnits(text) {
  return String(text).replace(
    /(\d+(?:[  ]\d{3})*(?:,\d+)? ((?:Кв|[кМГТПЭЗИР])ТЭ))/gu,
    (match, _value, unit) => {
      const level = unit === "кТЭ" ? "kilo" : unit === "МТЭ" ? "mega" : "high";
      return `<span data-${level}-usage>${match}</span>`;
    },
  );
}

function formatTaskUsageDetails(usage, dayUnits) {
  const [total, ...breakdown] = formatTaskShare(usage, dayUnits).split("<br>");
  return "<details data-task-usage-details>"
    + `<summary data-task-usage>${highlightUsageUnits(alignUsagePercent(total))}</summary>`
    + `<span data-task-usage-breakdown>${breakdown
      .map((part) => `<span data-task-usage-part>${highlightUsageUnits(alignUsagePercent(part))}</span>`)
      .join("")}</span></details>\n`;
}

function formatDayUsageBreakdown(usage) {
  const [, ...breakdown] = formatWorkLogUsage(usage).split("<br>");
  return `<span data-day-usage-breakdown>${breakdown
    .map((part) => `<span data-day-usage-part>${highlightUsageUnits(alignUsagePercent(part))}</span>`)
    .join("")}</span>`;
}

function ledgerByWorkLogId(turns = {}) {
  const records = new Map();
  for (const record of Object.values(turns)) {
    if (!record?.workLogId) continue;
    const id = normalizeWorkLogId(record?.workLogId);
    if (records.has(id)) throw new Error(`WORK_LOG placeholder ${id} is assigned more than once`);
    records.set(id, { ...record, usage: normalizeTokenUsage(record?.usage) });
  }
  return records;
}

const twoDigits = (part) => String(part).padStart(2, "0");
const WORK_LOG_TURN_TITLE_LIMIT = 100;

function formatCompletedAt(value) {
  const completedAt = new Date(String(value ?? ""));
  if (!Number.isFinite(completedAt.getTime())) return "Время неизвестно";
  return `${twoDigits(completedAt.getHours())}:${twoDigits(completedAt.getMinutes())}`;
}

function formatDuration(startedValue, completedValue) {
  const startedAt = new Date(String(startedValue ?? ""));
  const completedAt = new Date(String(completedValue ?? ""));
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(completedAt.getTime())) {
    return "неизвестно";
  }
  const totalSeconds = Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = totalSeconds % 60;
  return [
    hours ? `${hours} ч` : "",
    minutes ? `${minutes} мин` : "",
    `${seconds} с`,
  ].filter(Boolean).join(" ");
}

function escapeHtmlText(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replace(/\r\n?|\n/g, "<br>");
}

function turnTitle(record) {
  const explicit = String(record?.title ?? "").trim().replace(/\s+/g, " ");
  if (explicit) return explicit.slice(0, WORK_LOG_TURN_TITLE_LIMIT);
  const body = String(record?.body ?? record?.text ?? "").trim().replace(/\s+/g, " ");
  if (!body) return record?.status && record.status !== "completed" ? "Ход остановлен" : "Ход завершён";
  const sentence = body.match(
    new RegExp(`^.{1,${WORK_LOG_TURN_TITLE_LIMIT}}?(?=[.!?](?:\\s|$)|$)`, "u"),
  )?.[0] ?? body.slice(0, WORK_LOG_TURN_TITLE_LIMIT);
  return sentence.trim().replace(/[.!?]+$/u, "") || "Ход завершён";
}

function changedFileLinks(files) {
  return [...new Set(Array.isArray(files) ? files : [])]
    .map((file) => {
      const normalized = String(file).replaceAll("\\", "/");
      return `<a href="${escapeHtmlAttribute(normalized)}">${escapeHtmlText(normalized)}</a>`;
    })
    .join("; ");
}

function formatTurnEntry(record, legacyFiles = "", taskUnits = 0) {
  const recordUnits = record?.usageReported === false ? 0 : turnConditionalUnits(record?.usage);
  const units = record?.usageReported === false
    ? "нет данных"
    : highlightUsageUnits(formatConditionalUnits(recordUnits));
  const share = taskUnits > 0 && record?.usageReported !== false
    ? `${Math.round(recordUnits / taskUnits * 100)}%`
    : "";
  const title = escapeHtmlText(turnTitle(record));
  const body = escapeHtmlText(String(record?.body ?? record?.text ?? "").trim());
  const prompt = escapeHtmlText(displayUserPrompt(record?.prompt));
  const files = changedFileLinks(record?.changedFiles);
  const migratedFiles = String(legacyFiles ?? "").trim();
  const metaDetails = [
    `<div data-work-log-turn-context><strong>Длит.:</strong> ${
      formatDuration(record?.startedAt, record?.completedAt)
    }</div>`,
    prompt ? `<div data-work-log-turn-prompt><strong>Запрос:</strong> ${prompt}</div>` : "",
  ].filter(Boolean).join("");
  const bodyDetails = [
    body ? `<div data-work-log-turn-body>${body}</div>` : "",
    files ? `<div data-work-log-turn-files>${files}</div>` : "",
    migratedFiles
      ? `<div data-work-log-turn-files data-work-log-migrated-files>${migratedFiles}</div>`
      : "",
  ].filter(Boolean).join("");
  return `<tr data-work-log-turn-id="${escapeHtmlAttribute(record?.turnId)}">`
    + '<td colspan="2" data-work-log-turn-row>'
    + "<details data-work-log-turn-details>"
    + "<summary>"
    + '<span data-work-log-turn-meta>'
    + `<span data-work-log-turn-measure>${formatCompletedAt(record?.completedAt)} — ${units}</span>`
    + (share ? `<span data-work-log-turn-share>(${share})</span>` : "")
    + "</span>"
    + `<span data-work-log-turn-title>${title}</span>`
    + "</summary>"
    + '<div data-work-log-turn-expanded>'
    + `<div data-work-log-turn-meta-details>${metaDetails}</div>`
    + `<div data-work-log-turn-body-details>${bodyDetails}</div>`
    + "</div></details></td></tr>";
}

function formatTurnTable(records, legacyOutcome = "", legacyFiles = "") {
  const taskUnits = records.reduce(
    (total, record) => total + (
      record?.usageReported === false ? 0 : turnConditionalUnits(record?.usage)
    ),
    0,
  );
  const legacyFilesTarget = records.findLastIndex((record) => record?.workLogId) >= 0
    ? records.findLastIndex((record) => record?.workLogId)
    : records.length - 1;
  const turnRows = records.map((record, index) => formatTurnEntry(
    record,
    index === legacyFilesTarget ? legacyFiles : "",
    taskUnits,
  ));
  const previousTurns = turnRows.length > 1
    ? [
      '<tr data-work-log-previous-turns-row><td colspan="2">',
      "<details data-work-log-previous-turns>",
      "<summary>",
      `<span data-work-log-previous-turns-closed>Показать предыдущие ходы (${turnRows.length - 1})</span>`,
      '<span data-work-log-previous-turns-open>Свернуть</span>',
      "</summary>",
      "<table data-work-log-previous-turn-table>",
      "<colgroup><col data-work-log-turn-meta-column><col data-work-log-turn-description-column></colgroup>",
      `<tbody>${turnRows.slice(0, -1).join("\n")}</tbody>`,
      "</table>",
      "</details></td></tr>",
    ].join("")
    : "";
  const latestTurn = turnRows.at(-1) ?? "";
  const legacy = legacyOutcome
    ? `<tr data-work-log-legacy-outcome><td colspan="2">${legacyOutcome}</td></tr>`
    : "";
  return [
    "<table data-work-log-turn-table>",
    "<colgroup><col data-work-log-turn-meta-column><col data-work-log-turn-description-column></colgroup>",
    `<tbody>${[previousTurns, latestTurn, legacy].filter(Boolean).join("\n")}</tbody>`,
    "</table>",
  ].join("\n");
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

function topLevelElements(source, tagName) {
  const text = String(source ?? "");
  const tag = String(tagName).replace(/[^a-z0-9]/gi, "");
  const pattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  const ranges = [];
  let depth = 0;
  let start = -1;
  for (const match of text.matchAll(pattern)) {
    const closing = /^<\//.test(match[0]);
    if (!closing) {
      if (depth === 0) start = match.index;
      depth += 1;
      continue;
    }
    if (depth <= 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      const end = match.index + match[0].length;
      ranges.push({ start, end, text: text.slice(start, end) });
      start = -1;
    }
  }
  return ranges;
}

function appendMarkerToRow(row, workLogId) {
  const cells = topLevelElements(row, "td");
  if (cells.length < 2) throw new Error("WORK_LOG task row must contain task and turn cells");
  const usageCell = cells.length >= 3 ? cells[2] : cells[0];
  const marker = `<span data-usage-id="${workLogId}" hidden>${workLogId}</span>`;
  const updatedCell = usageCell.text.replace(/<\/td>$/i, `\n${marker}</td>`);
  return `${row.slice(0, usageCell.start)}${updatedCell}${row.slice(usageCell.end)}`;
}

function taskCell({ provider = "codex", threadId, taskTitle }) {
  const normalizedProvider = String(provider).trim().toLowerCase() || "codex";
  const escapedThreadId = escapeHtmlAttribute(threadId);
  const label = `${normalizedProvider === "claude" ? "Claude" : "Codex"} - ${
    escapeHtmlText(String(taskTitle ?? "").trim() || "Без названия")
  }`;
  return normalizedProvider === "codex"
    ? `<a href="vscode://openai.chatgpt/local/${escapedThreadId}">${label}</a>`
    : label;
}

function taskRow({ provider = "codex", threadId, taskTitle, workLogId = null }) {
  const normalizedProvider = String(provider).trim().toLowerCase() || "codex";
  const escapedThreadId = escapeHtmlAttribute(threadId);
  const escapedProvider = escapeHtmlAttribute(normalizedProvider);
  const marker = workLogId
    ? `<span data-usage-id="${workLogId}" hidden>${workLogId}</span>`
    : "";
  return [
    `<tr data-work-log-provider="${escapedProvider}" data-work-log-thread-id="${escapedThreadId}">`,
    '<td data-work-log-task-cell>',
    `<div data-work-log-task-content>${taskCell({ provider: normalizedProvider, threadId, taskTitle })}</div>`,
    `<div data-work-log-usage>${marker}</div>`,
    "</td>",
    "<td data-work-log-turn-list></td>",
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
    "<col data-work-log-turn-list-column>",
    "</colgroup>",
    "<thead>",
    "<tr>",
    "<th>Задача</th>",
    "<th>Ходы</th>",
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
  provider = "codex",
  threadId,
  workLogId,
  taskTitle = "Автоматически учтённые ходы",
  completedAt,
}) {
  const text = String(workLogText ?? "");
  const date = formatLocalDate(completedAt);
  const range = daySectionRanges(text).find((item) => item.date === date);
  if (!range) {
    const section = workLogDaySection(
      date,
      taskRow({ provider, threadId, taskTitle, workLogId }),
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
  const linkedRows = topLevelElements(section, "tr")
    .filter((match) => (
      !/\bdata-work-log-thread-id=/i.test(match.text)
      && match.text.includes(`href="vscode://openai.chatgpt/local/${escapedThreadId}"`)
    ));
  const fallback = topLevelElements(section, "tr")
    .find((match) => match.text.includes(`data-work-log-thread-id="${escapedThreadId}"`));
  const target = linkedRows.length === 1 ? linkedRows[0] : fallback;

  let updatedSection;
  let targetKind;
  if (target) {
    const updatedRow = appendMarkerToRow(target.text, workLogId);
    updatedSection = `${section.slice(0, target.start)}${updatedRow}${section.slice(target.end)}`;
    targetKind = linkedRows.length === 1 ? "exact-thread-row" : "fallback-existing";
  } else {
    const row = taskRow({ provider, threadId, taskTitle, workLogId });
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

function changedFilesContent(source) {
  const text = String(source ?? "");
  return text.match(
    /<div\b[^>]*data-work-log-legacy-files[^>]*>([\s\S]*?)<\/div>/iu,
  )?.[1]?.trim() ?? text.match(
    /<div\b[^>]*data-work-log-migrated-files[^>]*>([\s\S]*?)<\/div>/iu,
  )?.[1]?.trim() ?? text.match(
    /<details\b[^>]*>\s*<summary\b[^>]*>\s*Изменённые файлы\s*<\/summary>([\s\S]*?)<\/details>/iu,
  )?.[1]?.trim() ?? "";
}

function legacyOutcome(source) {
  const explicit = String(source ?? "").match(
    /<tr\b[^>]*data-work-log-legacy-outcome[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/iu,
  )?.[1]?.trim();
  if (explicit) return explicit;
  const restored = String(source ?? "").match(
    /<div\b[^>]*data-work-log-restored-outcome[^>]*>([\s\S]*?)<\/div>/iu,
  )?.[1]?.trim();
  if (restored) return restored;
  const cell = String(source ?? "")
    .replace(/^<td\b[^>]*>/i, "")
    .replace(/<\/td>$/i, "")
    .replace(/<table\b[^>]*data-work-log-turn-table[^>]*>[\s\S]*?<\/table>/giu, "")
    .replace(/<div\b[^>]*data-work-log-turn[^>]*>[\s\S]*?<\/div>/giu, "")
    .replace(/<div\b[^>]*data-work-log-legacy-files[^>]*>[\s\S]*?<\/div>/giu, "")
    .replace(/<details\b[^>]*>\s*<summary\b[^>]*>\s*Изменённые файлы\s*<\/summary>[\s\S]*?<\/details>/giu, "")
    .trim();
  return cell;
}

function taskCellKey(source) {
  return taskCellContent(source)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cellInner(source) {
  return String(source ?? "").replace(/^<td\b[^>]*>/i, "").replace(/<\/td>$/i, "").trim();
}

function taskCellContent(source) {
  const text = String(source ?? "");
  const explicit = text.match(
    /<div\b[^>]*data-work-log-task-content[^>]*>([\s\S]*?)<\/div>/iu,
  )?.[1]?.trim();
  if (explicit) return explicit;
  return cellInner(text)
    .replace(/<div\b[^>]*data-work-log-usage[^>]*>[\s\S]*?<\/div>/giu, "")
    .replace(/<span\b[^>]*data-usage-id[^>]*>[\s\S]*?<\/span>/giu, "")
    .trim();
}

export function restoreLegacyOutcomes(workLogText, previousWorkLogText) {
  const outcomes = new Map();
  for (const range of daySectionRanges(previousWorkLogText)) {
    const section = String(previousWorkLogText).slice(range.start, range.end);
    for (const row of topLevelElements(section, "tr")) {
      const cells = topLevelElements(row.text, "td");
      if (cells.length < 2) continue;
      const outcome = cellInner(cells[1].text)
        .replace(/<details\b[^>]*>\s*<summary\b[^>]*>\s*Изменённые файлы\s*<\/summary>[\s\S]*?<\/details>/giu, "")
        .trim();
      if (!outcome) continue;
      outcomes.set(`${range.date}\0${taskCellKey(cells[0].text)}`, outcome);
    }
  }
  let updated = String(workLogText ?? "");
  for (const range of daySectionRanges(updated).reverse()) {
    let section = updated.slice(range.start, range.end);
    for (const row of topLevelElements(section, "tr").reverse()) {
      const cells = topLevelElements(row.text, "td");
      if (cells.length < 2 || legacyOutcome(cells[1].text)) continue;
      const outcome = outcomes.get(`${range.date}\0${taskCellKey(cells[0].text)}`);
      if (!outcome) continue;
      const replacementCell = cells[1].text.replace(
        /<\/td>$/i,
        `\n<div data-work-log-restored-outcome>${outcome}</div></td>`,
      );
      const replacementRow = `${row.text.slice(0, cells[1].start)}${replacementCell}`
        + row.text.slice(cells[1].end);
      section = `${section.slice(0, row.start)}${replacementRow}${section.slice(row.end)}`;
    }
    updated = `${updated.slice(0, range.start)}${section}${updated.slice(range.end)}`;
  }
  return updated;
}

function rowIdentity(row) {
  const opening = String(row).match(/^<tr\b[^>]*>/i)?.[0] ?? "";
  const provider = opening.match(/\bdata-work-log-provider=["']([^"']+)["']/i)?.[1]?.trim().toLowerCase();
  const threadId = opening.match(/\bdata-work-log-thread-id=["']([^"']+)["']/i)?.[1]?.trim();
  return provider && threadId ? { provider, threadId } : null;
}

function linkedThreadId(row) {
  return String(row).match(/href=["']vscode:\/\/openai\.chatgpt\/local\/([^"']+)["']/i)?.[1] ?? "";
}

function withRowIdentity(row, { provider, threadId }) {
  if (rowIdentity(row)) return row;
  return String(row).replace(
    /^<tr\b([^>]*)>/i,
    `<tr data-work-log-provider="${escapeHtmlAttribute(provider)}" data-work-log-thread-id="${
      escapeHtmlAttribute(threadId)
    }"$1>`,
  );
}

function automaticRecordsForDay(turns, date) {
  return Object.values(turns)
    .filter((record) => (
      !record.workLogId
      && formatLocalDate(record.completedAt) === date
      && record.provider
      && record.threadId
    ));
}

function ensureCanonicalRows(section, date, turns) {
  let updated = String(section);
  const groups = new Map();
  for (const record of automaticRecordsForDay(turns, date)) {
    const key = `${record.provider}\0${record.threadId}`;
    const values = groups.get(key) ?? [];
    values.push(record);
    groups.set(key, values);
  }
  for (const [key, records] of groups) {
    const [provider, threadId] = key.split("\0");
    const rows = topLevelElements(updated, "tr").filter((row) => topLevelElements(row.text, "td").length >= 2);
    if (rows.some((row) => {
      const identity = rowIdentity(row.text);
      return identity?.provider === provider && identity.threadId === threadId;
    })) continue;
    const linked = provider === "codex"
      ? rows.filter((row) => linkedThreadId(row.text) === threadId)
      : [];
    if (linked.length === 1) {
      const target = linked[0];
      const replacement = withRowIdentity(target.text, { provider, threadId });
      updated = `${updated.slice(0, target.start)}${replacement}${updated.slice(target.end)}`;
      continue;
    }
    const latest = [...records].sort(
      (left, right) => (Date.parse(left.completedAt) || 0) - (Date.parse(right.completedAt) || 0),
    ).at(-1);
    const row = taskRow({
      provider,
      threadId,
      taskTitle: latest?.taskTitle,
    });
    const insertion = updated.lastIndexOf("</tbody>");
    if (insertion < 0) throw new Error(`WORK_LOG day ${date} has no table body`);
    updated = `${updated.slice(0, insertion)}${row}\n${updated.slice(insertion)}`;
  }
  const rows = topLevelElements(updated, "tr")
    .filter((row) => topLevelElements(row.text, "td").length >= 2);
  const linkedRows = new Map();
  for (const row of rows) {
    if (rowIdentity(row.text)) continue;
    const threadId = linkedThreadId(row.text);
    if (!threadId) continue;
    const values = linkedRows.get(threadId) ?? [];
    values.push(row);
    linkedRows.set(threadId, values);
  }
  const datedTurns = Object.values(turns).filter((record) => formatLocalDate(record.completedAt) === date);
  const identityTargets = [];
  for (const [threadId, matches] of linkedRows) {
    if (matches.length !== 1) continue;
    if (!datedTurns.some((record) => record.provider === "codex" && record.threadId === threadId)) {
      continue;
    }
    identityTargets.push({ target: matches[0], threadId });
  }
  for (const { target, threadId } of identityTargets.sort(
    (left, right) => right.target.start - left.target.start,
  )) {
    const replacement = withRowIdentity(target.text, { provider: "codex", threadId });
    updated = `${updated.slice(0, target.start)}${replacement}${updated.slice(target.end)}`;
  }
  return updated;
}

function replaceProjectedCells(row, usageContent, records) {
  const cells = topLevelElements(row, "td");
  if (cells.length < 2) return row;
  const opening = row.match(/^<tr\b[^>]*>/i)?.[0] ?? "<tr>";
  const turnCell = cells.find((cell) => /\bdata-work-log-turn-list\b/i.test(cell.text)) ?? cells[1];
  const changedFiles = changedFilesContent(turnCell.text);
  const outcome = legacyOutcome(turnCell.text);
  const turnTable = records.length || outcome
    ? formatTurnTable(records, outcome, changedFiles)
    : "";
  const turnList = turnTable || (
    changedFiles ? `<div data-work-log-legacy-files>${changedFiles}</div>` : ""
  );
  const identity = rowIdentity(row);
  const latest = [...records].sort(
    (left, right) => (Date.parse(left.completedAt) || 0) - (Date.parse(right.completedAt) || 0),
  ).at(-1);
  const task = identity && latest?.taskTitle
    ? taskCell({ ...identity, taskTitle: latest.taskTitle })
    : taskCellContent(cells[0].text);
  return `${opening}\n<td data-work-log-task-cell>`
    + `<div data-work-log-task-content>${task}</div>`
    + `<div data-work-log-usage>${usageContent}</div></td>\n`
    + `<td data-work-log-turn-list>${turnList}</td>\n</tr>`;
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
      "<col data-work-log-turn-list-column>",
      "</colgroup>",
    ].join("\n"),
  );
  return marked.replace(
    /<thead>[\s\S]*?<\/thead>/i,
    "<thead>\n<tr><th>Задача</th><th>Ходы</th></tr>\n</thead>",
  );
}

function markDaySection(section) {
  return section.replace(/^<details\b([^>]*)>/i, (opening, attributes) => (
    /\bdata-work-log-day-section\b/i.test(attributes)
      ? opening
      : `<details data-work-log-day-section${attributes}>`
  ));
}

function projectDaySection(section, date, turns, recordsById) {
  const markedSection = markWorkLogTable(markDaySection(ensureCanonicalRows(section, date, turns)));
  const rows = topLevelElements(markedSection, "tr")
    .filter((match) => topLevelElements(match.text, "td").length >= 2)
    .map((match) => {
      const ids = [...new Set(usageIds(match.text))];
      const identity = rowIdentity(match.text);
      const legacyRecords = ids.map((id) => recordsById.get(id)).filter(Boolean);
      const automaticRecords = identity
        ? automaticRecordsForDay(turns, date).filter((record) => (
          record.provider === identity.provider && record.threadId === identity.threadId
        ))
        : [];
      const seen = new Set();
      const recorded = [...legacyRecords, ...automaticRecords].filter((record) => {
        const key = `${record.provider}\0${record.threadId}\0${record.turnId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const usage = recorded.reduce(
        (total, record) => record.usageReported === false
          ? total
          : addTokenUsage(total, record.usage),
        emptyTokenUsage(),
      );
      const cells = topLevelElements(match.text, "td");
      const turnCell = cells.find(
        (cell) => /\bdata-work-log-turn-list\b/i.test(cell.text),
      ) ?? cells[1];
      return {
        match,
        ids,
        recorded,
        usage,
        units: turnConditionalUnits(usage),
        identity,
        hasLegacyOutcome: Boolean(legacyOutcome(turnCell?.text)),
      };
    })
    .filter((row) => row.ids.length || row.recorded.length || row.hasLegacyOutcome);
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
      `<span data-usage-id="${id}" hidden>${recordsById.has(id) ? "" : id}</span>`
    )).join("\n");
    const turnsContent = [...row.recorded]
      .sort((left, right) => (Date.parse(left.completedAt) || 0) - (Date.parse(right.completedAt) || 0))
    const replacement = replaceProjectedCells(row.match.text, `${visible}${markers}`, turnsContent);
    projected = `${projected.slice(0, row.match.start)}${replacement}${projected.slice(row.match.end)}`;
  }

  const summary = dayUnits > 0
    ? `<summary data-work-log-day><strong>${date}</strong> <span data-day-usage-table>`
      + `<span data-day-usage>Итого ${highlightUsageUnits(formatConditionalUnits(dayUnits))}</span>`
      + `${formatDayUsageBreakdown(dayUsage)}</span></summary>`
    : `<summary data-work-log-day><strong>${date}</strong></summary>`;
  return projected.replace(
    /<summary[^>]*>[\s\S]*?<\/summary>(?:\s*(?:<details data-day-usage-details[^>]*>[\s\S]*?<\/details>|<span data-day-usage-breakdown>[\s\S]*?<\/span>))?/i,
    summary,
  );
}

export function projectWorkLogUsage(workLogText, turns = {}) {
  let text = String(workLogText ?? "");
  const normalizedTurns = normalizedLedger({ turns }).ledger.turns;
  const records = ledgerByWorkLogId(normalizedTurns);
  const existingDates = new Set(daySectionRanges(text).map((range) => range.date));
  const requiredDates = [...new Set(Object.values(normalizedTurns)
    .filter((record) => !record.workLogId)
    .map((record) => formatLocalDate(record.completedAt))
    .filter(Boolean))]
    .filter((date) => !existingDates.has(date))
    .sort((left, right) => {
      const [ld, lm, ly] = left.split(".").map(Number);
      const [rd, rm, ry] = right.split(".").map(Number);
      return Date.UTC(ry, rm - 1, rd) - Date.UTC(ly, lm - 1, ld);
    });
  for (const date of requiredDates.reverse()) {
    const section = workLogDaySection(date, "", date === formatLocalDate(new Date()));
    const first = daySectionRanges(text)[0];
    const insertion = first?.start ?? text.length;
    text = `${text.slice(0, insertion)}${section}\n\n${text.slice(insertion)}`;
  }
  const dayStarts = [...text.matchAll(
    /<details\b[^>]*>\s*<summary[^>]*><strong>(\d{2}\.\d{2}\.\d{4})<\/strong>[\s\S]*?<\/summary>/gi,
  )];
  let projected = text;
  for (let index = dayStarts.length - 1; index >= 0; index -= 1) {
    const start = dayStarts[index].index;
    const end = index + 1 < dayStarts.length ? dayStarts[index + 1].index : text.length;
    const section = text.slice(start, end);
    const replacement = projectDaySection(section, dayStarts[index][1], normalizedTurns, records);
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

function incomingLedgerRecord({
  provider = "codex",
  threadId,
  turnId,
  projectRoot,
  workLogId = null,
  usage,
  usageReported,
  taskTitle,
  title,
  body,
  text,
  prompt,
  changedFiles,
  startedAt,
  completedAt,
  status,
}) {
  return {
    workLogId,
    projectRoot: normalizeProjectRoot(projectRoot),
    usage: normalizeTokenUsage(usage),
    usageReported: usageReported === true,
    provider: String(provider).trim().toLowerCase(),
    threadId: String(threadId).trim(),
    turnId: String(turnId).trim(),
    taskTitle: String(taskTitle ?? "").trim(),
    title: String(title ?? "").trim(),
    body: String(body ?? text ?? "").trim(),
    prompt: displayUserPrompt(prompt),
    changedFiles: Array.isArray(changedFiles)
      ? changedFiles.map((file) => String(file).trim()).filter(Boolean)
      : [],
    startedAt: String(startedAt ?? ""),
    completedAt: String(completedAt ?? new Date().toISOString()),
    status: String(status ?? "completed").trim() || "completed",
  };
}

function mergeLedgerRecord(existing, incoming) {
  if (!existing) return incoming;
  if (incoming.workLogId) existing.workLogId = incoming.workLogId;
  if (incoming.usageReported || !existing.usageReported) {
    existing.usage = incoming.usage;
    existing.usageReported = incoming.usageReported;
  }
  for (const field of [
    "projectRoot",
    "provider",
    "threadId",
    "turnId",
    "taskTitle",
    "title",
    "body",
    "prompt",
    "changedFiles",
    "startedAt",
    "completedAt",
  ]) {
    if (field === "changedFiles") {
      if (incoming.changedFiles.length) existing.changedFiles = incoming.changedFiles;
    } else if (incoming[field]) {
      existing[field] = incoming[field];
    }
  }
  if (incoming.status && (incoming.status !== "unknown" || !existing.status || existing.status === "unknown")) {
    existing.status = incoming.status;
  }
  return existing;
}

export class WorkLogUsageStore {
  #ledgerFile;
  #backupFile;
  #quarantineFile;
  #defaultProjectRoot;
  #randomUUID;
  #loaded = false;
  #ledger = normalizedLedger().ledger;
  #tail = Promise.resolve();

  constructor({
    ledgerFile,
    defaultProjectRoot = "",
    randomUUID = crypto.randomUUID,
  } = {}) {
    this.#ledgerFile = path.resolve(ledgerFile);
    this.#backupFile = `${this.#ledgerFile}.bak`;
    this.#quarantineFile = `${this.#ledgerFile}.invalid-records.json`;
    this.#defaultProjectRoot = normalizeProjectRoot(defaultProjectRoot);
    this.#randomUUID = randomUUID;
  }

  async #load() {
    if (this.#loaded) return;
    const loaded = await readJsonWithBackup(this.#ledgerFile, {
      backupFile: this.#backupFile,
    });
    const persisted = loaded.value ?? {};
    const normalized = normalizedLedger(persisted, {
      defaultProjectRoot: this.#defaultProjectRoot,
    });
    this.#ledger = normalized.ledger;
    if (normalized.invalidRecords.length) {
      await mkdir(path.dirname(this.#quarantineFile), { recursive: true });
      await writeTextAtomic(
        this.#quarantineFile,
        `${JSON.stringify({
          detectedAt: new Date().toISOString(),
          source: loaded.source,
          records: normalized.invalidRecords,
        }, null, 2)}\n`,
      );
      console.error(
        `Quarantined ${normalized.invalidRecords.length} invalid work-log ledger record(s) in ${this.#quarantineFile}`,
      );
    }
    this.#loaded = true;
    const migrated = Number(persisted?.version ?? 0) !== this.#ledger.version
      || Object.entries(persisted?.turns ?? {}).some(
        ([key, record]) => (
          String(record?.prompt ?? "").trim() !== String(this.#ledger.turns[key]?.prompt ?? "")
          || normalizeProjectRoot(record?.projectRoot) !== this.#ledger.turns[key]?.projectRoot
        ),
      );
    if (loaded.recovered || migrated || normalized.invalidRecords.length) await this.#save();
  }

  async #save() {
    await mkdir(path.dirname(this.#ledgerFile), { recursive: true });
    const content = `${JSON.stringify(this.#ledger, null, 2)}\n`;
    await writeTextAtomic(this.#ledgerFile, content);
    await writeTextAtomic(this.#backupFile, content);
  }

  mergeTurnTexts(messages = []) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      let updated = 0;
      for (const message of messages) {
        const text = String(message?.text ?? "").trim();
        const title = String(message?.title ?? "").trim();
        let records = [];
        if (message?.workLogId) {
          try {
            const workLogId = normalizeWorkLogId(message.workLogId);
            records = Object.values(this.#ledger.turns)
              .filter((record) => record.workLogId === workLogId);
          } catch {
            records = [];
          }
        } else if (message?.provider && message?.threadId && message?.turnId) {
          const key = workLogTurnKey(message);
          if (this.#ledger.turns[key]) records = [this.#ledger.turns[key]];
        }
        if (records.length !== 1) continue;
        const record = records[0];
        if (record.body === text && record.title === title) continue;
        if (text) record.body = text;
        if (title) record.title = title;
        updated += 1;
      }
      if (updated) await this.#save();
      return { updated };
    });
    this.#tail = operation;
    return operation;
  }

  project(workLogFile, { projectRoot = this.#defaultProjectRoot } = {}) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const logPath = path.resolve(workLogFile);
      const selectedTurns = Object.fromEntries(
        Object.entries(this.#ledger.turns).filter(([, record]) => (
          sameProjectRoot(record.projectRoot, projectRoot)
        )),
      );
      let current;
      try {
        current = await readFile(logPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") current = "# Глобальный журнал работ\n";
        else throw error;
      }
      const updated = projectWorkLogUsage(current, selectedTurns);
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
    projectRoot = this.#defaultProjectRoot,
    workLogId,
    usage,
    usageReported,
    taskTitle,
    title,
    body,
    prompt,
    changedFiles,
    startedAt,
    completedAt,
    status,
    text,
    workLogFile,
  }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const id = normalizeWorkLogId(workLogId);
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      const reusedId = Object.entries(this.#ledger.turns)
        .find(([existingKey, record]) => existingKey !== key && record.workLogId === id);
      if (existing?.workLogId && existing.workLogId !== id) {
        throw new Error(`Turn ${turnId} is already assigned to another WORK_LOG placeholder`);
      }
      if (reusedId) {
        throw new Error(`WORK_LOG placeholder ${id} is already assigned to another turn`);
      }
      const incoming = incomingLedgerRecord({
        provider,
        threadId,
        turnId,
        projectRoot,
        workLogId: id,
        usage,
        usageReported,
        taskTitle,
        title,
        body,
        text,
        prompt,
        changedFiles,
        startedAt,
        completedAt,
        status,
      });
      this.#ledger.turns[key] = mergeLedgerRecord(existing, incoming);
      await this.#save();
      const recordedUsage = this.#ledger.turns[key].usage;
      const logPath = path.resolve(workLogFile);
      try {
        const current = await readFile(logPath, "utf8");
        const occurrences = usageIds(current).filter((workLogId) => workLogId === id).length;
        if (occurrences !== 1) {
          throw new Error(`WORK_LOG must contain exactly one usage placeholder for ${id}; found ${occurrences}`);
        }
        const selectedTurns = Object.fromEntries(
          Object.entries(this.#ledger.turns).filter(([, record]) => (
            sameProjectRoot(record.projectRoot, projectRoot)
          )),
        );
        const updated = projectWorkLogUsage(current, selectedTurns);
        await writeTextAtomic(logPath, updated);
        return { recorded: !existing, usage: recordedUsage, workLogId: id, projected: true };
      } catch (error) {
        return {
          recorded: !existing,
          usage: recordedUsage,
          workLogId: id,
          projected: false,
          projectionError: String(error?.message ?? error),
        };
      }
    });
    this.#tail = operation;
    return operation;
  }

  recordAutomaticAndProject({
    provider = "codex",
    threadId,
    turnId,
    projectRoot = this.#defaultProjectRoot,
    usage,
    usageReported,
    taskTitle,
    title,
    body,
    prompt,
    changedFiles,
    startedAt,
    completedAt,
    status,
    text,
    workLogFile,
  }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      const logPath = path.resolve(workLogFile);
      const incoming = incomingLedgerRecord({
        provider,
        threadId,
        turnId,
        projectRoot,
        usage,
        usageReported,
        taskTitle,
        title,
        body,
        text,
        prompt,
        changedFiles,
        startedAt,
        completedAt,
        status,
      });
      this.#ledger.turns[key] = mergeLedgerRecord(existing, incoming);
      await this.#save();
      try {
        let current;
        current = await readFile(logPath, "utf8");
        const selectedTurns = Object.fromEntries(
          Object.entries(this.#ledger.turns).filter(([, record]) => (
            sameProjectRoot(record.projectRoot, projectRoot)
          )),
        );
        const updated = projectWorkLogUsage(current, selectedTurns);
        await writeTextAtomic(logPath, updated);
        return {
          recorded: !existing,
          usage: this.#ledger.turns[key].usage,
          workLogId: null,
          target: "thread-day-row",
          projected: true,
        };
      } catch (error) {
        if (error?.code === "ENOENT") {
          try {
            const selectedTurns = Object.fromEntries(
              Object.entries(this.#ledger.turns).filter(([, record]) => (
                sameProjectRoot(record.projectRoot, projectRoot)
              )),
            );
            const created = projectWorkLogUsage("# Глобальный журнал работ\n", selectedTurns);
            await writeTextAtomic(logPath, created);
            return {
              recorded: !existing,
              usage: this.#ledger.turns[key].usage,
              workLogId: null,
              target: "thread-day-row",
              projected: true,
              createdWorkLog: true,
            };
          } catch (createError) {
            error = createError;
          }
        }
        return {
          recorded: !existing,
          usage: this.#ledger.turns[key].usage,
          workLogId: null,
          target: "thread-day-row",
          projected: false,
          projectionError: String(error?.message ?? error),
        };
      }
    });
    this.#tail = operation;
    return operation;
  }
}

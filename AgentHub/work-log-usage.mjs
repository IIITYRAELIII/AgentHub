import crypto from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  estimateMissingCodexUsage,
  looksLikeImageGenerationPrompt,
} from "./codex-usage-estimate.mjs";
import { isInheritedSubagentTurn } from "./codex-subagent-accounting.mjs";
import { readJsonWithBackup, writeTextAtomic } from "./state-store.mjs";
import { displayUserPrompt } from "./task-history.mjs";
import {
  appendLedgerEvents,
  applyLedgerDelta,
  ledgerRecordChanges,
  ledgerRecordSnapshot,
} from "./incremental-ledger.mjs";
import {
  addCreditBreakdown,
  emptyCreditBreakdown,
  formatCredits,
  formatTaskCreditBreakdown,
  normalizeServiceTier,
  normalizeTokenUsage,
  turnCreditBreakdown,
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

function normalizeEstimatedCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) && credits > 0 ? credits : 0;
}

function recordCreditBreakdown(record) {
  return turnCreditBreakdown(
    record?.usageReported === false ? null : record?.usage,
    {
      // Ledgers written before v6 have no model. Price them temporarily as Sol
      // so the journal remains usable while the startup backfill reads the exact
      // model and Fast tier from each rollout.
      model: record?.model || "gpt-5.6-sol",
      serviceTier: record?.serviceTier,
      estimatedCredits: normalizeEstimatedCredits(record?.estimatedCredits),
    },
  );
}

function recordCredits(record) {
  return recordCreditBreakdown(record).total;
}

function normalizedLedger(value = {}, { defaultProjectRoot = "" } = {}) {
  const sourceVersion = Number(value?.version ?? 0);
  const legacyLedger = sourceVersion < 5;
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
      const taskThreadId = String(record?.taskThreadId ?? threadId).trim() || threadId;
      if (isInheritedSubagentTurn({
        aggregateOnly: record?.aggregateOnly,
        threadId,
        turnId,
      })) {
        throw new Error("inherited parent turn was copied into a subagent rollout");
      }
      const prompt = displayUserPrompt(record?.prompt);
      const status = String(record?.status ?? "completed").trim() || "completed";
      const usageReported = record?.usageReported !== false;
      const estimate = provider === "codex"
        ? estimateMissingCodexUsage({
          status,
          usageReported,
          prompt,
          imageGenerationCount: record?.imageGenerationCount,
        })
        : null;
      let workLogId = null;
      if (record?.workLogId) workLogId = normalizeWorkLogId(record.workLogId);
      turns[key] = {
        workLogId,
        projectRoot: normalizeProjectRoot(record?.projectRoot, defaultProjectRoot),
        usage: normalizeTokenUsage(record?.usage),
        usageReported,
        estimatedCredits: normalizeEstimatedCredits(
          record?.estimatedCredits
            ?? (sourceVersion < 6 && record?.estimatedUnits != null
              ? Number(record.estimatedUnits) / 8_000
              : estimate?.estimatedCredits),
        ),
        estimateKind: String(record?.estimateKind ?? estimate?.estimateKind ?? "").trim(),
        model: String(record?.model ?? "").trim().toLowerCase(),
        serviceTier: normalizeServiceTier(record?.serviceTier ?? record?.service_tier),
        pricingMetadataResolved: sourceVersion >= 7
          && record?.pricingMetadataResolved === true,
        provider,
        threadId,
        taskThreadId,
        parentThreadId: String(record?.parentThreadId ?? "").trim(),
        aggregateOnly: record?.aggregateOnly === true,
        provisional: record?.provisional === true || (
          legacyLedger
          && String(record?.status ?? "") === "aborted"
          && String(record?.title ?? "") === "Ход остановлен пользователем"
          && String(record?.body ?? record?.text ?? "") === "Ход остановлен пользователем."
        ),
        turnId,
        taskTitle: String(record?.taskTitle ?? "").trim(),
        title: String(record?.title ?? "").trim(),
        body: String(record?.body ?? record?.text ?? "").trim(),
        prompt,
        changedFiles: Array.isArray(record?.changedFiles)
          ? record.changedFiles.map((file) => String(file).trim()).filter(Boolean)
          : [],
        diff: String(record?.diff ?? ""),
        startedAt: String(record?.startedAt ?? ""),
        completedAt: String(record?.completedAt ?? ""),
        status,
      };
    } catch (error) {
      invalidRecords.push({
        key,
        record,
        error: String(error?.message ?? error),
      });
    }
  }
  return { ledger: { version: 7, turns }, invalidRecords };
}

export function formatWorkLogUsage(breakdown) {
  const telegramText = formatTaskCreditBreakdown(breakdown)
    .replace(/^📊\s*/, "")
    .replace(/^За задачу:\s*/u, "Итого ");
  return telegramText
    .split("\n")
    .flatMap((line) => line.split(/\s+\|\s+/))
    .join("<br>");
}

function formatTaskShare(breakdown, dayCredits) {
  const taskCredits = Number(breakdown?.total) || 0;
  const percent = dayCredits > 0 ? Math.round(taskCredits / dayCredits * 100) : 0;
  return formatWorkLogUsage(breakdown).replace(
    /^(Итого [^<\r\n]+?(?:Gcr|Mcr|kcr|cr))/u,
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
    /(\d+(?:[  ]\d{3})*(?:,\d+)? (Gcr|Mcr|kcr|cr))/gu,
    (match, _value, unit) => {
      const level = unit === "cr" ? "kilo" : unit === "kcr" ? "mega" : "high";
      return `<span data-${level}-usage>${match}</span>`;
    },
  );
}

function markUsageLabel(text) {
  return String(text).replace(
    /^Итого\s+/u,
    "<span data-usage-label>Итого</span> ",
  );
}

function formatTaskUsageDetails(creditBreakdown, dayCredits) {
  const [total, ...breakdown] = formatTaskShare(creditBreakdown, dayCredits).split("<br>");
  const totalHtml = highlightUsageUnits(alignUsagePercent(markUsageLabel(total))).replace(
    /(<span\b[^>]*data-(?:kilo|mega|high)-usage)/u,
    `$1 data-usage-credits="${escapeHtmlAttribute(String(creditBreakdown.total))}"`,
  );
  return "<details data-task-usage-details>"
    + `<summary data-task-usage>${totalHtml}</summary>`
    + `<span data-task-usage-breakdown>${breakdown
      .map((part) => `<span data-task-usage-part>${highlightUsageUnits(alignUsagePercent(part))}</span>`)
      .join("")}</span></details>\n`;
}

function formatDayUsageBreakdown(creditBreakdown) {
  const [, ...breakdown] = formatWorkLogUsage(creditBreakdown).split("<br>");
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

function durationSeconds(startedValue, completedValue) {
  const startedAt = new Date(String(startedValue ?? ""));
  const completedAt = new Date(String(completedValue ?? ""));
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(completedAt.getTime())) {
    return null;
  }
  return Math.max(0, Math.round((completedAt.getTime() - startedAt.getTime()) / 1000));
}

function formatDuration(startedValue, completedValue) {
  const totalSeconds = durationSeconds(startedValue, completedValue);
  if (totalSeconds === null) return "неизвестно";
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
  const prefix = record?.aggregateOnly === true ? "Субагент · " : "";
  const titleLimit = Math.max(1, WORK_LOG_TURN_TITLE_LIMIT - prefix.length);
  const explicit = String(record?.title ?? "").trim().replace(/\s+/g, " ");
  if (explicit) return `${prefix}${explicit.slice(0, titleLimit)}`;
  const body = String(record?.body ?? record?.text ?? "").trim().replace(/\s+/g, " ");
  if (!body) {
    const fallback = record?.status && record.status !== "completed"
      ? "Ход остановлен"
      : "Ход завершён";
    return `${prefix}${fallback}`;
  }
  const sentence = body.match(
    new RegExp(`^.{1,${titleLimit}}?(?=[.!?](?:\\s|$)|$)`, "u"),
  )?.[0] ?? body.slice(0, titleLimit);
  return `${prefix}${sentence.trim().replace(/[.!?]+$/u, "") || "Ход завершён"}`;
}

function changedDiffLineCount(value) {
  return String(value ?? "").split(/\r?\n/u).filter(
    (line) => (/^[+-]/u.test(line) && !/^(?:\+\+\+|---)/u.test(line)),
  ).length;
}

function formatTurnEntry(record, _legacyFiles = "", taskCredits = 0) {
  const breakdown = recordCreditBreakdown(record);
  const recordTotal = breakdown.total;
  const elapsedSeconds = durationSeconds(record?.startedAt, record?.completedAt);
  const creditsKnown = !(
    (record?.usageReported === false && recordTotal <= 0)
    || (!breakdown.priced && recordTotal <= 0)
  );
  const credits = record?.usageReported === false && recordTotal <= 0
    ? "нет данных"
    : !breakdown.priced && recordTotal <= 0
      ? "нет тарифа"
      : highlightUsageUnits(formatCredits(recordTotal));
  const share = taskCredits > 0 && recordTotal > 0
    ? `${Math.round(recordTotal / taskCredits * 100)}%`
    : "";
  const title = escapeHtmlText(turnTitle(record));
  const body = escapeHtmlText(String(record?.body ?? record?.text ?? "").trim());
  const prompt = escapeHtmlText(displayUserPrompt(record?.prompt));
  const pricing = record?.model
    ? `<div data-work-log-turn-pricing>${
      escapeHtmlText(record.model)
    }${record.serviceTier === "fast" ? " · Fast ×" + (
      String(record.model).startsWith("gpt-5.4") ? "2" : "2,5"
    ) : ""}</div>`
    : "";
  const metaDetails = [
    `<div data-work-log-turn-facts>${pricing}`
      + `<div data-work-log-turn-context><strong>Длит.:</strong> ${
        formatDuration(record?.startedAt, record?.completedAt)
      }</div></div>`,
    prompt ? `<div data-work-log-turn-prompt><strong>Запрос:</strong> ${prompt}</div>` : "",
  ].filter(Boolean).join("");
  const bodyDetails = body ? `<div data-work-log-turn-body>${body}</div>` : "";
  const provider = escapeHtmlAttribute(record?.provider);
  const turnThread = escapeHtmlAttribute(record?.threadId);
  const rootThread = escapeHtmlAttribute(taskThreadId(record));
  const timingAttributes = elapsedSeconds === null
    ? ""
    : ` data-work-log-turn-duration-seconds="${elapsedSeconds}"`;
  const completedAtAttribute = record?.completedAt
    ? ` data-work-log-turn-completed-at="${escapeHtmlAttribute(record.completedAt)}"`
    : "";
  const creditsAttribute = creditsKnown
    ? ` data-work-log-turn-credits="${escapeHtmlAttribute(String(recordTotal))}"`
    : "";
  const profileAttributes = [
    `data-work-log-turn-file-count="${escapeHtmlAttribute(String(
      Array.isArray(record?.changedFiles) ? record.changedFiles.length : 0
    ))}"`,
    `data-work-log-turn-change-lines="${escapeHtmlAttribute(String(
      changedDiffLineCount(record?.diff)
    ))}"`,
    `data-work-log-turn-subagent="${record?.aggregateOnly === true ? "1" : "0"}"`,
  ].join(" ");
  return `<div data-work-log-turn-entry data-work-log-turn-provider="${provider}" `
    + `data-work-log-turn-thread-id="${turnThread}" data-work-log-task-thread-id="${rootThread}" `
    + `data-work-log-turn-id="${escapeHtmlAttribute(record?.turnId)}" ${profileAttributes}`
    + `${timingAttributes}${completedAtAttribute}${creditsAttribute}>`
    + "<details data-work-log-turn-details>"
    + "<summary>"
    + '<span data-work-log-turn-meta>'
    + `<span data-work-log-turn-measure>${formatCompletedAt(record?.completedAt)} — ${credits}</span>`
    + (share ? `<span data-work-log-turn-share>(${share})</span>` : "")
    + "</span>"
    + `<span data-work-log-turn-title>${title}</span>`
    + '<button type="button" data-open-turn aria-label="Открыть ход" title="Открыть ход">'
    // Phosphor arrow-square-out — тот же набор, что у остальных иконок оболочки
    + '<svg data-phosphor-icon="arrow-square-out" viewBox="0 0 256 256" aria-hidden="true">'
    + '<polyline points="216 100 216 40 156 40" fill="none" stroke="currentColor"'
    + ' stroke-linecap="round" stroke-linejoin="round" stroke-width="16"></polyline>'
    + '<line x1="144" y1="112" x2="216" y2="40" fill="none" stroke="currentColor"'
    + ' stroke-linecap="round" stroke-linejoin="round" stroke-width="16"></line>'
    + '<path d="M184,144v64a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8h64" fill="none"'
    + ' stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="16"></path>'
    + '</svg></button>'
    + "</summary>"
    + '<div data-work-log-turn-expanded>'
    + `<div data-work-log-turn-meta-details>${metaDetails}</div>`
    + `<div data-work-log-turn-body-details>${bodyDetails}</div>`
    + "</div></details></div>";
}

function formatTurnTable(records, legacyOutcome = "", legacyFiles = "") {
  const taskCredits = records.reduce(
    (total, record) => total + recordCredits(record),
    0,
  );
  const firstRegisteredTurn = records.findIndex((record) => record?.workLogId);
  const legacyFilesTarget = firstRegisteredTurn >= 0 ? firstRegisteredTurn : 0;
  const turnRows = records.map((record, index) => formatTurnEntry(
    record,
    index === legacyFilesTarget ? legacyFiles : "",
    taskCredits,
  ));
  const previousTurns = turnRows.length > 1
    ? [
      "<details data-work-log-previous-turns>",
      "<summary>",
      `<span data-work-log-previous-turns-closed>Показать предыдущие ходы (${turnRows.length - 1})</span>`,
      '<span data-work-log-previous-turns-open>Свернуть</span>',
      "</summary>",
      `<div data-work-log-previous-turn-list>${turnRows.slice(1).join("\n")}</div>`,
      "</details>",
    ].join("")
    : turnRows.length === 1
      ? "<div data-work-log-no-previous-turns>Предыдущих ходов нет.</div>"
      : "";
  const latestTurn = turnRows[0] ?? "";
  const legacy = legacyOutcome
    ? `<div data-work-log-legacy-outcome>${legacyOutcome}</div>`
    : "";
  return [
    "<div data-work-log-turn-table>",
    [latestTurn, previousTurns, legacy].filter(Boolean).join("\n"),
    "</div>",
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

function nestedElements(source, tagName) {
  const text = String(source ?? "");
  const tag = String(tagName).replace(/[^a-z0-9]/gi, "");
  const pattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  const stack = [];
  const ranges = [];
  for (const match of text.matchAll(pattern)) {
    const closing = /^<\//.test(match[0]);
    if (!closing) {
      stack.push({ start: match.index, opening: match[0] });
      continue;
    }
    const started = stack.pop();
    if (!started) continue;
    const end = match.index + match[0].length;
    ranges.push({
      start: started.start,
      end,
      opening: started.opening,
      text: text.slice(started.start, end),
    });
  }
  return ranges.sort((left, right) => left.start - right.start);
}

function hasBareAttribute(opening, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\s${escaped}(?:\\s|=|>)`, "i").test(String(opening ?? ""));
}

function workLogTaskRows(source) {
  const divRows = nestedElements(source, "div")
    .filter((element) => hasBareAttribute(element.opening, "data-work-log-row"));
  if (divRows.length) return divRows;
  return topLevelElements(source, "tr")
    .filter((element) => topLevelElements(element.text, "td").length >= 2)
    .map((element) => ({
      ...element,
      opening: element.text.match(/^<tr\b[^>]*>/i)?.[0] ?? "<tr>",
    }));
}

function workLogRowCells(row) {
  const divCells = nestedElements(row, "div")
    .filter((element) => (
      hasBareAttribute(element.opening, "data-work-log-task-cell")
      || hasBareAttribute(element.opening, "data-work-log-turn-list")
    ));
  if (divCells.length >= 2) return divCells;
  return topLevelElements(row, "td").map((element) => ({
    ...element,
    opening: element.text.match(/^<td\b[^>]*>/i)?.[0] ?? "<td>",
  }));
}

function layoutContainer(content) {
  return [
    "<div data-work-log-table>",
    '<div data-work-log-header><strong>Задача</strong><strong>Ходы</strong></div>',
    `<div data-work-log-body>${content}</div>`,
    "</div>",
  ].join("\n");
}

function insertTaskRow(section, row) {
  const body = nestedElements(section, "div")
    .find((element) => hasBareAttribute(element.opening, "data-work-log-body"));
  if (body) {
    const insertion = body.end - "</div>".length;
    return `${section.slice(0, insertion)}${row}\n${section.slice(insertion)}`;
  }
  const tbodyEnd = section.lastIndexOf("</tbody>");
  if (tbodyEnd < 0) throw new Error("WORK_LOG day has no task container");
  return `${section.slice(0, tbodyEnd)}${row}\n${section.slice(tbodyEnd)}`;
}

function appendMarkerToRow(row, workLogId) {
  const cells = workLogRowCells(row);
  if (cells.length < 2) throw new Error("WORK_LOG task row must contain task and turn cells");
  const usage = nestedElements(cells[0].text, "div")
    .find((element) => hasBareAttribute(element.opening, "data-work-log-usage"));
  const usageCell = cells.length >= 3 ? cells[2] : cells[0];
  const marker = `<span data-usage-id="${workLogId}" hidden>${workLogId}</span>`;
  if (usage) {
    const updatedUsage = usage.text.replace(/<\/div>$/i, `\n${marker}</div>`);
    const updatedCell = `${cells[0].text.slice(0, usage.start)}${updatedUsage}${
      cells[0].text.slice(usage.end)
    }`;
    return `${row.slice(0, cells[0].start)}${updatedCell}${row.slice(cells[0].end)}`;
  }
  const closing = /^<div\b/i.test(usageCell.text) ? "</div>" : "</td>";
  const updatedCell = usageCell.text.replace(
    new RegExp(`${closing.replace("/", "\\/")}$`, "i"),
    `\n${marker}${closing}`,
  );
  return `${row.slice(0, usageCell.start)}${updatedCell}${row.slice(usageCell.end)}`;
}

function taskCell({ provider = "codex", threadId, taskTitle }) {
  const normalizedProvider = String(provider).trim().toLowerCase() || "codex";
  const escapedThreadId = escapeHtmlAttribute(threadId);
  const label = `${normalizedProvider === "claude" ? "Claude" : "Codex"} - ${
    escapeHtmlText(String(taskTitle ?? "").trim() || "Без названия")
  }`;
  return `<button type="button" data-open-task data-provider="${
    escapeHtmlAttribute(normalizedProvider)
  }" data-thread-id="${escapedThreadId}">${label}</button>`;
}

function taskRow({ provider = "codex", threadId, taskTitle, workLogId = null }) {
  const normalizedProvider = String(provider).trim().toLowerCase() || "codex";
  const escapedThreadId = escapeHtmlAttribute(threadId);
  const escapedProvider = escapeHtmlAttribute(normalizedProvider);
  const marker = workLogId
    ? `<span data-usage-id="${workLogId}" hidden>${workLogId}</span>`
    : "";
  return [
    `<div data-work-log-row data-work-log-provider="${escapedProvider}" data-work-log-thread-id="${escapedThreadId}">`,
    '<div data-work-log-task-cell>',
    `<div data-work-log-task-content>${taskCell({ provider: normalizedProvider, threadId, taskTitle })}</div>`,
    `<div data-work-log-usage>${marker}</div>`,
    "</div>",
    "<div data-work-log-turn-list></div>",
    "</div>",
  ].join("\n");
}

function workLogDaySection(date, row, open = false) {
  return [
    `<details${open ? " open" : ""}>`,
    `<summary><strong>${date}</strong></summary>`,
    layoutContainer(row),
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
  const rows = workLogTaskRows(section);
  const linkedRows = rows
    .filter((match) => (
      !/\bdata-work-log-thread-id=/i.test(match.text)
      && match.text.includes(`href="vscode://openai.chatgpt/local/${escapedThreadId}"`)
    ));
  const fallback = rows
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
    updatedSection = insertTaskRow(section, row);
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
  const projected = String(source ?? "").match(
    /<div\b[^>]*data-work-log-legacy-outcome[^>]*>([\s\S]*?)<\/div>/iu,
  )?.[1]?.trim();
  if (projected?.replace(/<[^>]+>/gu, "").trim()) return projected;
  const explicit = String(source ?? "").match(
    /<tr\b[^>]*data-work-log-legacy-outcome[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/iu,
  )?.[1]?.trim();
  if (explicit?.replace(/<[^>]+>/gu, "").trim()) return explicit;
  const restored = String(source ?? "").match(
    /<div\b[^>]*data-work-log-restored-outcome[^>]*>([\s\S]*?)<\/div>/iu,
  )?.[1]?.trim();
  if (restored) return restored;
  if (/<(?:table|div)\b[^>]*data-work-log-turn-table/iu.test(source)) return "";
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
  return String(source ?? "")
    .replace(/^<(?:td|div)\b[^>]*>/i, "")
    .replace(/<\/(?:td|div)>$/i, "")
    .trim();
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
    for (const row of workLogTaskRows(section)) {
      const cells = workLogRowCells(row.text);
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
    for (const row of workLogTaskRows(section).reverse()) {
      const cells = workLogRowCells(row.text);
      if (cells.length < 2 || legacyOutcome(cells[1].text)) continue;
      const outcome = outcomes.get(`${range.date}\0${taskCellKey(cells[0].text)}`);
      if (!outcome) continue;
      const closing = /^<div\b/i.test(cells[1].text) ? "</div>" : "</td>";
      const replacementCell = cells[1].text.replace(
        new RegExp(`${closing.replace("/", "\\/")}$`, "i"),
        `\n<div data-work-log-restored-outcome>${outcome}</div>${closing}`,
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
  const opening = String(row).match(/^<(?:tr|div)\b[^>]*>/i)?.[0] ?? "";
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
    /^<(tr|div)\b([^>]*)>/i,
    `<$1 data-work-log-provider="${escapeHtmlAttribute(provider)}" data-work-log-thread-id="${
      escapeHtmlAttribute(threadId)
    }"$2>`,
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

function taskThreadId(record) {
  return String(record?.taskThreadId ?? record?.threadId ?? "").trim();
}

function normalizedSearchTerm(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/\s+/gu, " ")
    .trim();
}

function searchDateValues(record) {
  const values = [];
  for (const source of [record?.startedAt, record?.completedAt]) {
    const text = String(source ?? "").trim();
    if (!text) continue;
    values.push(text);
    const date = new Date(text);
    if (Number.isFinite(date.getTime())) {
      values.push(
        date.toLocaleDateString("ru-RU"),
        date.toLocaleString("ru-RU"),
      );
    }
  }
  return values.join(" ");
}

function compactSearchSnippet(value, terms, limit = 180) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text || text.length <= limit) return text;
  const normalized = normalizedSearchTerm(text);
  const first = terms
    .map((term) => normalized.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, Math.min(first - Math.floor(limit / 3), text.length - limit));
  const end = Math.min(text.length, start + limit);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export function searchWorkLogRecords(turns = {}, query, {
  limit = 60,
  perTask = 3,
  projectRoots = [],
} = {}) {
  const normalizedQuery = normalizedSearchTerm(query).slice(0, 200);
  const terms = normalizedQuery.split(" ").filter(Boolean);
  if (!terms.length) return [];
  const roots = projectRoots
    .map((root) => normalizeProjectRoot(root))
    .filter(Boolean);
  const groups = new Map();
  for (const record of Object.values(turns ?? {})) {
    if (!record || typeof record !== "object") continue;
    if (roots.length && !roots.some((root) => sameProjectRoot(root, record.projectRoot))) continue;
    const fields = [
      ["Задача", record.taskTitle],
      ["Ход", record.title],
      ["Запрос", record.prompt],
      ["Ответ", record.body ?? record.text],
      ["Файлы", Array.isArray(record.changedFiles) ? record.changedFiles.join(" · ") : ""],
      ["Дата", searchDateValues(record)],
    ].map(([label, value]) => ({
      label,
      value: String(value ?? ""),
      normalized: normalizedSearchTerm(value),
    }));
    const haystack = fields.map((field) => field.normalized).join("\n");
    if (!terms.every((term) => haystack.includes(term))) continue;
    const matched = fields.find((field) => terms.some((term) => field.normalized.includes(term)))
      ?? fields[0];
    const rootThreadId = taskThreadId(record);
    if (!rootThreadId) continue;
    const key = `${record.provider}\0${rootThreadId}\0${normalizeProjectRoot(record.projectRoot)}`;
    const completedAtMs = Date.parse(record.completedAt ?? record.startedAt ?? "") || 0;
    const group = groups.get(key) ?? {
      provider: String(record.provider ?? "codex"),
      threadId: rootThreadId,
      projectRoot: normalizeProjectRoot(record.projectRoot),
      taskTitle: String(record.taskTitle ?? "").trim(),
      latestAt: "",
      latestAtMs: 0,
      matches: [],
    };
    if (completedAtMs >= group.latestAtMs) {
      group.latestAtMs = completedAtMs;
      group.latestAt = String(record.completedAt ?? record.startedAt ?? "");
      if (record.taskTitle) group.taskTitle = String(record.taskTitle).trim();
    }
    group.matches.push({
      turnId: String(record.turnId ?? ""),
      turnThreadId: String(record.threadId ?? rootThreadId),
      field: matched.label,
      snippet: compactSearchSnippet(matched.value, terms),
      completedAt: String(record.completedAt ?? ""),
    });
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      matches: group.matches
        .sort((left, right) => (
          (Date.parse(right.completedAt) || 0) - (Date.parse(left.completedAt) || 0)
        ))
        .slice(0, Math.max(1, Math.min(Number(perTask) || 3, 10))),
    }))
    .sort((left, right) => right.latestAtMs - left.latestAtMs)
    .slice(0, Math.max(1, Math.min(Number(limit) || 60, 200)))
    .map(({ latestAtMs: _latestAtMs, ...group }) => group);
}

function ensureCanonicalRows(section, date, turns) {
  let updated = String(section);
  const groups = new Map();
  for (const record of automaticRecordsForDay(turns, date)) {
    const key = `${record.provider}\0${taskThreadId(record)}`;
    const values = groups.get(key) ?? [];
    values.push(record);
    groups.set(key, values);
  }
  for (const [key, records] of groups) {
    const [provider, threadId] = key.split("\0");
    const rows = workLogTaskRows(updated);
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
    updated = insertTaskRow(updated, row);
  }
  const rows = workLogTaskRows(updated);
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
    if (!datedTurns.some((record) => (
      record.provider === "codex" && taskThreadId(record) === threadId
    ))) {
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
  const cells = workLogRowCells(row);
  if (cells.length < 2) return row;
  const turnCell = cells.find(
    (cell) => hasBareAttribute(cell.opening, "data-work-log-turn-list"),
  ) ?? cells[1];
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
  const attributes = identity
    ? ` data-work-log-provider="${escapeHtmlAttribute(identity.provider)}"`
      + ` data-work-log-thread-id="${escapeHtmlAttribute(identity.threadId)}"`
    : "";
  return `<div data-work-log-row${attributes}>\n`
    + '<div data-work-log-task-cell>'
    + `<div data-work-log-task-content>${task}</div>`
    + `<div data-work-log-usage>${usageContent}</div></div>\n`
    + `<div data-work-log-turn-list>${turnList}</div>\n</div>`;
}

function projectDaySection(section, date, turns, recordsById, open, includeClaudeUsage) {
  const canonicalSection = ensureCanonicalRows(section, date, turns);
  const rows = workLogTaskRows(canonicalSection)
    .map((match, sourceIndex) => {
      const ids = [...new Set(usageIds(match.text))];
      const identity = rowIdentity(match.text);
      const legacyRecords = ids.map((id) => recordsById.get(id)).filter(Boolean);
      const automaticRecords = identity
        ? automaticRecordsForDay(turns, date).filter((record) => (
          record.provider === identity.provider && taskThreadId(record) === identity.threadId
        ))
        : [];
      const seen = new Set();
      const recorded = [...legacyRecords, ...automaticRecords].filter((record) => {
        const key = `${record.provider}\0${record.threadId}\0${record.turnId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const usageRecords = includeClaudeUsage
        ? recorded
        : recorded.filter((record) => record.provider !== "claude");
      const creditBreakdown = usageRecords.reduce(
        (total, record) => addCreditBreakdown(total, recordCreditBreakdown(record)),
        emptyCreditBreakdown(),
      );
      const cells = workLogRowCells(match.text);
      const turnCell = cells.find(
        (cell) => hasBareAttribute(cell.opening, "data-work-log-turn-list"),
      ) ?? cells[1];
      return {
        match,
        sourceIndex,
        ids,
        recorded,
        creditBreakdown,
        credits: creditBreakdown.total,
        latestCompletedAt: recorded.reduce(
          (latest, record) => Math.max(latest, Date.parse(record.completedAt) || 0),
          0,
        ),
        identity,
        hasLegacyOutcome: Boolean(legacyOutcome(turnCell?.text)),
      };
    });
  const trackedRows = rows.filter(
    (row) => row.ids.length || row.recorded.length || row.hasLegacyOutcome,
  );
  const dayBreakdown = trackedRows.reduce(
    (total, row) => addCreditBreakdown(total, row.creditBreakdown),
    emptyCreditBreakdown(),
  );
  const dayCredits = dayBreakdown.total;

  const renderedRows = [...rows]
    .sort((left, right) => (
      right.latestCompletedAt - left.latestCompletedAt
      || left.sourceIndex - right.sourceIndex
    ))
    .map((row) => {
      const visible = row.credits > 0
        ? formatTaskUsageDetails(row.creditBreakdown, dayCredits)
        : "";
      const markers = row.ids.map((id) => (
        `<span data-usage-id="${id}" hidden>${recordsById.has(id) ? "" : id}</span>`
      )).join("\n");
      const turnsContent = [...row.recorded]
        .sort(
          (left, right) => (Date.parse(right.completedAt) || 0) - (Date.parse(left.completedAt) || 0),
        );
      const collapseTurns = turnsContent.length > 1
        ? '<button type="button" data-work-log-collapse-turns>Свернуть ходы</button>'
        : "";
      return replaceProjectedCells(
        row.match.text,
        `${visible}${markers}${collapseTurns}`,
        turnsContent,
      );
    });
  const summary = dayCredits > 0
    ? `<summary data-work-log-day><strong>${date}</strong> <span data-day-usage-table>`
      + `<span data-day-usage><span data-usage-label>Итого</span> ${
        highlightUsageUnits(formatCredits(dayCredits)).replace(
          /^(<span\b)/u,
          `$1 data-usage-credits="${escapeHtmlAttribute(String(dayCredits))}"`,
        )
      }</span>`
      + `${formatDayUsageBreakdown(dayBreakdown)}</span></summary>`
    : `<summary data-work-log-day><strong>${date}</strong></summary>`;
  return [
    `<details data-work-log-day-section${open ? " open" : ""}>`,
    summary,
    layoutContainer(renderedRows.join("\n")),
    "</details>",
    "",
    "",
  ].join("\n");
}

export function projectWorkLogUsage(workLogText, turns = {}, { includeClaudeUsage = true } = {}) {
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
  const currentDate = formatLocalDate(new Date());
  const defaultOpenDate = dayStarts.some((match) => match[1] === currentDate)
    ? currentDate
    : dayStarts[0]?.[1];
  let projected = text;
  for (let index = dayStarts.length - 1; index >= 0; index -= 1) {
    const start = dayStarts[index].index;
    const end = index + 1 < dayStarts.length ? dayStarts[index + 1].index : text.length;
    const section = text.slice(start, end);
    const replacement = projectDaySection(
      section,
      dayStarts[index][1],
      normalizedTurns,
      records,
      dayStarts[index][1] === defaultOpenDate,
      includeClaudeUsage,
    );
    projected = `${projected.slice(0, start)}${replacement}${projected.slice(end)}`;
  }
  return projected;
}

/* Строка одной меры внутри общего облака лимитов. */
function rateLimitChip(line) {
  // срок сброса необязателен: Codex не всегда возвращает окно
  const parts = /^(.+?)\s+-\s+([\d.,]+\s*%)(?:\s+-\s+(.+))?$/u.exec(line);
  if (!parts) {
    return `<span data-rate-limit data-rate-limit-plain>${escapeHtmlText(line)}</span>`;
  }
  const reset = parts[3]
    ? `<span data-rate-limit-reset>${escapeHtmlText(parts[3])}</span>`
    : "";
  return `<span data-rate-limit><span data-rate-limit-name>${
    escapeHtmlText(parts[1])
  }</span><span data-rate-limit-value>${escapeHtmlText(parts[2])}</span>${reset}</span>`;
}

function rateLimitClouds(lines) {
  const limitLines = [];
  let resetCount = "";
  let resetDeadline = "";
  for (const line of lines) {
    const count = /^(?:Доступно\s+)?сбросов\s*:?\s*(.+)$/iu.exec(line);
    if (count) {
      resetCount = `Сбросов ${count[1].trim()}`;
      continue;
    }
    const deadline = /^До\s+(.+)$/iu.exec(line);
    if (deadline) {
      resetDeadline = `До ${deadline[1].trim()}`;
      continue;
    }
    limitLines.push(line);
  }
  const limits = limitLines.length
    ? `<span data-rate-limit-group>${limitLines.map(rateLimitChip).join("")}</span>`
    : "";
  const reset = resetCount || resetDeadline
    ? `<span data-rate-limit-credit>${
      resetCount ? `<span data-rate-limit-credit-count>${escapeHtmlText(resetCount)}</span>` : ""
    }${
      resetDeadline ? `<span data-rate-limit-credit-deadline>${escapeHtmlText(resetDeadline)}</span>` : ""
    }</span>`
    : "";
  return `${limits}${reset}`;
}

export function projectWorkLogRateLimits(workLogText, summary, sampledAt = "") {
  const text = String(workLogText ?? "");
  const lines = String(summary ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const clean = lines.join(" · ");
  const existing = /\n?<div data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>\n?/iu;
  if (!clean) return text.replace(existing, "\n");
  const timestamp = String(sampledAt ?? "").trim();
  const block = `<div data-work-log-rate-limits${
    timestamp ? ` data-sampled-at="${escapeHtmlAttribute(timestamp)}"` : ""
  }><span data-rate-limit-caption>Лимиты</span>${rateLimitClouds(lines)}</div>`;
  if (existing.test(text)) return text.replace(existing, `\n${block}\n`);
  const heading = /^# [^\r\n]+(?:\r?\n)?/u.exec(text);
  if (!heading) return `# Глобальный журнал работ\n\n${block}\n\n${text}`;
  return `${text.slice(0, heading[0].length)}\n${block}\n${text.slice(heading[0].length)}`;
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
    (_match, opening, closing) => `${opening}${formatWorkLogUsage(turnCreditBreakdown(usage, {
      model: "gpt-5.6-sol",
    }))}${closing}`,
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
  estimatedCredits,
  estimateKind,
  model,
  serviceTier,
  taskTitle,
  taskThreadId,
  parentThreadId,
  aggregateOnly,
  provisional,
  title,
  body,
  text,
  prompt,
  changedFiles,
  diff,
  startedAt,
  completedAt,
  status,
}) {
  return {
    workLogId,
    projectRoot: normalizeProjectRoot(projectRoot),
    usage: normalizeTokenUsage(usage),
    usageReported: usageReported === true,
    estimatedCredits: normalizeEstimatedCredits(estimatedCredits),
    estimateKind: String(estimateKind ?? "").trim(),
    model: String(model ?? "").trim().toLowerCase(),
    serviceTier: serviceTier == null ? "" : normalizeServiceTier(serviceTier),
    pricingMetadataResolved: Boolean(String(model ?? "").trim() && serviceTier != null),
    provider: String(provider).trim().toLowerCase(),
    threadId: String(threadId).trim(),
    taskThreadId: String(taskThreadId ?? threadId).trim(),
    parentThreadId: String(parentThreadId ?? "").trim(),
    aggregateOnly: aggregateOnly === true,
    provisional: provisional === true,
    turnId: String(turnId).trim(),
    taskTitle: String(taskTitle ?? "").trim(),
    title: String(title ?? "").trim(),
    body: String(body ?? text ?? "").trim(),
    prompt: displayUserPrompt(prompt),
    changedFiles: Array.isArray(changedFiles)
      ? changedFiles.map((file) => String(file).trim()).filter(Boolean)
      : [],
    diff: String(diff ?? ""),
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
  if (incoming.estimatedCredits > 0) {
    existing.estimatedCredits = incoming.estimatedCredits;
    existing.estimateKind = incoming.estimateKind;
  }
  for (const field of [
    "projectRoot",
    "provider",
    "threadId",
    "taskThreadId",
    "parentThreadId",
    "turnId",
    "taskTitle",
    "title",
    "body",
    "prompt",
    "changedFiles",
    "diff",
    "startedAt",
    "completedAt",
    "model",
    "serviceTier",
  ]) {
    if (field === "changedFiles") {
      if (incoming.changedFiles.length) existing.changedFiles = incoming.changedFiles;
    } else if (field === "diff") {
      if (incoming.diff) existing.diff = incoming.diff;
    } else if (incoming[field]) {
      existing[field] = incoming[field];
    }
  }
  if (incoming.pricingMetadataResolved) existing.pricingMetadataResolved = true;
  if (incoming.aggregateOnly) existing.aggregateOnly = true;
  existing.provisional = incoming.provisional === true;
  if (incoming.status && (incoming.status !== "unknown" || !existing.status || existing.status === "unknown")) {
    existing.status = incoming.status;
  }
  return existing;
}

const USAGE_HISTORY_RANGES = Object.freeze({
  "6h": { spanMs: 6 * 60 * 60 * 1_000, bucketMs: 15 * 60 * 1_000 },
  "24h": { spanMs: 24 * 60 * 60 * 1_000, bucketMs: 60 * 60 * 1_000 },
  "7d": { spanMs: 7 * 24 * 60 * 60 * 1_000, bucketMs: 6 * 60 * 60 * 1_000 },
  "30d": { spanMs: 30 * 24 * 60 * 60 * 1_000, bucketMs: 24 * 60 * 60 * 1_000 },
});

function allHistoryBucketMs(spanMs, maxPoints) {
  const day = 24 * 60 * 60 * 1_000;
  const candidates = [60 * 60 * 1_000, day, 7 * day, 30 * day, 90 * day, 365 * day];
  return candidates.find((bucket) => Math.ceil(spanMs / bucket) <= maxPoints)
    ?? Math.ceil(spanMs / maxPoints / day) * day;
}

export function buildWorkLogUsageHistory(turns = {}, {
  range = "24h",
  now = Date.now(),
  maxPoints = 600,
  includeClaudeUsage = true,
} = {}) {
  const normalizedRange = range === "all" || Object.hasOwn(USAGE_HISTORY_RANGES, range)
    ? range
    : "24h";
  const toMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const records = Object.values(turns ?? {})
    .filter((record) => (
      includeClaudeUsage || String(record?.provider ?? "").toLowerCase() !== "claude"
    ))
    .map((record) => {
      const completedMs = Date.parse(record?.completedAt ?? "");
      const breakdown = recordCreditBreakdown(record);
      const priced = !(
        (record?.usageReported === false && breakdown.total <= 0)
        || (!breakdown.priced && breakdown.total <= 0)
      );
      return {
        completedMs,
        credits: Math.max(0, Number(breakdown.total) || 0),
        priced,
      };
    }).filter((record) => Number.isFinite(record.completedMs) && record.completedMs <= toMs);
  const earliest = records.length
    ? Math.min(...records.map((record) => record.completedMs))
    : toMs;
  const configured = USAGE_HISTORY_RANGES[normalizedRange];
  const rawFromMs = configured ? toMs - configured.spanMs : earliest;
  const pointLimit = Math.min(Math.max(Number(maxPoints) || 600, 10), 2_000);
  const spanMs = Math.max(1, toMs - rawFromMs);
  const bucketMs = configured?.bucketMs ?? allHistoryBucketMs(spanMs, pointLimit);
  const fromMs = Math.floor(rawFromMs / bucketMs) * bucketMs;
  const buckets = new Map();
  let totalCredits = 0;
  let unpricedCount = 0;
  for (const record of records) {
    if (record.completedMs < rawFromMs) continue;
    if (!record.priced) {
      unpricedCount += 1;
      continue;
    }
    totalCredits += record.credits;
    if (record.credits <= 0) continue;
    const bucket = Math.floor(record.completedMs / bucketMs) * bucketMs;
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + record.credits);
  }
  const points = [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-pointLimit)
    .map(([at, credits]) => ({
      at: new Date(at).toISOString(),
      credits,
    }));
  return {
    range: normalizedRange,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    bucketMs,
    totalCredits,
    unpricedCount,
    points,
  };
}

export class WorkLogUsageStore {
  #ledgerFile;
  #backupFile;
  #deltaFile;
  #quarantineFile;
  #defaultProjectRoot;
  #randomUUID;
  #loaded = false;
  #ledger = normalizedLedger().ledger;
  #incremental = false;
  #recordSnapshot = new Map();
  #incrementalThresholdBytes = 1024 * 1024;
  #checkpointDeltaBytes = 8 * 1024 * 1024;
  #tail = Promise.resolve();
  #includeClaudeUsage = true;

  constructor({
    ledgerFile,
    defaultProjectRoot = "",
    randomUUID = crypto.randomUUID,
    includeClaudeUsage = true,
  } = {}) {
    this.#ledgerFile = path.resolve(ledgerFile);
    this.#backupFile = `${this.#ledgerFile}.bak`;
    this.#deltaFile = `${this.#ledgerFile}.delta.jsonl`;
    this.#quarantineFile = `${this.#ledgerFile}.invalid-records.json`;
    this.#defaultProjectRoot = normalizeProjectRoot(defaultProjectRoot);
    this.#randomUUID = randomUUID;
    this.#includeClaudeUsage = includeClaudeUsage !== false;
  }

  setIncludeClaudeUsage(value) {
    this.#includeClaudeUsage = value !== false;
  }

  async #load() {
    if (this.#loaded) return;
    const loaded = await readJsonWithBackup(this.#ledgerFile, {
      backupFile: this.#backupFile,
    });
    const delta = await applyLedgerDelta(loaded.value ?? {}, this.#deltaFile);
    const persisted = delta.value;
    const normalized = normalizedLedger(persisted, {
      defaultProjectRoot: this.#defaultProjectRoot,
    });
    this.#ledger = normalized.ledger;
    const sourceInfo = await stat(this.#ledgerFile).catch(() => null);
    this.#incremental = Number(sourceInfo?.size ?? 0) >= this.#incrementalThresholdBytes;
    this.#recordSnapshot = ledgerRecordSnapshot(this.#ledger.turns);
    if (delta.invalid) {
      console.error(`Ignored ${delta.invalid} invalid incremental work-log ledger event(s).`);
    }
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
          || normalizeEstimatedCredits(
            record?.estimatedCredits
              ?? (Number(persisted?.version ?? 0) < 6
                ? Number(record?.estimatedUnits ?? 0) / 8_000
                : 0),
          ) !== this.#ledger.turns[key]?.estimatedCredits
          || String(record?.estimateKind ?? "").trim()
            !== this.#ledger.turns[key]?.estimateKind
          || String(record?.model ?? "").trim().toLowerCase()
            !== this.#ledger.turns[key]?.model
          || normalizeServiceTier(record?.serviceTier ?? record?.service_tier)
            !== this.#ledger.turns[key]?.serviceTier
        ),
      );
    if (loaded.recovered || migrated || normalized.invalidRecords.length) {
      await this.#save({ forceCheckpoint: true });
    }
  }

  async #save({ forceCheckpoint = false } = {}) {
    await mkdir(path.dirname(this.#ledgerFile), { recursive: true });
    if (this.#incremental && !forceCheckpoint) {
      const changes = ledgerRecordChanges(this.#ledger.turns, this.#recordSnapshot);
      if (!changes.events.length) return;
      await appendLedgerEvents(this.#deltaFile, changes.events);
      this.#recordSnapshot = changes.snapshot;
      const deltaInfo = await stat(this.#deltaFile).catch(() => null);
      if (Number(deltaInfo?.size ?? 0) < this.#checkpointDeltaBytes) return;
    }
    const content = `${JSON.stringify(this.#ledger, null, 2)}\n`;
    await writeTextAtomic(this.#ledgerFile, content);
    await writeTextAtomic(this.#backupFile, content);
    await rm(this.#deltaFile, { force: true });
    this.#recordSnapshot = ledgerRecordSnapshot(this.#ledger.turns);
    this.#incremental = Buffer.byteLength(content, "utf8") >= this.#incrementalThresholdBytes;
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

  getTurn({ provider = "codex", threadId, turnId }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const record = this.#ledger.turns[workLogTurnKey({ provider, threadId, turnId })];
      return record ? structuredClone(record) : null;
    });
    this.#tail = operation;
    return operation;
  }

  searchTurns(query, options = {}) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      return structuredClone(searchWorkLogRecords(this.#ledger.turns, query, options));
    });
    this.#tail = operation;
    return operation;
  }

  usageHistory(options = {}) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      return structuredClone(buildWorkLogUsageHistory(this.#ledger.turns, {
        includeClaudeUsage: this.#includeClaudeUsage,
        ...options,
      }));
    });
    this.#tail = operation;
    return operation;
  }

  missingPricingTurns({ provider = "codex" } = {}) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const normalizedProvider = String(provider ?? "").trim().toLowerCase();
      return Object.values(this.#ledger.turns)
        .filter((record) => (
          record.provider === normalizedProvider
          && (!record.model || !record.pricingMetadataResolved)
        ))
        .map((record) => ({
          provider: record.provider,
          threadId: record.threadId,
          turnId: record.turnId,
          projectRoot: record.projectRoot,
          startedAt: record.startedAt,
        }));
    });
    this.#tail = operation;
    return operation;
  }

  missingImageGenerationEstimateTurns({ provider = "codex" } = {}) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const normalizedProvider = String(provider ?? "").trim().toLowerCase();
      return Object.values(this.#ledger.turns)
        .filter((record) => (
          record.provider === normalizedProvider
          && normalizeEstimatedCredits(record.estimatedCredits) === 0
          && looksLikeImageGenerationPrompt(record.prompt)
        ))
        .map((record) => ({
          provider: record.provider,
          threadId: record.threadId,
          turnId: record.turnId,
          projectRoot: record.projectRoot,
          startedAt: record.startedAt,
        }));
    });
    this.#tail = operation;
    return operation;
  }

  synchronizeUsageEstimatesAndProject({
    items = [],
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      let updated = 0;
      for (const item of items) {
        const provider = String(item?.provider ?? "codex").trim().toLowerCase();
        const threadId = String(item?.threadId ?? "").trim();
        const turnId = String(item?.turnId ?? "").trim();
        const estimatedCredits = normalizeEstimatedCredits(item?.estimatedCredits);
        if (!provider || !threadId || !turnId || !estimatedCredits) continue;
        const record = this.#ledger.turns[workLogTurnKey({ provider, threadId, turnId })];
        if (!record || !sameProjectRoot(record.projectRoot, projectRoot)) continue;
        const estimateKind = String(item?.estimateKind ?? "").trim();
        if (record.estimatedCredits === estimatedCredits && record.estimateKind === estimateKind) continue;
        record.estimatedCredits = estimatedCredits;
        record.estimateKind = estimateKind;
        updated += 1;
      }
      if (!updated) return { updated: 0, projected: false, reason: "unchanged" };
      await this.#save();
      const logPath = path.resolve(workLogFile);
      let current;
      try {
        current = await readFile(logPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") current = "# Глобальный журнал работ\n";
        else throw error;
      }
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      const projected = this.#projectUsage(current, selectedTurns);
      if (projected !== current) await writeTextAtomic(logPath, projected);
      return { updated, projected: projected !== current };
    });
    this.#tail = operation;
    return operation;
  }

  synchronizePricingMetadataAndProject({
    items = [],
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      let updated = 0;
      for (const item of items) {
        const provider = String(item?.provider ?? "codex").trim().toLowerCase();
        const threadId = String(item?.threadId ?? "").trim();
        const turnId = String(item?.turnId ?? "").trim();
        const model = String(item?.model ?? "").trim().toLowerCase();
        if (!provider || !threadId || !turnId || !model) continue;
        const record = this.#ledger.turns[workLogTurnKey({ provider, threadId, turnId })];
        if (!record || !sameProjectRoot(record.projectRoot, projectRoot)) continue;
        const serviceTier = normalizeServiceTier(item?.serviceTier);
        if (
          record.model === model
          && record.serviceTier === serviceTier
          && record.pricingMetadataResolved
        ) continue;
        record.model = model;
        record.serviceTier = serviceTier;
        record.pricingMetadataResolved = true;
        updated += 1;
      }
      if (!updated) return { updated: 0, projected: false, reason: "unchanged" };
      await this.#save();
      const logPath = path.resolve(workLogFile);
      let current;
      try {
        current = await readFile(logPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") current = "# Глобальный журнал работ\n";
        else throw error;
      }
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      const projected = this.#projectUsage(current, selectedTurns);
      if (projected !== current) await writeTextAtomic(logPath, projected);
      return { updated, projected: projected !== current };
    });
    this.#tail = operation;
    return operation;
  }

  synchronizeTaskTitlesAndProject({
    titles = [],
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
    workLogFile,
  }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const byTask = new Map(
        titles
          .map((item) => {
            const provider = String(item?.provider ?? "").trim().toLowerCase();
            const threadId = String(item?.threadId ?? "").trim();
            const taskTitle = String(item?.taskTitle ?? "").replace(/\s+/g, " ").trim();
            return provider && threadId && taskTitle
              ? [`${provider}\0${threadId}`, taskTitle]
              : null;
          })
          .filter(Boolean),
      );
      let updated = 0;
      for (const record of Object.values(this.#ledger.turns)) {
        if (!sameProjectRoot(record.projectRoot, projectRoot)) continue;
        const title = byTask.get(`${record.provider}\0${taskThreadId(record)}`);
        if (!title || record.taskTitle === title) continue;
        record.taskTitle = title;
        updated += 1;
      }
      if (!updated) return { updated: 0, projected: false, reason: "unchanged" };
      await this.#save();
      const logPath = path.resolve(workLogFile);
      let current;
      try {
        current = await readFile(logPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") current = "# Глобальный журнал работ\n";
        else throw error;
      }
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      const projected = this.#projectUsage(current, selectedTurns);
      if (projected !== current) await writeTextAtomic(logPath, projected);
      return { updated, projected: projected !== current };
    });
    this.#tail = operation;
    return operation;
  }

  #turnsForProjection(projectRoot, projectionProjectRoots) {
    const roots = (
      Array.isArray(projectionProjectRoots) && projectionProjectRoots.length
        ? projectionProjectRoots
        : [projectRoot]
    ).map((root) => normalizeProjectRoot(root));
    return Object.fromEntries(
      Object.entries(this.#ledger.turns).filter(([, record]) => (
        roots.some((root) => sameProjectRoot(record.projectRoot, root))
      )),
    );
  }

  #projectUsage(text, turns) {
    return projectWorkLogUsage(text, turns, {
      includeClaudeUsage: this.#includeClaudeUsage,
    });
  }

  project(workLogFile, {
    projectRoot = this.#defaultProjectRoot,
    projectionProjectRoots,
  } = {}) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const logPath = path.resolve(workLogFile);
      const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
      let current;
      try {
        current = await readFile(logPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") current = "# Глобальный журнал работ\n";
        else throw error;
      }
      const updated = this.#projectUsage(current, selectedTurns);
      if (updated === current) return { projected: false, reason: "unchanged" };
      await writeTextAtomic(logPath, updated);
      return { projected: true };
    });
    this.#tail = operation;
    return operation;
  }

  projectRateLimits(workLogFile, summary, sampledAt = "") {
    const operation = this.#tail.catch(() => {}).then(async () => {
      const logPath = path.resolve(workLogFile);
      let current;
      try {
        current = await readFile(logPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") current = "# Глобальный журнал работ\n";
        else throw error;
      }
      const updated = projectWorkLogRateLimits(current, summary, sampledAt);
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
    estimatedCredits,
    estimateKind,
    model,
    serviceTier,
    taskThreadId,
    parentThreadId,
    aggregateOnly,
    provisional,
    taskTitle,
    title,
    body,
    prompt,
    changedFiles,
    diff,
    startedAt,
    completedAt,
    status,
    text,
    workLogFile,
    projectionProjectRoots,
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
        estimatedCredits,
        estimateKind,
        model,
        serviceTier,
        taskThreadId,
        parentThreadId,
        aggregateOnly,
        provisional,
        taskTitle,
        title,
        body,
        text,
        prompt,
        changedFiles,
        diff,
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
        const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
        const updated = this.#projectUsage(current, selectedTurns);
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
    estimatedCredits,
    estimateKind,
    model,
    serviceTier,
    taskThreadId,
    parentThreadId,
    aggregateOnly,
    provisional,
    taskTitle,
    title,
    body,
    prompt,
    changedFiles,
    diff,
    startedAt,
    completedAt,
    status,
    text,
    workLogFile,
    projectionProjectRoots,
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
        estimatedCredits,
        estimateKind,
        model,
        serviceTier,
        taskThreadId,
        parentThreadId,
        aggregateOnly,
        provisional,
        taskTitle,
        title,
        body,
        text,
        prompt,
        changedFiles,
        diff,
        startedAt,
        completedAt,
        status,
      });
      this.#ledger.turns[key] = mergeLedgerRecord(existing, incoming);
      await this.#save();
      try {
        let current;
        current = await readFile(logPath, "utf8");
        const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
        const updated = this.#projectUsage(current, selectedTurns);
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
            const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
            const created = this.#projectUsage("# Глобальный журнал работ\n", selectedTurns);
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

  retractProvisionalAndProject({
    provider = "codex",
    threadId,
    turnId,
    projectRoot = this.#defaultProjectRoot,
    workLogFile,
    projectionProjectRoots,
  }) {
    const operation = this.#tail.catch(() => {}).then(async () => {
      await this.#load();
      const key = workLogTurnKey({ provider, threadId, turnId });
      const existing = this.#ledger.turns[key];
      if (!existing?.provisional) return { retracted: false, projected: false };
      delete this.#ledger.turns[key];
      await this.#save();
      const logPath = path.resolve(workLogFile);
      try {
        const current = await readFile(logPath, "utf8");
        const selectedTurns = this.#turnsForProjection(projectRoot, projectionProjectRoots);
        const updated = this.#projectUsage(current, selectedTurns);
        await writeTextAtomic(logPath, updated);
        return { retracted: true, projected: true };
      } catch (error) {
        return {
          retracted: true,
          projected: false,
          projectionError: String(error?.message ?? error),
        };
      }
    });
    this.#tail = operation;
    return operation;
  }
}

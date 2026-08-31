import { createHash } from "node:crypto";
import path from "node:path";

import {
  estimateMissingCodexUsage,
  IMAGE_GENERATION_ESTIMATE_CREDITS,
  looksLikeImageGenerationPrompt,
} from "../domain/codex-usage-estimate.mjs";
import { isCodexContextProbeTurn } from "../domain/codex-context-probe.mjs";
import { isCodexAutoCompactionTurnId } from "../domain/codex-internal-turn.mjs";
import { isInheritedSubagentTurn } from "../domain/subagent-turn-identity.mjs";
import { taskDisplayTitle } from "../domain/task-display-title.mjs";
import { displayUserPrompt } from "./task-history.mjs";
import {
  addCreditBreakdown,
  emptyCreditBreakdown,
  fastModeCreditMultiplier,
  formatCredits,
  formatTaskCreditBreakdown,
  normalizeServiceTier,
  normalizeTokenUsage,
  turnCreditBreakdown,
} from "../domain/token-usage.mjs";
import {
  normalizeUsageSyncEvent,
  usageSyncEventIdentity,
  usageSyncEventFromLedgerRecord,
} from "../domain/work-log-usage-sync.mjs";

const WORK_LOG_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_ATTRIBUTIONS = new Set(["exact", "inferred"]);
const UNKNOWN_ACCOUNT_UI_KEY = "__unknown_account__";

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

export function normalizeProjectRoot(value, fallback = "") {
  const candidate = String(value ?? fallback).trim();
  return candidate ? path.resolve(candidate) : "";
}

export function sameProjectRoot(left, right) {
  const normalizedLeft = normalizeProjectRoot(left);
  const normalizedRight = normalizeProjectRoot(right);
  if (!normalizedLeft || !normalizedRight) return normalizedLeft === normalizedRight;
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function normalizeEstimatedCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) && credits > 0 ? credits : 0;
}

function normalizeImageGenerationCount(value, { estimatedCredits = 0, estimateKind = "" } = {}) {
  const explicit = Math.max(0, Math.floor(Number(value) || 0));
  if (explicit) return explicit;
  if (String(estimateKind ?? "").trim() !== "imagegen-default") return 0;
  return Math.max(0, Math.round(normalizeEstimatedCredits(estimatedCredits) / IMAGE_GENERATION_ESTIMATE_CREDITS));
}

function effectiveEstimatedCredits(record) {
  return String(record?.estimateKind ?? "").trim() === "imagegen-default"
    ? 0
    : normalizeEstimatedCredits(record?.estimatedCredits);
}

function isContextProbeRecord(record) {
  return record?.contextProbe === true || isCodexContextProbeTurn(record);
}

function normalizedSkillsUsed(value) {
  return [...new Set(
    (Array.isArray(value) ? value : [])
      .map((name) => String(name ?? "").trim())
      .filter(Boolean),
  )];
}

function normalizedMcpCalls(value) {
  const calls = new Map();
  for (const call of Array.isArray(value) ? value : []) {
    const id = String(call?.id ?? "").trim();
    if (!id) continue;
    calls.set(id, {
      id,
      server: String(call?.server ?? "").trim(),
      tool: String(call?.tool ?? "").trim(),
      status: String(call?.status ?? "completed").trim() || "completed",
    });
  }
  return [...calls.values()];
}

export function normalizeAccountAttribution(value, { hasAccountKey = false } = {}) {
  const candidate = String(value ?? "").trim().toLowerCase();
  if (ACCOUNT_ATTRIBUTIONS.has(candidate)) return candidate;
  return hasAccountKey ? "exact" : "inferred";
}

function accountKeyFromDimension(account) {
  const key = String(account?.key ?? account?.accountKey ?? "").trim();
  if (key) return key;
  const type = String(account?.type ?? "").trim();
  const email = String(account?.email ?? "").trim().toLowerCase();
  if (type === "chatgpt" && email) {
    return `chatgpt:${createHash("sha256").update(email).digest("hex")}`;
  }
  if (type === "apiKey") return "api-key";
  if (type === "amazonBedrock") return "amazon-bedrock";
  return "";
}

export function normalizedAccountFields(value = {}) {
  const rawAccount = value?.account && typeof value.account === "object" ? value.account : null;
  const account = rawAccount?.account && typeof rawAccount.account === "object"
    ? rawAccount.account
    : rawAccount;
  const accountKey = String(value?.accountKey ?? accountKeyFromDimension(account) ?? "").trim();
  const accountLabel = String(
    value?.accountLabel
      ?? account?.label
      ?? account?.email
      ?? "",
  ).trim();
  const accountType = String(value?.accountType ?? account?.type ?? "").trim();
  const accountPlan = String(
    value?.accountPlan
      ?? value?.accountPlanType
      ?? account?.planType
      ?? account?.plan
      ?? "",
  ).trim();
  return {
    accountKey,
    accountLabel,
    accountType,
    accountPlan,
    accountAttribution: normalizeAccountAttribution(
      value?.accountAttribution,
      { hasAccountKey: Boolean(accountKey) },
    ),
  };
}

function isLegacyEmptyAutoCompactRecord(record, { provider, turnId, status, usageReported }) {
  if (provider !== "codex"
    || !isCodexAutoCompactionTurnId(turnId)
    || status !== "aborted"
    || usageReported
    || normalizeEstimatedCredits(record?.estimatedCredits) > 0) {
    return false;
  }
  const usage = normalizeTokenUsage(record?.usage);
  return !Object.values(usage).some((value) => value > 0)
    && !String(record?.prompt ?? "").trim()
    && !String(record?.body ?? record?.text ?? "").trim()
    && !(Array.isArray(record?.changedFiles) && record.changedFiles.length)
    && !(Array.isArray(record?.skillsUsed) && record.skillsUsed.length)
    && !(Array.isArray(record?.mcpCalls) && record.mcpCalls.length);
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
      estimatedCredits: effectiveEstimatedCredits(record),
    },
  );
}

function recordCredits(record) {
  return recordCreditBreakdown(record).total;
}

function recordCreditsKnown(record, breakdown = recordCreditBreakdown(record)) {
  const total = breakdown.total;
  return !(
    (record?.usageReported === false && total <= 0)
    || (!breakdown.priced && total <= 0)
  );
}

export function normalizedLedger(value = {}, { defaultProjectRoot = "" } = {}) {
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
      // Early rollout backfills treated Codex's internal auto-compaction
      // response item as an aborted subagent turn. It has no prompt, answer,
      // usage or work and should not surface as a journal event.
      if (isLegacyEmptyAutoCompactRecord(record, {
        provider,
        turnId,
        status,
        usageReported,
      })) continue;
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
      const account = normalizedAccountFields(record);
      const estimatedCredits = normalizeEstimatedCredits(
        record?.estimatedCredits
          ?? (sourceVersion < 6 && record?.estimatedUnits != null
            ? Number(record.estimatedUnits) / 8_000
            : estimate?.estimatedCredits),
      );
      const estimateKind = String(record?.estimateKind ?? estimate?.estimateKind ?? "").trim();
      turns[key] = {
        workLogId,
        projectRoot: normalizeProjectRoot(record?.projectRoot, defaultProjectRoot),
        usage: normalizeTokenUsage(record?.usage),
        usageReported,
        estimatedCredits,
        estimateKind,
        imageGenerationCount: normalizeImageGenerationCount(record?.imageGenerationCount, {
          estimatedCredits,
          estimateKind,
        }),
        contextProbe: isContextProbeRecord(record),
        model: String(record?.model ?? "").trim().toLowerCase(),
        serviceTier: normalizeServiceTier(record?.serviceTier ?? record?.service_tier),
        pricingMetadataResolved: sourceVersion >= 7
          && record?.pricingMetadataResolved === true,
        provider,
        threadId,
        taskThreadId,
        parentThreadId: String(record?.parentThreadId ?? "").trim(),
        parentTurnId: String(record?.parentTurnId ?? "").trim(),
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
        skillsUsed: normalizedSkillsUsed(record?.skillsUsed),
        mcpCalls: normalizedMcpCalls(record?.mcpCalls),
        toolMetricsKnown: sourceVersion >= 8 && record?.toolMetricsKnown === true,
        startedAt: String(record?.startedAt ?? ""),
        completedAt: String(record?.completedAt ?? ""),
        observedAt: String(record?.observedAt ?? ""),
        status,
        ...account,
      };
    } catch (error) {
      invalidRecords.push({
        key,
        record,
        error: String(error?.message ?? error),
      });
    }
  }
  return { ledger: { version: 9, turns }, invalidRecords };
}

export function normalizePersistedWorkLog(value = {}, { defaultProjectRoot = "" } = {}) {
  const normalized = normalizedLedger(value, { defaultProjectRoot });
  const migrated = Number(value?.version ?? 0) !== normalized.ledger.version
    || Object.entries(value?.turns ?? {}).some(
      ([key, record]) => (
        String(record?.prompt ?? "").trim() !== String(normalized.ledger.turns[key]?.prompt ?? "")
        || normalizeProjectRoot(record?.projectRoot) !== normalized.ledger.turns[key]?.projectRoot
        || normalizeEstimatedCredits(
          record?.estimatedCredits
            ?? (Number(value?.version ?? 0) < 6
              ? Number(record?.estimatedUnits ?? 0) / 8_000
              : 0),
        ) !== normalized.ledger.turns[key]?.estimatedCredits
        || String(record?.estimateKind ?? "").trim()
          !== normalized.ledger.turns[key]?.estimateKind
        || String(record?.model ?? "").trim().toLowerCase()
          !== normalized.ledger.turns[key]?.model
        || normalizeServiceTier(record?.serviceTier ?? record?.service_tier)
          !== normalized.ledger.turns[key]?.serviceTier
        || String(record?.accountKey ?? "").trim()
          !== normalized.ledger.turns[key]?.accountKey
        || normalizeAccountAttribution(record?.accountAttribution, {
          hasAccountKey: Boolean(String(record?.accountKey ?? "").trim()),
        }) !== normalized.ledger.turns[key]?.accountAttribution
      ),
    );
  return { ...normalized, migrated };
}

export function formatWorkLogUsage(breakdown) {
  const telegramText = formatTaskCreditBreakdown(breakdown)
    .replace(/^📊\s*/, "")
    .replace(/^За (?:задачу|поток):\s*/u, "Итого ");
  return telegramText
    .split("\n")
    .flatMap((line) => line.split(/\s+\|\s+/))
    // Estimated credits already contribute to the total; they are not a
    // separate usage category alongside input, cache, output and reasoning.
    .filter((line) => !/^ImageGen:/u.test(line))
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

/* Показанный текст округлён до одного знака и сжат до kcr/Mcr, поэтому клиент не
   может восстановить из него точное число при переходе в $, ₽ или ПТЭ. Точное
   значение едет рядом в data-usage-credits. */
function highlightUsageUnits(text, credits = Number.NaN) {
  const exact = Number(credits);
  const usageCredits = Number.isFinite(exact) && exact >= 0
    ? ` data-usage-credits="${escapeHtmlAttribute(String(exact))}"`
    : "";
  return String(text).replace(
    /(\d+(?:[  ]\d{3})*(?:,\d+)? (Gcr|Mcr|kcr|cr))/gu,
    (match, _value, unit) => {
      const level = unit === "cr" ? "kilo" : unit === "kcr" ? "mega" : "high";
      return `<span data-${level}-usage${usageCredits}>${match}</span>`;
    },
  );
}

const BREAKDOWN_FIELD_BY_LABEL = new Map([
  ["Вход", "input"],
  ["Кэш", "cache"],
  ["Выход", "output"],
  ["Думы", "reasoning"],
]);

function breakdownPartCredits(part, breakdown) {
  const label = String(part).match(/^\s*([^:<]+):/u)?.[1]?.trim();
  const field = label ? BREAKDOWN_FIELD_BY_LABEL.get(label) : null;
  return field ? Number(breakdown?.[field] ?? 0) : Number.NaN;
}

function markUsageLabel(text) {
  return String(text).replace(
    /^Итого\s+/u,
    "<span data-usage-label>Итого</span> ",
  );
}

function formatTaskUsageDetails(creditBreakdown, dayCredits) {
  const [total, ...breakdown] = formatTaskShare(creditBreakdown, dayCredits).split("<br>");
  const totalHtml = highlightUsageUnits(
    alignUsagePercent(markUsageLabel(total)),
    creditBreakdown.total,
  );
  return "<details data-task-usage-details>"
    + `<summary data-task-usage>${totalHtml}</summary>`
    + `<span data-task-usage-breakdown>${breakdown
      .map((part) => `<span data-task-usage-part>${
        highlightUsageUnits(alignUsagePercent(part), breakdownPartCredits(part, creditBreakdown))
      }</span>`)
      .join("")}</span></details>\n`;
}

function formatStreamUsage(creditBreakdown, dayCredits, elapsedSeconds, dayElapsedSeconds) {
  const [total] = formatTaskShare(creditBreakdown, dayCredits).split("<br>");
  /* Расход и время стоят в одной строке справа от названия Stream: раньше итог
     занимал отдельную строку под ним, а времени в строке не было вовсе. */
  /* Время прижато влево, расход — вправо: слева читают «сколько это заняло»,
     справа «сколько это стоило». */
  return `<span data-work-log-stream-usage>${
    formatDurationShare(elapsedSeconds, dayElapsedSeconds)
  }<span data-work-log-stream-credits>${highlightUsageUnits(
    alignUsagePercent(total.replace(/^Итого\s+/u, "")),
    creditBreakdown.total,
  )}</span></span>`;
}

function formatWorkspaceUsage(creditBreakdown, dayCredits) {
  const [total] = formatTaskShare(creditBreakdown, dayCredits).split("<br>");
  return highlightUsageUnits(
    alignUsagePercent(total.replace(/^Итого\s+/u, "")),
    creditBreakdown.total,
  );
}

function formatCollapsedWorkspaceUsage(
  creditBreakdown,
  dayCredits,
  elapsedSeconds,
  dayElapsedSeconds,
) {
  const [total, ...breakdown] = formatTaskShare(creditBreakdown, dayCredits).split("<br>");
  const totalHtml = highlightUsageUnits(
    alignUsagePercent(total.replace(/^Итого\s+/u, "")),
    creditBreakdown.total,
  );
  return "<details data-task-usage-details data-work-log-workspace-usage-details "
    + "data-work-log-collapsed-workspace-usage-details>"
    + `<summary data-task-usage>${formatDurationShare(elapsedSeconds, dayElapsedSeconds)}${
      totalHtml
    }</summary>`
    + `<span data-task-usage-breakdown>${breakdown
      .map((part) => `<span data-task-usage-part>${
        highlightUsageUnits(alignUsagePercent(part), breakdownPartCredits(part, creditBreakdown))
      }</span>`)
      .join("")}</span></details>`;
}

function formatDayUsageBreakdown(creditBreakdown) {
  const [, ...breakdown] = formatWorkLogUsage(creditBreakdown).split("<br>");
  return `<span data-day-usage-breakdown>${breakdown
    .map((part) => `<span data-day-usage-part>${
      highlightUsageUnits(alignUsagePercent(part), breakdownPartCredits(part, creditBreakdown))
    }</span>`)
    .join("")}</span>`;
}

function accountCatalogByKey(accounts = []) {
  const catalog = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const key = String(account?.key ?? account?.accountKey ?? "").trim();
    if (!key) continue;
    catalog.set(key, {
      key,
      label: String(account?.label ?? account?.accountLabel ?? "").trim(),
      type: String(account?.type ?? account?.accountType ?? "").trim(),
      planType: String(account?.planType ?? account?.accountPlan ?? "").trim(),
    });
  }
  return catalog;
}

function shortAccountKey(value) {
  const key = String(value ?? "").trim();
  if (!key) return "unknown";
  const [prefix, suffix = ""] = key.split(":", 2);
  return suffix ? `${prefix}:${suffix.slice(0, 8)}` : key.slice(0, 12);
}

function accountDisplayName(accountKey, catalog) {
  if (!accountKey) return "Неизвестный аккаунт";
  const account = catalog.get(accountKey);
  const label = String(account?.label ?? "").trim();
  return label || shortAccountKey(accountKey);
}

function shortDeviceKey(value) {
  const key = String(value ?? "").trim();
  if (!key) return "unknown";
  return key.length <= 12 ? key : key.slice(0, 8);
}

function accountDeviceDisplayName(deviceId, source, label = "") {
  const id = String(deviceId ?? "").trim();
  const displayLabel = String(label ?? "").trim();
  if (displayLabel) return displayLabel;
  if (source === "local") return id && id !== "local" ? `Это устройство · ${shortDeviceKey(id)}` : "Это устройство";
  if (id === "__sync_unlabeled__") return "Другое устройство";
  if (id.startsWith("sync-label:")) return "Другое устройство";
  if (!id || id === "unknown") return "Неизвестное устройство";
  return id.length <= 16 ? id : `device ${shortDeviceKey(id)}`;
}

function accountUsageRangeStart(range, nowMs) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  if (range === "24h") return now - 24 * 60 * 60 * 1_000;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "today") return start.getTime();
  if (range === "7d") {
    start.setDate(start.getDate() - 6);
    return start.getTime();
  }
  if (range === "15d") {
    start.setDate(start.getDate() - 14);
    return start.getTime();
  }
  if (range === "30d") {
    start.setDate(start.getDate() - 29);
    return start.getTime();
  }
  return Number.NEGATIVE_INFINITY;
}

const ACCOUNT_USAGE_RANGES = Object.freeze([
  { id: "today", title: "Сегодня" },
  { id: "24h", title: "24 часа" },
  { id: "7d", title: "7 дней" },
  { id: "15d", title: "15 дней" },
  { id: "30d", title: "30 дней" },
  { id: "all", title: "Всё время" },
]);
const NO_COST_ACCOUNT_KEY = "__no_cost__";

function recordTokenTotal(record) {
  const usage = normalizeTokenUsage(record?.usage);
  return Object.values(usage).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function recordHasNoCost(record, credits) {
  return Number(credits) <= 0
    && normalizeEstimatedCredits(record?.estimatedCredits) <= 0
    && recordTokenTotal(record) <= 0;
}

function emptyAccountUsageBucket(accountKey, catalog) {
  const noCost = accountKey === NO_COST_ACCOUNT_KEY;
  const unknown = accountKey === UNKNOWN_ACCOUNT_UI_KEY;
  const canonicalAccountKey = unknown ? "" : accountKey;
  const catalogAccount = canonicalAccountKey ? catalog.get(canonicalAccountKey) : null;
  return {
    accountKey: canonicalAccountKey,
    uiAccountKey: unknown ? UNKNOWN_ACCOUNT_UI_KEY : accountKey,
    label: noCost ? "Без расхода" : accountDisplayName(unknown ? "" : accountKey, catalog),
    type: String(catalogAccount?.type ?? "").trim(),
    planType: String(catalogAccount?.planType ?? "").trim(),
    noCost,
    unknown,
    credits: 0,
    turns: 0,
    exactTurns: 0,
    inferredTurns: 0,
    unknownTurns: 0,
    noCostTurns: 0,
    localTurns: 0,
    syncedTurns: 0,
    providers: {},
    devices: {},
  };
}

function accountMetadataFromRecord(record) {
  return {
    label: String(record?.accountLabel ?? "").trim(),
    type: String(record?.accountType ?? "").trim(),
    planType: String(record?.accountPlan ?? "").trim(),
  };
}

function mergeAccountMetadata(bucket, record) {
  if (!bucket?.accountKey) return;
  const metadata = accountMetadataFromRecord(record);
  if (!bucket.label || bucket.label === shortAccountKey(bucket.accountKey)) {
    if (metadata.label) bucket.label = metadata.label;
  }
  if (!bucket.type && metadata.type) bucket.type = metadata.type;
  if (!bucket.planType && metadata.planType) bucket.planType = metadata.planType;
}

function emptyAccountDeviceBucket(deviceId, source, { noCost = false, label = "" } = {}) {
  return {
    deviceId,
    source,
    label: accountDeviceDisplayName(deviceId, source, label),
    noCost,
    credits: 0,
    turns: 0,
    exactTurns: 0,
    inferredTurns: 0,
    unknownTurns: 0,
    noCostTurns: 0,
    localTurns: 0,
    syncedTurns: 0,
    providers: {},
  };
}

function accountUsageDeviceKey(entry, localDeviceId, record = {}) {
  if (entry.source === "local") return localDeviceId || "local";
  return String(record?.syncDeviceId ?? entry?.deviceId ?? "").trim() || "__sync_unlabeled__";
}

function applyAccountUsageStats(target, entry, record, {
  accountKey = "",
  attribution = "unknown",
  noCost = false,
} = {}) {
  target.credits += entry.credits;
  target.turns += 1;
  if (noCost) target.noCostTurns += 1;
  const provider = String(record?.provider ?? "unknown").trim().toLowerCase() || "unknown";
  target.providers[provider] = (target.providers[provider] ?? 0) + 1;
  if (entry.source === "sync") target.syncedTurns += 1;
  else target.localTurns += 1;
  if (noCost) {
    // Keep technical zero-usage turns visible without treating them as
    // unattributed billable usage.
  } else if (!accountKey) {
    target.unknownTurns += 1;
  } else if (attribution === "exact") {
    target.exactTurns += 1;
  } else {
    target.inferredTurns += 1;
  }
}

function syncedUsageRecord(value) {
  const event = normalizeUsageSyncEvent(value);
  if (!event) return null;
  return {
    usage: event.usage,
    usageReported: event.usageReported,
    estimatedCredits: event.estimatedCredits,
    model: event.model,
    serviceTier: event.serviceTier,
    provider: event.provider,
    threadId: `sync:${event.deviceId}:${event.threadKey}`,
    taskThreadId: `sync:${event.deviceId}:${event.taskKey}`,
    turnId: event.eventId,
    startedAt: event.startedAt,
    completedAt: event.completedAt,
    accountKey: event.accountKey,
    accountAttribution: event.accountAttribution,
    accountLabel: event.accountLabel,
    accountType: event.accountType,
    accountPlan: event.accountPlan,
    syncDeviceId: event.deviceId,
    syncDeviceLabel: event.deviceLabel,
    syncEventId: event.eventId,
  };
}

export function buildWorkLogAccountUsageSummary(turns = {}, {
  accountCatalog = [],
  includeClaudeUsage = true,
  syncedUsageEvents = [],
  localDeviceId = "",
  localDeviceLabel = "",
  now = Date.now(),
  ranges = ACCOUNT_USAGE_RANGES.map((range) => range.id),
} = {}) {
  const catalog = accountCatalogByKey(accountCatalog);
  const normalizedTurns = normalizedLedger({ version: 9, turns }).ledger.turns;
  const normalizedLocalDeviceId = String(localDeviceId ?? "").trim();
  const normalizedLocalDeviceLabel = String(localDeviceLabel ?? "").trim();
  const normalizedSyncedTurns = (Array.isArray(syncedUsageEvents) ? syncedUsageEvents : [])
    .map(syncedUsageRecord)
    .filter((record) => record && record.syncDeviceId !== normalizedLocalDeviceId);
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const records = [
    ...Object.values(normalizedTurns).map((record) => ({ record, source: "local", deviceId: "" })),
    ...normalizedSyncedTurns.map((record) => ({
      record,
      source: "sync",
      deviceId: String(record?.syncDeviceId ?? "").trim(),
    })),
  ]
    .filter((entry) => includeClaudeUsage
      || String(entry.record?.provider ?? "").toLowerCase() !== "claude")
    .map((entry) => ({
      ...entry,
      timestamp: Date.parse(entry.record?.completedAt || entry.record?.startedAt || ""),
      credits: recordCredits(entry.record),
    }))
    .filter((entry) => Number.isFinite(entry.timestamp) && entry.timestamp <= nowMs);
  const rangeSet = new Set(ranges.map((range) => String(range)));
  return ACCOUNT_USAGE_RANGES
    .filter((range) => rangeSet.has(range.id))
    .map((range) => {
      const fromMs = accountUsageRangeStart(range.id, nowMs);
      const accounts = new Map();
      let totalCredits = 0;
      let totalTurns = 0;
      let exactTurns = 0;
      let inferredTurns = 0;
      let unknownTurns = 0;
      let noCostTurns = 0;
      let syncedTurns = 0;
      for (const entry of records) {
        if (entry.timestamp < fromMs) continue;
        const record = entry.record;
        const accountKey = String(record?.accountKey ?? "").trim();
        const noCost = !accountKey && recordHasNoCost(record, entry.credits);
        const key = accountKey || (noCost ? NO_COST_ACCOUNT_KEY : UNKNOWN_ACCOUNT_UI_KEY);
        if (!accounts.has(key)) accounts.set(key, emptyAccountUsageBucket(key, catalog));
        const bucket = accounts.get(key);
        const attribution = normalizeAccountAttribution(record?.accountAttribution, {
          hasAccountKey: Boolean(accountKey),
        });
        mergeAccountMetadata(bucket, record);
        applyAccountUsageStats(bucket, entry, record, { accountKey, attribution, noCost });
        const deviceKey = accountUsageDeviceKey(entry, normalizedLocalDeviceId, record);
        if (!bucket.devices[deviceKey]) {
          bucket.devices[deviceKey] = emptyAccountDeviceBucket(deviceKey, entry.source, {
            noCost: bucket.noCost,
            label: entry.source === "local" ? normalizedLocalDeviceLabel : record?.syncDeviceLabel,
          });
        }
        const deviceBucket = bucket.devices[deviceKey];
        if (deviceBucket.source !== entry.source) {
          deviceBucket.source = "mixed";
          deviceBucket.label = accountDeviceDisplayName(deviceKey, "mixed", record?.syncDeviceLabel);
        }
        applyAccountUsageStats(deviceBucket, entry, record, { accountKey, attribution, noCost });
        if (noCost) {
          noCostTurns += 1;
        }
        if (entry.source === "sync") {
          syncedTurns += 1;
        }
        if (noCost) {
          // Keep technical zero-usage turns visible without treating them as
          // unattributed billable usage.
        } else if (!accountKey) {
          unknownTurns += 1;
        } else if (attribution === "exact") {
          exactTurns += 1;
        } else {
          inferredTurns += 1;
        }
        totalCredits += entry.credits;
        totalTurns += 1;
      }
      return {
        id: range.id,
        title: range.title,
        from: Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : null,
        to: new Date(nowMs).toISOString(),
        totalCredits,
        totalTurns,
        exactTurns,
        inferredTurns,
        unknownTurns,
        noCostTurns,
        syncedTurns,
        accounts: [...accounts.values()].map((account) => ({
          ...account,
          devices: Object.values(account.devices).sort((left, right) => (
            right.credits - left.credits
            || right.turns - left.turns
            || left.label.localeCompare(right.label)
          )),
        })).sort((left, right) => (
          right.credits - left.credits
          || right.turns - left.turns
          || left.label.localeCompare(right.label)
        )),
      };
    });
}

function providerTitle(provider) {
  if (provider === "codex") return "Codex";
  if (provider === "claude") return "Claude";
  return provider;
}

function sortedProviders(providers = {}) {
  return Object.entries(providers)
    .filter(([, count]) => Number(count) > 0)
    .sort(([left], [right]) => left.localeCompare(right));
}

function formatProviderCounts(providers = {}) {
  return sortedProviders(providers)
    .map(([provider, count]) => `${providerTitle(provider)} ${count}`)
    .join(" · ");
}

/* В строке устройства колонка провайдера несёт только модель: число ходов у
   устройства уже стоит в собственной колонке. */
function formatProviderNames(providers = {}) {
  return sortedProviders(providers).map(([provider]) => providerTitle(provider)).join(" · ");
}

function pluralize(count, [one, few, many]) {
  const value = Math.max(0, Math.trunc(Number(count) || 0));
  const tens = value % 100;
  const ones = value % 10;
  if (tens >= 11 && tens <= 14) return `${value} ${many}`;
  if (ones === 1) return `${value} ${one}`;
  if (ones >= 2 && ones <= 4) return `${value} ${few}`;
  return `${value} ${many}`;
}

function pluralizeAccounts(count) {
  return pluralize(count, ["аккаунт", "аккаунта", "аккаунтов"]);
}

function pluralizeDevices(count) {
  return pluralize(count, ["устройство", "устройства", "устройств"]);
}

function pluralizeTurns(count) {
  return pluralize(count, ["ход", "хода", "ходов"]);
}

/* Цвет аккаунта повторяет палитру серий статистики: один и тот же аккаунт
   получает один и тот же слот в журнале и на графиках лимитов. */
const ACCOUNT_COLOR_SLOTS = 6;

function accountColorSlot(accountKey) {
  const key = String(accountKey ?? "");
  if (!key || key === UNKNOWN_ACCOUNT_UI_KEY) return "none";
  const hash = [...key]
    .reduce((value, character) => ((value * 31) + character.codePointAt(0)) >>> 0, 0);
  return String(hash % ACCOUNT_COLOR_SLOTS);
}

/* «Сегодня» читается без предлога, остальные периоды — с ним. */
function accountRangeIdleSuffix(range) {
  return range.id === "today" ? "сегодня" : `за ${String(range.title).toLowerCase()}`;
}

function accountUsageAmountParts(credits) {
  const text = formatCredits(credits);
  const match = /^(.*?)\s+(Gcr|Mcr|kcr|cr)$/u.exec(text);
  return match ? { amount: match[1], unit: match[2] } : { amount: text, unit: "" };
}

function formatAccountQuality(account) {
  if (account.noCost) {
    return account.noCostTurns ? `без расхода ${account.noCostTurns}` : "без расхода";
  }
  const parts = [];
  if (account.exactTurns) parts.push(`точно ${account.exactTurns}`);
  if (account.inferredTurns) parts.push(`восст. ${account.inferredTurns}`);
  if (account.unknownTurns) parts.push(`без ключа ${account.unknownTurns}`);
  if (account.noCostTurns) parts.push(`без расхода ${account.noCostTurns}`);
  if (account.syncedTurns) parts.push(`sync ${account.syncedTurns}`);
  return parts.join(" · ") || "нет данных";
}

function accountDevices(account) {
  return Array.isArray(account?.devices) ? account.devices : [];
}

function deviceSourceLabel(device) {
  if (device.source === "local") return "local";
  if (device.source === "sync") return "sync";
  return "local+sync";
}

function accountDeviceName(device) {
  const id = String(device?.deviceId ?? "").trim();
  const label = String(device?.label ?? "").trim();
  if (label) {
    if (device?.source === "local" && label.startsWith("Это устройство ·")) return "Это устройство";
    return label;
  }
  if (device?.source === "sync") {
    return !id || id === "unknown" ? "Неизвестное устройство" : "Другое устройство";
  }
  return "Это устройство";
}

function accountDeviceShortId(device) {
  const id = String(device?.deviceId ?? "").trim();
  if (!id || id === "unknown" || id === "local") return "";
  if (id === "__sync_unlabeled__" || id.startsWith("sync-label:")) return "";
  return shortDeviceKey(id);
}

/* Полоса аккаунта разложена по его устройствам. В строке аккаунта сегменты
   показывают вклад в общий период, в строке устройства — только область этого
   устройства внутри аккаунта. */
function shareSegments(devices, total) {
  return devices.map((device, index) => ({
    index,
    share: total > 0 && device.credits > 0 ? device.credits / total * 100 : 0,
  })).filter((segment) => segment.share > 0);
}

function formatShareSegments(segments, currentIndex = -1) {
  return segments.map((segment) => "<span data-work-log-account-bar-segment "
    + `data-device-index="${escapeHtmlAttribute(String(Math.min(segment.index, 3)))}"`
    + (segment.index === currentIndex ? " data-current" : "")
    + `${currentIndex >= 0 && segment.index !== currentIndex ? " data-muted" : ""} `
    + `data-account-share="${escapeHtmlAttribute(segment.share.toFixed(2))}"></span>`).join("");
}

function formatDeviceShareFill(devices, currentIndex, total) {
  let offset = 0;
  let share = 0;
  for (let index = 0; index < devices.length; index += 1) {
    const deviceShare = total > 0 && devices[index]?.credits > 0
      ? devices[index].credits / total * 100
      : 0;
    if (index === currentIndex) {
      share = deviceShare;
      break;
    }
    offset += deviceShare;
  }
  return "<span data-work-log-account-bar-device-fill "
    + `data-device-index="${escapeHtmlAttribute(String(Math.min(currentIndex, 3)))}" `
    + `data-account-offset="${escapeHtmlAttribute(offset.toFixed(2))}" `
    + `data-account-share="${escapeHtmlAttribute(share.toFixed(2))}"></span>`;
}

function formatAccountUsageRow(account, totalCredits, groupId) {
  const devices = accountDevices(account);
  const uiAccountKey = String(account.uiAccountKey || account.accountKey || "");
  const share = totalCredits > 0 && account.credits > 0
    ? Math.round(account.credits / totalCredits * 100)
    : 0;
  const segments = shareSegments(devices, totalCredits);
  return '<button type="button" data-work-log-account-row '
    + `data-account-key="${escapeHtmlAttribute(uiAccountKey)}" `
    + `data-account-color="${escapeHtmlAttribute(accountColorSlot(uiAccountKey))}" `
    + `data-account-attribution-exact="${escapeHtmlAttribute(String(account.exactTurns))}" `
    + `data-account-attribution-inferred="${escapeHtmlAttribute(String(account.inferredTurns))}" `
    + (account.noCost ? "data-account-no-cost " : "")
    + `data-account-sync-turns="${escapeHtmlAttribute(String(account.syncedTurns))}" `
    + `data-account-turns="${escapeHtmlAttribute(String(account.turns))}" `
    + `data-account-credits="${escapeHtmlAttribute(String(account.credits))}" `
    + `aria-expanded="false" aria-controls="${escapeHtmlAttribute(groupId)}"`
    + (devices.length ? "" : " disabled")
    + ">"
    + "<span data-work-log-account-name>"
    + '<span data-work-log-account-caret aria-hidden="true"></span>'
    + "<span data-work-log-account-identity>"
    + `<span data-work-log-account-label>${escapeHtmlText(account.label)}</span>`
    + `<span data-work-log-account-quality>${escapeHtmlText(formatAccountQuality(account))}</span>`
    + (devices.length
      ? `<span data-work-log-account-device-count>${escapeHtmlText(pluralizeDevices(devices.length))}</span>`
      : "")
    + "</span>"
    + "</span>"
    + "<span data-work-log-account-provider>"
    + (account.type
      ? `<span data-work-log-account-provider-name>${escapeHtmlText(account.type)}</span>`
      : "")
    + (account.planType
      ? `<span data-work-log-account-plan>${escapeHtmlText(account.planType)}</span>`
      : "")
    + "</span>"
    + `<span data-work-log-account-bar aria-hidden="true">${formatShareSegments(segments)}</span>`
    + `<span data-work-log-account-share>${share}%</span>`
    + `<span data-work-log-account-turns>${account.turns}</span>`
    + `<span data-work-log-account-credits>${highlightUsageUnits(formatCredits(account.credits), account.credits)}</span>`
    + "</button>";
}

function formatAccountDeviceRow(account, device, index) {
  const devices = accountDevices(account);
  const uiAccountKey = String(account.uiAccountKey || account.accountKey || "");
  const share = account.credits > 0 && device.credits > 0
    ? Math.round(device.credits / account.credits * 100)
    : 0;
  const providers = formatProviderNames(device.providers);
  const shortId = accountDeviceShortId(device);
  const deviceFill = formatDeviceShareFill(devices, index, account.credits);
  return "<div data-work-log-account-device-row "
    + `data-account-key="${escapeHtmlAttribute(uiAccountKey)}" `
    + `data-device-id="${escapeHtmlAttribute(device.deviceId)}" `
    + `data-device-source="${escapeHtmlAttribute(device.source)}" `
    + `data-device-index="${escapeHtmlAttribute(String(Math.min(index, 3)))}" `
    + `data-account-color="${escapeHtmlAttribute(accountColorSlot(uiAccountKey))}" `
    + `data-account-turns="${escapeHtmlAttribute(String(device.turns))}" `
    + `data-account-credits="${escapeHtmlAttribute(String(device.credits))}">`
    + "<span data-work-log-account-name>"
    + '<span data-work-log-account-device-rail aria-hidden="true"></span>'
    + '<span data-work-log-account-device-swatch aria-hidden="true"></span>'
    + "<span data-work-log-account-identity>"
    + "<span data-work-log-account-device-head>"
    + `<span data-work-log-account-device-label>${escapeHtmlText(accountDeviceName(device))}</span>`
    + (shortId ? `<span data-work-log-account-device-id>${escapeHtmlText(shortId)}</span>` : "")
    + `<span data-work-log-account-device-origin>${escapeHtmlText(deviceSourceLabel(device))}</span>`
    + "</span>"
    + `<span data-work-log-account-device-quality>${escapeHtmlText(formatAccountQuality(device))}</span>`
    + "</span>"
    + "</span>"
    + "<span data-work-log-account-provider>"
    + (providers
      ? `<span data-work-log-account-provider-name>${escapeHtmlText(providers)}</span>`
      : "")
    + "</span>"
    + `<span data-work-log-account-bar aria-hidden="true">${deviceFill}</span>`
    + `<span data-work-log-account-share>${share}%</span>`
    + `<span data-work-log-account-turns>${device.turns}</span>`
    + `<span data-work-log-account-credits>${highlightUsageUnits(formatCredits(device.credits), device.credits)}</span>`
    + "</div>";
}

function formatAccountUsageGroup(account, totalCredits, rangeId) {
  const devices = accountDevices(account);
  const uiAccountKey = String(account.uiAccountKey || account.accountKey || "");
  const accountId = String(uiAccountKey || "unknown").replace(/[^a-z0-9]+/giu, "-");
  const groupId = `work-log-account-devices-${rangeId}-${accountId}`;
  const deviceRows = devices.length
    ? `<div data-work-log-account-devices-breakdown id="${escapeHtmlAttribute(groupId)}">`
      + devices.map((device, index) => formatAccountDeviceRow(account, device, index)).join("")
      + "</div>"
    : "";
  return `<div data-work-log-account-group data-account-key="${escapeHtmlAttribute(uiAccountKey)}">`
    + formatAccountUsageRow(account, totalCredits, groupId)
    + deviceRows
    + "</div>";
}

function formatAccountUsagePeriodTab(range, active) {
  const { amount, unit } = accountUsageAmountParts(range.totalCredits);
  return '<button type="button" data-work-log-account-period-tab '
    + `data-account-range="${escapeHtmlAttribute(range.id)}"${active ? " data-active" : ""} `
    + `aria-expanded="${active ? "true" : "false"}" `
    + `aria-controls="work-log-account-period-${escapeHtmlAttribute(range.id)}">`
    + "<span data-work-log-account-period-name>"
    + '<span data-work-log-account-period-dot aria-hidden="true"></span>'
    + `<span data-work-log-account-period-title>${escapeHtmlText(range.title)}</span>`
    + "</span>"
    + '<span data-work-log-account-period-value '
    + `data-account-credits="${escapeHtmlAttribute(String(range.totalCredits))}">`
    + `<span data-work-log-account-period-amount>${escapeHtmlText(amount)}</span>`
    + `<span data-work-log-account-period-unit>${escapeHtmlText(unit)}</span>`
    + "</span>"
    + `<span data-work-log-account-period-turns>${range.totalTurns} ход.</span>`
    + `<span data-work-log-account-period-quality>${escapeHtmlText(formatAccountQuality(range))}</span>`
    + "</button>";
}

/* Телефон показывает активный период отдельным блоком, поэтому те же заголовок,
   сумма и качество живут и в плитке десктопа, и в шапке тела периода. */
function formatAccountUsagePeriodHeadline(range) {
  const { amount, unit } = accountUsageAmountParts(range.totalCredits);
  return "<div data-work-log-account-period-headline>"
    + `<span data-work-log-account-period-headline-title>${escapeHtmlText(range.title)}</span>`
    + `<span data-work-log-account-period-headline-quality>${escapeHtmlText(formatAccountQuality(range))}</span>`
    + '<span data-work-log-account-period-value data-work-log-account-period-headline-value '
    + `data-account-credits="${escapeHtmlAttribute(String(range.totalCredits))}">`
    + `<span data-work-log-account-period-amount>${escapeHtmlText(amount)}</span>`
    + `<span data-work-log-account-period-unit>${escapeHtmlText(unit)}</span>`
    + "</span>"
    + `<span data-work-log-account-period-headline-turns>${range.totalTurns} ход.</span>`
    + "</div>";
}

function formatAccountUsageFootNote(range, accountCount) {
  const billable = range.accounts.filter((account) => !account.noCost);
  const idleCount = Math.max(0, accountCount - billable.length);
  return [
    idleCount ? `Ещё ${pluralizeAccounts(idleCount)} без расхода ${accountRangeIdleSuffix(range)}` : "",
    range.noCostTurns ? `${pluralizeTurns(range.noCostTurns)} без стоимости` : "",
  ].filter(Boolean).join(" · ");
}

function formatAccountUsagePeriodBody(range, active, accountCount) {
  // Ходы без стоимости не занимают отдельную строку с нулём: их место в подвале.
  const billable = range.accounts.filter((account) => !account.noCost);
  const rows = billable.length
    ? billable.map((account) => formatAccountUsageGroup(account, range.totalCredits, range.id)).join("")
    : '<div data-work-log-account-empty>За период нет записанного расхода.</div>';
  return "<div data-work-log-account-period-body "
    + `data-account-range="${escapeHtmlAttribute(range.id)}"${active ? " data-active" : ""} `
    + `id="work-log-account-period-${escapeHtmlAttribute(range.id)}">`
    + formatAccountUsagePeriodHeadline(range)
    + '<div data-work-log-account-columns aria-hidden="true">'
    + `<span data-work-log-account-column="account">Аккаунт · ${escapeHtmlText(String(range.title).toLowerCase())}</span>`
    + '<span data-work-log-account-column="provider">Провайдер</span>'
    + '<span data-work-log-account-column="share">Доля расхода</span>'
    + '<span data-work-log-account-column="turns">Ходы</span>'
    + '<span data-work-log-account-column="credits">Расход</span>'
    + "</div>"
    + `<div data-work-log-account-rows>${rows}</div>`
    + "<div data-work-log-account-foot>"
    + `<span data-work-log-account-idle>${escapeHtmlText(formatAccountUsageFootNote(range, accountCount))}</span>`
    + "<span data-work-log-account-total>итого "
    + highlightUsageUnits(formatCredits(range.totalCredits), range.totalCredits)
    + ` · ${range.totalTurns} ход.</span>`
    + "</div>"
    + "</div>";
}

function formatAccountUsagePanel(summary) {
  if (!summary.some((range) => range.accounts.some((account) => (
    !account.noCost && (account.accountKey || account.credits >= 1)
  )))) return "";
  const all = summary.find((range) => range.id === "all") ?? summary.at(-1);
  const accountCount = new Set(all?.accounts
    .filter((account) => !account.noCost)
    .map((account) => account.accountKey || "unknown")).size;
  const activeId = summary[0]?.id;
  return "<!-- work-log-account-panel:start -->"
    + '<section data-work-log-account-panel>'
    + '<div data-work-log-account-panel-head>'
    + '<span data-work-log-account-panel-caption>Расход по аккаунтам</span>'
    + `<span data-work-log-account-panel-total>${pluralizeAccounts(accountCount)}</span>`
    + '<span data-work-log-account-panel-note>exact — текущие записи · inferred — восстановлено · sync — другие устройства</span>'
    + '<button type="button" data-work-log-account-devices-toggle aria-pressed="false">'
    + "Показать устройства</button>"
    + "</div>"
    + '<div data-work-log-account-periods>'
    + summary.map((range) => formatAccountUsagePeriodTab(range, range.id === activeId)
      + formatAccountUsagePeriodBody(range, range.id === activeId, accountCount)).join("")
    + "</div>"
    + "</section>"
    + "<!-- work-log-account-panel:end -->";
}

function removeAccountUsagePanel(text) {
  return String(text ?? "").replace(
    /\n?<!-- work-log-account-panel:start -->[\s\S]*?<!-- work-log-account-panel:end -->\n?/giu,
    "\n",
  );
}

function insertAccountUsagePanel(text, panel) {
  const source = removeAccountUsagePanel(text);
  if (!panel) return source;
  const rateLimits = /<div\b[^>]*data-work-log-rate-limits\b[^>]*>[\s\S]*?<\/div>/iu.exec(source);
  if (rateLimits) {
    const insertion = rateLimits.index + rateLimits[0].length;
    return `${source.slice(0, insertion)}\n${panel}\n${source.slice(insertion)}`;
  }
  const heading = /^# [^\r\n]+(?:\r?\n)?/u.exec(source);
  if (heading) {
    return `${source.slice(0, heading[0].length)}\n${panel}\n${source.slice(heading[0].length)}`;
  }
  return `${panel}\n${source}`;
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

function recordsDurationSeconds(records) {
  return records.reduce(
    (total, record) => total + (durationSeconds(record?.startedAt, record?.completedAt) ?? 0),
    0,
  );
}

function formatSummaryDuration(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const totalMinutes = seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours} ч ${minutes} мин` : `${minutes} мин`;
}

function formatDurationShare(totalSeconds, dayTotalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  if (seconds <= 0) return "";
  const daySeconds = Math.max(0, Number(dayTotalSeconds) || 0);
  const percent = daySeconds > 0 ? Math.round(seconds / daySeconds * 100) : 0;
  /* Сначала доля, затем само время: так числа в колонке времени выровнены по
     одинаковому началу, а длинное «8 ч 20 мин» не сдвигает процент. */
  return `<span data-work-log-duration-summary data-work-log-duration-seconds="${seconds}">`
    + `<span data-work-log-duration-percent>(${percent}%)</span>`
    + ` <span data-work-log-duration>${formatSummaryDuration(seconds)}</span></span>`;
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

function formatTurnEntry(
  record,
  _legacyFiles = "",
  taskCredits = 0,
  depth = 0,
  children = "",
  treeCredits = null,
  descendantCount = 0,
  treeCreditsKnown = false,
) {
  const breakdown = recordCreditBreakdown(record);
  const recordTotal = breakdown.total;
  const displayedTotal = Number.isFinite(treeCredits) ? Math.max(0, treeCredits) : recordTotal;
  const elapsedSeconds = durationSeconds(record?.startedAt, record?.completedAt);
  const creditsKnown = recordCreditsKnown(record, breakdown);
  const ownCredits = record?.usageReported === false && recordTotal <= 0
    ? "нет данных"
    : !breakdown.priced && recordTotal <= 0
      ? "нет тарифа"
      : highlightUsageUnits(formatCredits(recordTotal), recordTotal);
  const credits = displayedTotal > 0
    ? highlightUsageUnits(formatCredits(displayedTotal), displayedTotal)
    : ownCredits;
  const share = taskCredits > 0 && displayedTotal > 0
    ? `${Math.round(displayedTotal / taskCredits * 100)}%`
    : "";
  const title = escapeHtmlText(turnTitle(record));
  const stream = String(record?.workLogStreamDisplayName ?? "").trim();
  const streamTitle = stream
    ? `<span data-work-log-turn-stream>${escapeHtmlText(stream)}</span>`
      + `<span data-work-log-turn-heading>${title}</span>`
    : title;
  const body = escapeHtmlText(String(record?.body ?? record?.text ?? "").trim());
  const prompt = escapeHtmlText(displayUserPrompt(record?.prompt));
  const fastMultiplier = fastModeCreditMultiplier(record?.model, record?.serviceTier);
  const pricing = record?.model
    ? `<div data-work-log-turn-pricing>${
      escapeHtmlText(record.model)
    }${record.serviceTier === "fast" ? ` · Fast ×${String(fastMultiplier).replace(".", ",")}` : ""}</div>`
    : "";
  const metaDetails = [
    `<div data-work-log-turn-facts>${pricing}`
      + `<div data-work-log-turn-context><strong>Длит.:</strong> ${
        formatDuration(record?.startedAt, record?.completedAt)
      }</div>`
      + (descendantCount > 0
        ? `<div data-work-log-turn-own-usage><strong>Свой расход:</strong> ${ownCredits}</div>`
        : "")
      + "</div>",
    prompt ? `<div data-work-log-turn-prompt><strong>Запрос:</strong> ${prompt}</div>` : "",
  ].filter(Boolean).join("");
  const bodyDetails = body ? `<div data-work-log-turn-body>${body}</div>` : "";
  const provider = escapeHtmlAttribute(record?.provider);
  const turnThread = escapeHtmlAttribute(record?.threadId);
  const rootThread = escapeHtmlAttribute(taskThreadId(record));
  const parentThread = escapeHtmlAttribute(record?.parentThreadId);
  const parentTurn = escapeHtmlAttribute(record?.parentTurnId);
  const timingAttributes = elapsedSeconds === null
    ? ""
    : ` data-work-log-turn-duration-seconds="${elapsedSeconds}"`;
  const completedAtAttribute = record?.completedAt
    ? ` data-work-log-turn-completed-at="${escapeHtmlAttribute(record.completedAt)}"`
    : "";
  const creditsAttribute = creditsKnown
    ? ` data-work-log-turn-credits="${escapeHtmlAttribute(String(recordTotal))}"`
    : "";
  const totalCreditsAttribute = treeCreditsKnown
    ? ` data-work-log-turn-total-credits="${escapeHtmlAttribute(String(displayedTotal))}"`
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
  const toolProfileAttributes = record?.toolMetricsKnown === true
    ? " "
      + `data-work-log-turn-skills="${escapeHtmlAttribute(JSON.stringify(
        normalizedSkillsUsed(record?.skillsUsed)
      ))}" `
      + `data-work-log-turn-mcp-calls="${escapeHtmlAttribute(String(
        normalizedMcpCalls(record?.mcpCalls).length
      ))}" `
      + `data-work-log-turn-mcp-tools="${escapeHtmlAttribute(JSON.stringify(
        [...new Set(normalizedMcpCalls(record?.mcpCalls).map((call) => (
          [call.server, call.tool].filter(Boolean).join("/")
        )).filter(Boolean))]
      ))}" `
      + `data-work-log-turn-mcp-failures="${escapeHtmlAttribute(String(
        normalizedMcpCalls(record?.mcpCalls).filter((call) => call.status === "failed").length
      ))}"`
    : "";
  return `<div data-work-log-turn-entry data-work-log-turn-provider="${provider}" `
    + `data-work-log-turn-thread-id="${turnThread}" data-work-log-task-thread-id="${rootThread}" `
    + `data-work-log-turn-parent-thread-id="${parentThread}" data-work-log-turn-parent-turn-id="${parentTurn}" `
    + `data-work-log-turn-depth="${escapeHtmlAttribute(String(depth))}" `
    + `data-work-log-turn-id="${escapeHtmlAttribute(record?.turnId)}" ${profileAttributes}${toolProfileAttributes}`
    + `${timingAttributes}${completedAtAttribute}${creditsAttribute}${totalCreditsAttribute}>`
    + "<details data-work-log-turn-details>"
    + "<summary>"
    + '<span data-work-log-turn-meta>'
    + `<span data-work-log-turn-measure>${formatCompletedAt(record?.completedAt)} — ${credits}</span>`
    + (share ? `<span data-work-log-turn-share>(${share})</span>` : "")
    + "</span>"
    + `<span data-work-log-turn-title>${streamTitle}</span>`
    /* Переключатель субагентов живёт в самой строке хода: отдельная широкая
       кнопка под ней разрывала список и занимала целую строку. */
    + (children
      ? '<button type="button" data-toggle-subagents aria-pressed="false"'
        + ` aria-label="Субагенты (${descendantCount})" title="Субагенты (${descendantCount})">`
        + '<svg data-phosphor-icon="tree-structure" viewBox="0 0 256 256" aria-hidden="true">'
        + '<rect x="32" y="40" width="56" height="48" rx="8" fill="none" stroke="currentColor"'
        + ' stroke-linecap="round" stroke-linejoin="round" stroke-width="18"></rect>'
        + '<rect x="168" y="24" width="56" height="48" rx="8" fill="none" stroke="currentColor"'
        + ' stroke-linecap="round" stroke-linejoin="round" stroke-width="18"></rect>'
        + '<rect x="168" y="168" width="56" height="48" rx="8" fill="none" stroke="currentColor"'
        + ' stroke-linecap="round" stroke-linejoin="round" stroke-width="18"></rect>'
        + '<path d="M88 64h32a16 16 0 0 1 16 16v96a16 16 0 0 0 16 16h16M136 96V64a16 16 0 0 1 16-16h16"'
        + ' fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"'
        + ' stroke-width="18"></path>'
        + `</svg><span data-subagent-count>${descendantCount}</span></button>`
      : "")
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
    + "</div></details>"
    + (children
      ? "<details data-work-log-turn-children-details><summary>"
        + `<span data-work-log-turn-children-closed>Показать субагентов (${descendantCount})</span>`
        + '<span data-work-log-turn-children-open>Свернуть субагентов</span>'
        + `</summary><div data-work-log-turn-children>${children}</div></details>`
      : "")
    + "</div>";
}

function recordTimestamp(record) {
  const value = Date.parse(String(record?.completedAt || record?.startedAt || ""));
  return Number.isFinite(value) ? value : 0;
}

function turnTree(records) {
  const nodes = records.map((record, index) => ({
    record,
    index,
    children: [],
    latestAt: recordTimestamp(record),
  }));
  const exact = new Map(nodes.map((node) => [
    `${String(node.record?.threadId ?? "").trim()}\u0000${String(node.record?.turnId ?? "").trim()}`,
    node,
  ]));
  const byThread = new Map();
  for (const node of nodes) {
    const threadId = String(node.record?.threadId ?? "").trim();
    if (!byThread.has(threadId)) byThread.set(threadId, []);
    byThread.get(threadId).push(node);
  }
  const roots = [];
  for (const node of nodes) {
    const parentThreadId = String(node.record?.parentThreadId ?? "").trim();
    const parentTurnId = String(node.record?.parentTurnId ?? "").trim();
    let parent = parentThreadId && parentTurnId
      ? exact.get(`${parentThreadId}\u0000${parentTurnId}`)
      : null;
    if (!parent && parentThreadId) {
      const childStartedAt = Date.parse(String(node.record?.startedAt || node.record?.completedAt || ""));
      const candidates = (byThread.get(parentThreadId) ?? [])
        .filter((candidate) => candidate !== node)
        .map((candidate) => ({
          candidate,
          startedAt: Date.parse(String(candidate.record?.startedAt || candidate.record?.completedAt || "")),
          completedAt: Date.parse(String(candidate.record?.completedAt || candidate.record?.startedAt || "")),
        }))
        .filter(({ startedAt }) => !Number.isFinite(childStartedAt)
          || !Number.isFinite(startedAt)
          || startedAt <= childStartedAt)
        .sort((left, right) => (right.startedAt || 0) - (left.startedAt || 0));
      parent = candidates.find(({ completedAt }) => !Number.isFinite(childStartedAt)
        || !Number.isFinite(completedAt)
        || completedAt >= childStartedAt)?.candidate ?? candidates[0]?.candidate ?? null;
    }
    if (parent) {
      node.parent = parent;
      parent.children.push(node);
    }
    else roots.push(node);
  }
  const reachable = new Set();
  const markReachable = (node) => {
    if (reachable.has(node)) return;
    reachable.add(node);
    for (const child of node.children) markReachable(child);
  };
  for (const root of roots) markReachable(root);
  for (const node of nodes) {
    if (reachable.has(node)) continue;
    if (node.parent) node.parent.children = node.parent.children.filter((child) => child !== node);
    node.parent = null;
    roots.push(node);
    markReachable(node);
  }
  const sortAndMeasure = (node, ancestors = new Set()) => {
    if (ancestors.has(node)) return node.latestAt;
    const nextAncestors = new Set(ancestors).add(node);
    node.children = node.children.filter((child) => !nextAncestors.has(child));
    for (const child of node.children) {
      node.latestAt = Math.max(node.latestAt, sortAndMeasure(child, nextAncestors));
    }
    node.children.sort((left, right) => right.latestAt - left.latestAt || left.index - right.index);
    return node.latestAt;
  };
  for (const root of roots) sortAndMeasure(root);
  roots.sort((left, right) => right.latestAt - left.latestAt || left.index - right.index);
  return roots;
}

function treeNodeCount(node) {
  return 1 + node.children.reduce((total, child) => total + treeNodeCount(child), 0);
}

function treeNodeCredits(node) {
  return recordCredits(node.record)
    + node.children.reduce((total, child) => total + treeNodeCredits(child), 0);
}

function treeNodeCreditsKnown(node) {
  return recordCreditsKnown(node.record)
    || node.children.some((child) => treeNodeCreditsKnown(child));
}

function formatTurnTreeNode(node, taskCredits, depth = 0) {
  const children = node.children
    .map((child) => formatTurnTreeNode(child, taskCredits, depth + 1))
    .join("\n");
  return formatTurnEntry(
    node.record,
    "",
    taskCredits,
    depth,
    children,
    treeNodeCredits(node),
    treeNodeCount(node) - 1,
    treeNodeCreditsKnown(node),
  );
}

function formatTurnTable(records, legacyOutcome = "", legacyFiles = "") {
  const taskCredits = records.reduce(
    (total, record) => total + recordCredits(record),
    0,
  );
  const roots = turnTree(records);
  const turnRows = roots.map((node) => formatTurnTreeNode(node, taskCredits));
  const previousTurnCount = roots.slice(1).reduce(
    (total, node) => total + treeNodeCount(node),
    0,
  );
  const previousTurns = turnRows.length > 1
    ? [
      "<details data-work-log-previous-turns>",
      "<summary>",
      `<span data-work-log-previous-turns-closed>Показать предыдущие ходы (${previousTurnCount})</span>`,
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
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  const resolved = Number.isNaN(date.getTime()) ? new Date() : date;
  return [
    twoDigits(resolved.getDate()),
    twoDigits(resolved.getMonth() + 1),
    resolved.getFullYear(),
  ].join(".");
}

function recordLocalDate(value) {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? "" : formatLocalDate(date);
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

function layoutContainer(content, { workspaceHierarchy = false } = {}) {
  return [
    "<div data-work-log-table>",
    `<div data-work-log-header><strong>${workspaceHierarchy ? "Workspace" : "Поток"}</strong><strong>Ходы</strong></div>`,
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

function turnProjectionIndex(turns) {
  const recordsByDate = new Map();
  const automaticByIdentity = new Map();
  for (const record of Object.values(turns)) {
    const date = recordLocalDate(record.completedAt);
    if (!date) continue;
    const datedRecords = recordsByDate.get(date) ?? [];
    datedRecords.push(record);
    recordsByDate.set(date, datedRecords);
    const provider = String(record.provider ?? "").trim().toLowerCase();
    const threadId = taskThreadId(record);
    if (!provider || !record.threadId || !threadId || isContextProbeRecord(record)) continue;
    const key = `${date}\0${provider}\0${threadId}`;
    const automaticRecords = automaticByIdentity.get(key) ?? [];
    automaticRecords.push(record);
    automaticByIdentity.set(key, automaticRecords);
  }
  return { recordsByDate, automaticByIdentity };
}

function unclaimedAutomaticRecords(records, claimedWorkLogIds) {
  return (records ?? []).filter((record) => (
    !record.workLogId || !claimedWorkLogIds.has(record.workLogId)
  ));
}

function automaticRecordsForDay(index, date, claimedWorkLogIds = new Set()) {
  const records = [];
  const prefix = `${date}\0`;
  for (const [key, values] of index.automaticByIdentity) {
    if (key.startsWith(prefix)) records.push(...values);
  }
  return unclaimedAutomaticRecords(records, claimedWorkLogIds);
}

function automaticRecordsForIdentity(index, date, identity, claimedWorkLogIds = new Set()) {
  const key = `${date}\0${identity.provider}\0${identity.threadId}`;
  return unclaimedAutomaticRecords(index.automaticByIdentity.get(key), claimedWorkLogIds);
}

export function taskThreadId(record) {
  return String(record?.taskThreadId ?? record?.threadId ?? "").trim();
}

/* Workspace/Stream is durable Hub metadata rather than a ledger field.  A
   completed record must remain replayable from rollout alone, therefore the
   projection asks the catalog for the current root Thread binding and never
   persists a copied workspace id into record_json. */
function workspaceResolutionForRecord(record, workspaceResolver) {
  if (typeof workspaceResolver !== "function") return null;
  const provider = String(record?.provider ?? "").trim().toLowerCase();
  const threadId = taskThreadId(record);
  if (!provider || !threadId) return null;
  try {
    const resolved = workspaceResolver({
      provider,
      threadId,
      projectRoot: normalizeProjectRoot(record?.projectRoot),
    });
    if (!resolved?.workspaceId || !resolved?.streamId) return null;
    return {
      workspaceId: String(resolved.workspaceId),
      workspaceName: String(resolved.workspaceName ?? "Other"),
      workspaceKind: String(resolved.workspaceKind ?? "user"),
      streamId: String(resolved.streamId),
      streamName: resolved.streamName == null ? null : String(resolved.streamName),
      streamOrdinal: Math.max(1, Number(resolved.streamOrdinal) || 1),
      streamDisplayName: String(resolved.streamDisplayName ?? ""),
    };
  } catch {
    // A deleted or still-unmigrated Thread must not prevent its historical
    // journal entry from rendering.  It falls back to the legacy Thread row.
    return null;
  }
}

function workspaceResolutionForRecords(records, workspaceResolver) {
  for (const record of records ?? []) {
    const resolved = workspaceResolutionForRecord(record, workspaceResolver);
    if (resolved) return resolved;
  }
  return null;
}

function workspaceGroupKey(resolution, record) {
  if (resolution?.workspaceId) return `workspace\0${resolution.workspaceId}`;
  return `thread\0${String(record?.provider ?? "").toLowerCase()}\0${taskThreadId(record)}`;
}

function streamGroupKey(resolution, record) {
  if (resolution?.streamId) return `stream\0${resolution.streamId}`;
  return `thread\0${String(record?.provider ?? "").toLowerCase()}\0${taskThreadId(record)}`;
}

/* This is also used by usage history and search.  The default is Workspace
   aggregation whenever a WorkspaceCatalogStore resolver is available; stream
   detail remains explicit and does not require parsing rendered HTML. */
export function groupWorkLogUsageByWorkspace(turns = {}, {
  workspaceResolver = null,
  includeClaudeUsage = true,
} = {}) {
  const workspaces = new Map();
  for (const record of Object.values(turns ?? {})) {
    if (!record || typeof record !== "object") continue;
    if (!includeClaudeUsage && String(record.provider).toLowerCase() === "claude") continue;
    const resolution = workspaceResolutionForRecord(record, workspaceResolver);
    const workspaceKey = workspaceGroupKey(resolution, record);
    const streamKey = streamGroupKey(resolution, record);
    const workspace = workspaces.get(workspaceKey) ?? {
      id: resolution?.workspaceId ?? null,
      name: resolution?.workspaceName || String(record.taskTitle ?? "Без названия"),
      kind: resolution?.workspaceKind ?? "legacy",
      streams: new Map(),
      creditBreakdown: emptyCreditBreakdown(),
      latestCompletedAtMs: 0,
    };
    const stream = workspace.streams.get(streamKey) ?? {
      id: resolution?.streamId ?? null,
      name: resolution?.streamName ?? null,
      ordinal: resolution?.streamOrdinal ?? 1,
      displayName: resolution?.streamDisplayName ?? "",
      records: [],
      creditBreakdown: emptyCreditBreakdown(),
      latestCompletedAtMs: 0,
    };
    const breakdown = recordCreditBreakdown(record);
    const completedAtMs = Date.parse(record.completedAt ?? record.startedAt ?? "") || 0;
    stream.records.push(record);
    stream.creditBreakdown = addCreditBreakdown(stream.creditBreakdown, breakdown);
    stream.latestCompletedAtMs = Math.max(stream.latestCompletedAtMs, completedAtMs);
    workspace.streams.set(streamKey, stream);
    workspace.creditBreakdown = addCreditBreakdown(workspace.creditBreakdown, breakdown);
    workspace.latestCompletedAtMs = Math.max(workspace.latestCompletedAtMs, completedAtMs);
    workspaces.set(workspaceKey, workspace);
  }
  return [...workspaces.values()]
    .map((workspace) => ({
      ...workspace,
      credits: workspace.creditBreakdown.total,
      streams: [...workspace.streams.values()]
        .map((stream) => ({ ...stream, credits: stream.creditBreakdown.total }))
        .sort((left, right) => right.latestCompletedAtMs - left.latestCompletedAtMs
          || left.ordinal - right.ordinal),
    }))
    .sort((left, right) => right.latestCompletedAtMs - left.latestCompletedAtMs || left.name.localeCompare(right.name));
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
  workspaceResolver = null,
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
    if (isContextProbeRecord(record)) continue;
    if (roots.length && !roots.some((root) => sameProjectRoot(root, record.projectRoot))) continue;
    const fields = [
      ["Поток", record.taskTitle],
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
    const workspace = workspaceResolutionForRecord(record, workspaceResolver);
    const key = `${record.provider}\0${rootThreadId}\0${normalizeProjectRoot(record.projectRoot)}`;
    const completedAtMs = Date.parse(record.completedAt ?? record.startedAt ?? "") || 0;
    const group = groups.get(key) ?? {
      provider: String(record.provider ?? "codex"),
      threadId: rootThreadId,
      projectRoot: normalizeProjectRoot(record.projectRoot),
      taskTitle: String(record.taskTitle ?? "").trim(),
      workspaceId: workspace?.workspaceId ?? null,
      workspaceName: workspace?.workspaceName ?? null,
      streamId: workspace?.streamId ?? null,
      streamName: workspace?.streamName ?? null,
      streamDisplayName: workspace?.streamDisplayName ?? null,
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

function ensureCanonicalRows(section, date, turnIndex) {
  let updated = String(section);
  const groups = new Map();
  const claimedWorkLogIds = new Set(usageIds(updated));
  for (const record of automaticRecordsForDay(turnIndex, date, claimedWorkLogIds)) {
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
  const datedTurns = turnIndex.recordsByDate.get(date) ?? [];
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

function replaceProjectedCells(
  row,
  usageContent,
  records,
  workspace = null,
  taskContentOverride = null,
) {
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
  const task = taskContentOverride ?? (
    identity && latest?.taskTitle
      ? taskCell({ ...identity, taskTitle: latest.taskTitle })
      : taskCellContent(cells[0].text)
  );
  const attributes = identity
    ? ` data-work-log-provider="${escapeHtmlAttribute(identity.provider)}"`
      + ` data-work-log-thread-id="${escapeHtmlAttribute(identity.threadId)}"`
    : "";
  const hierarchyAttributes = workspace
    ? ` data-work-log-workspace-id="${escapeHtmlAttribute(workspace.workspaceId)}"`
      + (workspace.streamId
        ? ` data-work-log-stream-id="${escapeHtmlAttribute(workspace.streamId)}"`
        : "")
    : "";
  return `<div data-work-log-row${attributes}${hierarchyAttributes}>\n`
    + '<div data-work-log-task-cell>'
    + `<div data-work-log-task-content>${task}</div>`
    + `<div data-work-log-usage>${usageContent}</div></div>\n`
    + `<div data-work-log-turn-list>${turnList}</div>\n</div>`;
}

function formatWorkspaceRows(rows, dayCredits, dayElapsedSeconds, workspaceResolver) {
  if (typeof workspaceResolver !== "function") return rows.map((row) => row.html).join("\n");
  const groups = new Map();
  for (const row of rows) {
    const workspace = row.workspace ?? null;
    const key = workspace?.workspaceId ?? `legacy:${row.sourceIndex}`;
    const group = groups.get(key) ?? {
      workspace,
      rows: [],
      creditBreakdown: emptyCreditBreakdown(),
      elapsedSeconds: 0,
      latestCompletedAt: 0,
    };
    group.rows.push(row);
    group.creditBreakdown = addCreditBreakdown(group.creditBreakdown, row.creditBreakdown);
    group.elapsedSeconds += row.elapsedSeconds;
    group.latestCompletedAt = Math.max(group.latestCompletedAt, row.latestCompletedAt);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((left, right) => right.latestCompletedAt - left.latestCompletedAt)
    .map((group) => {
      if (!group.workspace) return group.rows.map((row) => row.html).join("\n");
      const streams = new Map();
      for (const row of group.rows) {
        const streamKey = row.workspace.streamId;
        const stream = streams.get(streamKey) ?? { workspace: row.workspace, rows: [] };
        stream.rows.push(row);
        streams.set(streamKey, stream);
      }
      const orderedStreams = [...streams.values()].sort((left, right) => (
        Math.max(...right.rows.map((row) => row.latestCompletedAt))
          - Math.max(...left.rows.map((row) => row.latestCompletedAt))
        || left.workspace.streamOrdinal - right.workspace.streamOrdinal
      ));
      const streamHtml = orderedStreams.map((stream) => {
        const label = stream.workspace.streamDisplayName
          || `Stream ${stream.workspace.streamOrdinal}`;
        const rowsByRecency = [...stream.rows].sort(
          (left, right) => right.latestCompletedAt - left.latestCompletedAt,
        );
        const representative = rowsByRecency[0];
        const identity = representative.identity;
        const taskContent = identity
          ? `<button type="button" data-open-task data-provider="${
            escapeHtmlAttribute(identity.provider)
          }" data-thread-id="${escapeHtmlAttribute(identity.threadId)}">${
            escapeHtmlText(label)
          }</button>`
          : escapeHtmlText(label);
        const groupedTaskLabel = taskDisplayTitle(stream.workspace, label);
        const groupedTaskContent = identity
          ? `<button type="button" data-open-task data-provider="${
            escapeHtmlAttribute(identity.provider)
          }" data-thread-id="${escapeHtmlAttribute(identity.threadId)}">${
            escapeHtmlText(groupedTaskLabel)
          }</button>`
          : escapeHtmlText(groupedTaskLabel);
        const records = [];
        const seenRecords = new Set();
        for (const row of rowsByRecency) {
          for (const record of row.recorded) {
            const key = `${record.provider}\0${record.threadId}\0${record.turnId}`;
            if (seenRecords.has(key)) continue;
            seenRecords.add(key);
            records.push({ ...record, workLogStreamDisplayName: label });
          }
        }
        records.sort(
          (left, right) => (Date.parse(right.completedAt) || 0) - (Date.parse(left.completedAt) || 0),
        );
        const breakdown = stream.rows.reduce(
          (total, row) => addCreditBreakdown(total, row.creditBreakdown),
          emptyCreditBreakdown(),
        );
        const markers = [...new Set(stream.rows.flatMap((row) => row.ids))]
          .map((id) => `<span data-usage-id="${id}" hidden></span>`)
          .join("\n");
        const streamElapsedSeconds = stream.rows.reduce(
          (total, row) => total + (Number(row.elapsedSeconds) || 0),
          0,
        );
        const streamUsage = breakdown.total > 0 || streamElapsedSeconds > 0
          ? formatStreamUsage(breakdown, dayCredits, streamElapsedSeconds, dayElapsedSeconds)
          : "";
        const rowHtml = replaceProjectedCells(
          representative.match.text,
          markers,
          records,
          stream.workspace,
          groupedTaskContent,
        );
        return `<details data-work-log-stream data-work-log-stream-id="${
          escapeHtmlAttribute(stream.workspace.streamId)
        }"${identity ? ` data-work-log-provider="${escapeHtmlAttribute(identity.provider)}"` : ""}`
          + ` open><summary data-work-log-stream-summary><span data-work-log-stream-title>${
            taskContent
          }</span>${streamUsage}</summary>`
          + `<div data-work-log-stream-turns>${rowHtml}</div></details>`;
      }).join("\n");
      const usage = group.creditBreakdown.total > 0
        ? formatWorkspaceUsage(group.creditBreakdown, dayCredits)
        : "";
      const workspaceUsage = usage
        ? `<span data-work-log-workspace-usage>${usage}</span>`
        : "";
      const collapsedWorkspaceUsage = group.creditBreakdown.total > 0 || group.elapsedSeconds > 0
        ? `<div data-work-log-collapsed-workspace-usage hidden>${
          formatCollapsedWorkspaceUsage(
            group.creditBreakdown,
            dayCredits,
            group.elapsedSeconds,
            dayElapsedSeconds,
          )
        }</div>`
        : "";
      return `<details data-work-log-workspace data-work-log-workspace-id="${
        escapeHtmlAttribute(group.workspace.workspaceId)
      }" data-work-log-workspace-kind="${escapeHtmlAttribute(group.workspace.workspaceKind)}"`
        + ` data-work-log-stream-count="${orderedStreams.length}" open>`
        + `<summary data-work-log-workspace-header><strong>${
          escapeHtmlText(group.workspace.workspaceName)
        }</strong>${workspaceUsage}</summary>`
        + `${collapsedWorkspaceUsage}`
        + `<div data-work-log-workspace-streams>${streamHtml}</div></details>`;
    }).join("\n");
}

function projectDaySection(
  section,
  date,
  turnIndex,
  recordsById,
  open,
  includeClaudeUsage,
  workspaceResolver,
) {
  const canonicalSection = ensureCanonicalRows(section, date, turnIndex);
  const claimedWorkLogIds = new Set(usageIds(canonicalSection));
  const rows = workLogTaskRows(canonicalSection)
    .map((match, sourceIndex) => {
      const ids = [...new Set(usageIds(match.text))];
      const identity = rowIdentity(match.text);
      const legacyRecords = ids.map((id) => recordsById.get(id)).filter(Boolean);
      const automaticRecords = identity
        ? automaticRecordsForIdentity(turnIndex, date, identity, claimedWorkLogIds)
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
        elapsedSeconds: recordsDurationSeconds(recorded),
        latestCompletedAt: recorded.reduce(
          (latest, record) => Math.max(latest, Date.parse(record.completedAt) || 0),
          0,
        ),
        identity,
        workspace: workspaceResolutionForRecords(recorded, workspaceResolver),
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
  const dayElapsedSeconds = trackedRows.reduce(
    (total, row) => total + row.elapsedSeconds,
    0,
  );

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
      return {
        ...row,
        html: replaceProjectedCells(
          row.match.text,
          `${visible}${markers}${collapseTurns}`,
          turnsContent,
          row.workspace,
        ),
      };
    });
  const dayDuration = dayElapsedSeconds > 0
    ? `<span data-work-log-day-duration data-work-log-duration-seconds="${
      dayElapsedSeconds
    }">${dayCredits > 0 ? "· " : ""}${formatSummaryDuration(dayElapsedSeconds)}</span>`
    : "";
  const summary = dayCredits > 0 || dayElapsedSeconds > 0
    ? `<summary data-work-log-day><strong>${date}</strong> <span data-day-usage-table>`
      + `<span data-day-usage><span data-usage-label>Итого</span> ${
        dayCredits > 0 ? highlightUsageUnits(formatCredits(dayCredits), dayCredits) : ""
      }${dayDuration ? ` ${dayDuration}` : ""
      }</span>`
      + `${dayCredits > 0 ? formatDayUsageBreakdown(dayBreakdown) : ""}</span></summary>`
    : `<summary data-work-log-day><strong>${date}</strong></summary>`;
  return [
    `<details data-work-log-day-section${open ? " open" : ""}>`,
    summary,
    layoutContainer(formatWorkspaceRows(
      renderedRows,
      dayCredits,
      dayElapsedSeconds,
      workspaceResolver,
    ), {
      workspaceHierarchy: typeof workspaceResolver === "function",
    }),
    "</details>",
    "",
    "",
  ].join("\n");
}

export function projectWorkLogUsage(workLogText, turns = {}, {
  includeClaudeUsage = true,
  workspaceResolver = null,
  accountCatalog = [],
  syncedUsageEvents = [],
  localDeviceId = "",
  localDeviceLabel = "",
  now = Date.now(),
} = {}) {
  let text = removeAccountUsagePanel(String(workLogText ?? ""));
  const normalizedTurns = normalizedLedger({ version: 8, turns }).ledger.turns;
  const accountPanel = formatAccountUsagePanel(buildWorkLogAccountUsageSummary(normalizedTurns, {
    accountCatalog,
    includeClaudeUsage,
    syncedUsageEvents,
    localDeviceId,
    localDeviceLabel,
    now,
  }));
  const records = ledgerByWorkLogId(normalizedTurns);
  const turnIndex = turnProjectionIndex(normalizedTurns);
  const existingDates = new Set(daySectionRanges(text).map((range) => range.date));
  const requiredDates = [...turnIndex.recordsByDate.keys()]
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
      turnIndex,
      records,
      dayStarts[index][1] === defaultOpenDate,
      includeClaudeUsage,
      workspaceResolver,
    );
    projected = `${projected.slice(0, start)}${replacement}${projected.slice(end)}`;
  }
  return insertAccountUsagePanel(projected, accountPanel);
}

export function projectWorkLogAccountUsage(workLogText, turns = {}, {
  accountCatalog = [],
  includeClaudeUsage = true,
  syncedUsageEvents = [],
  localDeviceId = "",
  localDeviceLabel = "",
  now = Date.now(),
} = {}) {
  const normalizedTurns = normalizedLedger({ version: 9, turns }).ledger.turns;
  return insertAccountUsagePanel(
    String(workLogText ?? ""),
    formatAccountUsagePanel(buildWorkLogAccountUsageSummary(normalizedTurns, {
      accountCatalog,
      includeClaudeUsage,
      syncedUsageEvents,
      localDeviceId,
      localDeviceLabel,
      now,
    })),
  );
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

export function incomingLedgerRecord({
  provider = "codex",
  threadId,
  turnId,
  projectRoot,
  workLogId = null,
  usage,
  usageReported,
  estimatedCredits,
  estimateKind,
  imageGenerationCount,
  contextProbe,
  model,
  serviceTier,
  taskTitle,
  taskThreadId,
  parentThreadId,
  parentTurnId,
  aggregateOnly,
  provisional,
  title,
  body,
  text,
  prompt,
  changedFiles,
  diff,
  skillsUsed,
  mcpCalls,
  toolMetricsKnown,
  account,
  accountKey,
  accountAttribution,
  startedAt,
  completedAt,
  observedAt,
  status,
}) {
  const accountFields = normalizedAccountFields({ account, accountKey, accountAttribution });
  const normalizedEstimatedCredits = normalizeEstimatedCredits(estimatedCredits);
  const normalizedEstimateKind = String(estimateKind ?? "").trim();
  return {
    workLogId,
    projectRoot: normalizeProjectRoot(projectRoot),
    usage: normalizeTokenUsage(usage),
    usageReported: usageReported === true,
    estimatedCredits: normalizedEstimatedCredits,
    estimateKind: normalizedEstimateKind,
    imageGenerationCount: normalizeImageGenerationCount(imageGenerationCount, {
      estimatedCredits: normalizedEstimatedCredits,
      estimateKind: normalizedEstimateKind,
    }),
    contextProbe: contextProbe === true,
    model: String(model ?? "").trim().toLowerCase(),
    serviceTier: serviceTier == null ? "" : normalizeServiceTier(serviceTier),
    pricingMetadataResolved: Boolean(String(model ?? "").trim() && serviceTier != null),
    provider: String(provider).trim().toLowerCase(),
    threadId: String(threadId).trim(),
    taskThreadId: String(taskThreadId ?? threadId).trim(),
    parentThreadId: String(parentThreadId ?? "").trim(),
    parentTurnId: String(parentTurnId ?? "").trim(),
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
    skillsUsed: normalizedSkillsUsed(skillsUsed),
    mcpCalls: normalizedMcpCalls(mcpCalls),
    toolMetricsKnown: toolMetricsKnown === true,
    ...accountFields,
    startedAt: String(startedAt ?? ""),
    completedAt: String(completedAt ?? new Date().toISOString()),
    observedAt: String(observedAt ?? new Date().toISOString()),
    status: String(status ?? "completed").trim() || "completed",
  };
}

function usageSyncContent(record) {
  const event = usageSyncEventFromLedgerRecord(record, { deviceId: "ledger-content" });
  if (!event) return "";
  const {
    deviceId: _deviceId,
    deviceLabel: _deviceLabel,
    observedAt: _observedAt,
    source: _source,
    ...content
  } = event;
  return JSON.stringify(content);
}

export function mergeLedgerRecord(existing, incoming) {
  if (!existing) return incoming;
  const previousSyncContent = usageSyncContent(existing);
  const previousObservedAt = String(existing.observedAt ?? "");
  if (incoming.workLogId) existing.workLogId = incoming.workLogId;
  if (incoming.usageReported || !existing.usageReported) {
    existing.usage = incoming.usage;
    existing.usageReported = incoming.usageReported;
  }
  if (incoming.estimatedCredits > 0) {
    existing.estimatedCredits = incoming.estimatedCredits;
    existing.estimateKind = incoming.estimateKind;
  }
  if (incoming.imageGenerationCount > 0) existing.imageGenerationCount = incoming.imageGenerationCount;
  if (incoming.contextProbe) existing.contextProbe = true;
  if (incoming.accountKey) {
    existing.accountKey = incoming.accountKey;
    if (incoming.accountLabel) existing.accountLabel = incoming.accountLabel;
    if (incoming.accountType) existing.accountType = incoming.accountType;
    if (incoming.accountPlan) existing.accountPlan = incoming.accountPlan;
    existing.accountAttribution = incoming.accountAttribution;
  }
  for (const field of [
    "projectRoot",
    "provider",
    "threadId",
    "taskThreadId",
    "parentThreadId",
    "parentTurnId",
    "turnId",
    "taskTitle",
    "title",
    "body",
    "prompt",
    "changedFiles",
    "diff",
    "skillsUsed",
    "mcpCalls",
    "startedAt",
    "completedAt",
    "model",
    "serviceTier",
  ]) {
    if (field === "changedFiles") {
      if (incoming.changedFiles.length) existing.changedFiles = incoming.changedFiles;
    } else if (field === "skillsUsed" || field === "mcpCalls") {
      if (incoming.toolMetricsKnown) existing[field] = incoming[field];
    } else if (field === "diff") {
      if (incoming.diff) existing.diff = incoming.diff;
    } else if (incoming[field]) {
      existing[field] = incoming[field];
    }
  }
  if (incoming.pricingMetadataResolved) existing.pricingMetadataResolved = true;
  if (incoming.aggregateOnly) existing.aggregateOnly = true;
  if (incoming.toolMetricsKnown) existing.toolMetricsKnown = true;
  existing.provisional = incoming.provisional === true;
  if (incoming.status && (incoming.status !== "unknown" || !existing.status || existing.status === "unknown")) {
    existing.status = incoming.status;
  }
  existing.observedAt = usageSyncContent(existing) === previousSyncContent
    ? previousObservedAt
    : String(incoming.observedAt ?? new Date().toISOString());
  return existing;
}

/* Сутки считаются календарными, а не «последними 24 часами»: иначе итог дня
   обрывался посреди ночи, а на графике день начинался в произвольный час. */
const USAGE_HISTORY_RANGES = Object.freeze({
  "6h": { spanMs: 6 * 60 * 60 * 1_000, bucketMs: 15 * 60 * 1_000 },
  "24h": { calendarDays: 1, bucketMs: 30 * 60 * 1_000, wholeDay: true },
  "7d": { calendarDays: 7, bucketMs: 24 * 60 * 60 * 1_000, dayBuckets: true },
  "15d": { calendarDays: 15, bucketMs: 24 * 60 * 60 * 1_000, dayBuckets: true },
  "30d": { calendarDays: 30, bucketMs: 24 * 60 * 60 * 1_000, dayBuckets: true },
});

function normalizedTurnTimeMode(value) {
  return ["start", "middle", "end"].includes(String(value)) ? String(value) : "end";
}

function turnUsageTimeMs(record, mode) {
  const completedMs = Date.parse(record?.completedAt ?? "");
  const startedMs = Date.parse(record?.startedAt ?? "");
  if (!Number.isFinite(completedMs)) return Number.NaN;
  if (mode === "start" && Number.isFinite(startedMs)) return Math.min(startedMs, completedMs);
  if (mode === "middle" && Number.isFinite(startedMs)) {
    return Math.round((Math.min(startedMs, completedMs) + completedMs) / 2);
  }
  return completedMs;
}

function usageHistoryBucket(value = {}) {
  return {
    credits: Math.max(0, Number(value?.credits) || 0),
    tokenCredits: Math.max(0, Number(value?.tokenCredits) || 0),
    timedCredits: Math.max(0, Number(value?.timedCredits) || 0),
    durationSeconds: Math.max(0, Number(value?.durationSeconds) || 0),
    localCredits: Math.max(0, Number(value?.localCredits) || 0),
    localTimedCredits: Math.max(0, Number(value?.localTimedCredits) || 0),
    localDurationSeconds: Math.max(0, Number(value?.localDurationSeconds) || 0),
    otherDeviceCredits: Math.max(0, Number(value?.otherDeviceCredits) || 0),
    otherDeviceTimedCredits: Math.max(0, Number(value?.otherDeviceTimedCredits) || 0),
    otherDeviceDurationSeconds: Math.max(0, Number(value?.otherDeviceDurationSeconds) || 0),
    devices: (Array.isArray(value?.devices) ? value.devices : []).map((device) => ({
      deviceId: String(device?.deviceId ?? "").trim(),
      label: String(device?.label ?? "").trim(),
      source: device?.source === "local" ? "local" : "sync",
      credits: Math.max(0, Number(device?.credits) || 0),
      timedCredits: Math.max(0, Number(device?.timedCredits) || 0),
      durationSeconds: Math.max(0, Number(device?.durationSeconds) || 0),
    })).filter((device) => device.deviceId),
  };
}

function usageHistoryPoint(at, value) {
  return { at: new Date(at).toISOString(), ...usageHistoryBucket(value) };
}

function localDayStart(value, dayOffset = 0) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  if (dayOffset) date.setDate(date.getDate() + dayOffset);
  return date.getTime();
}

function calendarDayPoints(fromMs, toMs, buckets) {
  if (!buckets.size) return [];
  const points = [];
  for (let cursor = fromMs; cursor <= toMs;) {
    points.push(usageHistoryPoint(cursor, buckets.get(cursor)));
    const next = new Date(cursor);
    next.setDate(next.getDate() + 1);
    cursor = next.getTime();
  }
  return points;
}

function allHistoryBucketMs(spanMs, maxPoints) {
  const day = 24 * 60 * 60 * 1_000;
  const candidates = [60 * 60 * 1_000, day, 7 * day, 30 * day, 90 * day, 365 * day];
  return candidates.find((bucket) => Math.ceil(spanMs / bucket) <= maxPoints)
    ?? Math.ceil(spanMs / maxPoints / day) * day;
}

function reconstructionBucketMs(spanMs, maxPoints) {
  const halfHour = 30 * 60 * 1_000;
  const minimum = 60 * 60 * 1_000;
  return Math.max(minimum, Math.ceil(spanMs / maxPoints / halfHour) * halfHour);
}

function localDayOrdinal(value) {
  const date = new Date(value);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / (24 * 60 * 60 * 1_000));
}

function localMsFromDayOrdinal(ordinal) {
  const utc = new Date(ordinal * 24 * 60 * 60 * 1_000);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate()).getTime();
}

export function buildWorkLogUsageHistory(turns = {}, {
  range = "24h",
  now = Date.now(),
  maxPoints = 600,
  includeClaudeUsage = true,
  provider = null,
  workspaceResolver = null,
  workspaceId = null,
  streamId = null,
  activeIntervals = null,
  turnTimeMode = "end",
  syncedUsageEvents = [],
  localDeviceId = "",
  localDeviceLabel = "",
  accountKey = "",
  accountActivity = [],
} = {}) {
  const normalizedRange = range === "all" || Object.hasOwn(USAGE_HISTORY_RANGES, range)
    ? range
    : "24h";
  const toMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const requestedWorkspaceId = String(workspaceId ?? "").trim();
  const requestedStreamId = String(streamId ?? "").trim();
  const requestedProvider = String(provider ?? "").trim().toLowerCase();
  const requestedAccountKey = String(accountKey ?? "").trim();
  const normalizedTimeMode = normalizedTurnTimeMode(turnTimeMode);
  const accountActivityIntervals = new Map((Array.isArray(accountActivity) ? accountActivity : [])
    .map((entry) => [
      String(entry?.accountKey ?? "").trim(),
      (Array.isArray(entry?.intervals) ? entry.intervals : []).map((interval) => ({
        from: Date.parse(interval?.from ?? ""),
        to: Date.parse(interval?.to ?? ""),
      })).filter((interval) => (
        Number.isFinite(interval.from) && Number.isFinite(interval.to) && interval.to > interval.from
      )),
    ])
    .filter(([key]) => key));
  const filterByActiveIntervals = Array.isArray(activeIntervals);
  const intervals = (filterByActiveIntervals ? activeIntervals : [])
    .map((interval) => ({
      from: Date.parse(interval?.from ?? ""),
      to: Date.parse(interval?.to ?? ""),
    }))
    .filter((interval) => Number.isFinite(interval.from) && Number.isFinite(interval.to) && interval.to > interval.from)
    .sort((left, right) => left.from - right.from);
  const insideActiveInterval = (pointMs) => !filterByActiveIntervals || intervals.some((interval) => (
    pointMs >= interval.from && pointMs < interval.to
  ));
  const localTurns = Object.values(turns ?? {});
  const localUsageEventIds = new Set(localTurns.map(usageSyncEventIdentity).filter(Boolean));
  const normalizedLocalDeviceId = String(localDeviceId ?? "").trim();
  const normalizedLocalDeviceLabel = String(localDeviceLabel ?? "").trim();
  const syncedTurns = (Array.isArray(syncedUsageEvents) ? syncedUsageEvents : [])
    .map(syncedUsageRecord)
    .filter((record) => {
      if (!record || record.syncDeviceId === normalizedLocalDeviceId) return false;
      if (localUsageEventIds.has(record.syncEventId)) return false;
      const recordAccountKey = String(record.accountKey ?? "").trim();
      if (!recordAccountKey) return false;
      if (requestedAccountKey && recordAccountKey !== requestedAccountKey) return false;
      const activity = accountActivityIntervals.get(recordAccountKey);
      if (!activity) return true;
      const pointMs = turnUsageTimeMs(record, normalizedTimeMode);
      return activity.some((interval) => pointMs >= interval.from && pointMs < interval.to);
    });
  const records = [
    ...localTurns.map((record) => ({ record, source: "local" })),
    ...syncedTurns.map((record) => ({ record, source: "other-device" })),
  ]
    .filter((entry) => (
      requestedProvider
        ? String(entry.record?.provider ?? "").trim().toLowerCase() === requestedProvider
        : includeClaudeUsage || String(entry.record?.provider ?? "").toLowerCase() !== "claude"
    ))
    .filter((entry) => (
      !requestedAccountKey
      || String(entry.record?.accountKey ?? "").trim() === requestedAccountKey
    ))
    .map(({ record, source }) => {
      const workspace = source === "local"
        ? workspaceResolutionForRecord(record, workspaceResolver)
        : null;
      if (source !== "local" && (requestedWorkspaceId || requestedStreamId)) return null;
      if (requestedWorkspaceId && workspace?.workspaceId !== requestedWorkspaceId) return null;
      if (requestedStreamId && workspace?.streamId !== requestedStreamId) return null;
      const pointMs = turnUsageTimeMs(record, normalizedTimeMode);
      const breakdown = recordCreditBreakdown(record);
      const priced = !(
        (record?.usageReported === false && breakdown.total <= 0)
        || (!breakdown.priced && breakdown.total <= 0)
      );
      return {
        pointMs,
        credits: Math.max(0, Number(breakdown.total) || 0),
        tokenCredits: Math.max(0, Number(breakdown.total - breakdown.estimate) || 0),
        priced,
        durationSeconds: durationSeconds(record?.startedAt, record?.completedAt),
        source,
        deviceId: source === "local"
          ? normalizedLocalDeviceId || "local"
          : String(record?.syncDeviceId ?? "").trim(),
        deviceLabel: source === "local"
          ? normalizedLocalDeviceLabel || "Это устройство"
          : `${String(record?.syncDeviceLabel ?? "").trim() || "Другое устройство"}`
            + ` · ${shortDeviceKey(record?.syncDeviceId)}`,
      };
    }).filter((record) => (
      record
      && Number.isFinite(record.pointMs)
      && record.pointMs <= toMs
      && insideActiveInterval(record.pointMs)
    ));
  const earliest = records.length
    ? Math.min(...records.map((record) => record.pointMs))
    : toMs;
  const configured = USAGE_HISTORY_RANGES[normalizedRange];
  const calendarDays = Number(configured?.calendarDays) || 0;
  const rawFromMs = calendarDays
    ? localDayStart(toMs, 1 - calendarDays)
    : configured
      ? toMs - configured.spanMs
      : earliest;
  const pointLimit = Math.min(Math.max(Number(maxPoints) || 600, 10), 2_000);
  const spanMs = Math.max(1, toMs - rawFromMs);
  const bucketMs = configured?.bucketMs ?? allHistoryBucketMs(spanMs, pointLimit);
  /* «Всё время» на длинной истории тоже считается по календарным суткам:
     сетка от эпохи давала день, начинающийся в 5 утра по местному времени. */
  const dayBuckets = Boolean(configured?.dayBuckets);
  const groupedCalendarDays = !configured && bucketMs >= 24 * 60 * 60 * 1_000;
  const fromMs = calendarDays
    ? rawFromMs
    : dayBuckets || groupedCalendarDays
      ? localDayStart(rawFromMs)
      : Math.floor(rawFromMs / bucketMs) * bucketMs;
  // ось суток доходит до полуночи, даже если день ещё не прожит
  const axisToMs = configured?.wholeDay ? localDayStart(toMs, 1) : toMs;
  const buckets = new Map();
  const reconstructionStepMs = requestedProvider && (dayBuckets || groupedCalendarDays)
    ? reconstructionBucketMs(spanMs, pointLimit)
    : 0;
  const reconstructionBuckets = new Map();
  let totalCredits = 0;
  let totalTokenCredits = 0;
  let totalTimedCredits = 0;
  let totalDurationSeconds = 0;
  let localCredits = 0;
  let localTimedCredits = 0;
  let localDurationSeconds = 0;
  let otherDeviceCredits = 0;
  let otherDeviceTimedCredits = 0;
  let otherDeviceDurationSeconds = 0;
  const deviceTotals = new Map();
  let untimedCreditCount = 0;
  let unpricedCount = 0;
  for (const record of records) {
    if (record.pointMs < rawFromMs) continue;
    const bucket = dayBuckets
      ? localDayStart(record.pointMs)
      : groupedCalendarDays
        ? (() => {
          const firstOrdinal = localDayOrdinal(fromMs);
          const lastOrdinal = localDayOrdinal(toMs);
          const groupDays = Math.max(1, Math.ceil((lastOrdinal - firstOrdinal + 1) / pointLimit));
          const ordinal = localDayOrdinal(record.pointMs);
          return localMsFromDayOrdinal(
            firstOrdinal + Math.floor((ordinal - firstOrdinal) / groupDays) * groupDays,
          );
        })()
        : Math.floor(record.pointMs / bucketMs) * bucketMs;
    const bucketValue = usageHistoryBucket(buckets.get(bucket));
    if (!record.priced) {
      unpricedCount += 1;
    } else {
      totalCredits += record.credits;
      totalTokenCredits += record.tokenCredits;
      bucketValue.credits += record.credits;
      bucketValue.tokenCredits += record.tokenCredits;
      if (reconstructionStepMs > 0 && record.credits > 0) {
        const reconstructionBucket = Math.floor(record.pointMs / reconstructionStepMs) * reconstructionStepMs;
        const reconstructionValue = reconstructionBuckets.get(reconstructionBucket)
          ?? { credits: 0, tokenCredits: 0 };
        reconstructionValue.credits += record.credits;
        reconstructionValue.tokenCredits += record.tokenCredits;
        reconstructionBuckets.set(reconstructionBucket, reconstructionValue);
      }
      const otherDevice = record.source === "other-device";
      const device = deviceTotals.get(record.deviceId) ?? {
        deviceId: record.deviceId,
        label: record.deviceLabel,
        source: otherDevice ? "sync" : "local",
        credits: 0,
        timedCredits: 0,
        durationSeconds: 0,
      };
      const bucketDevice = bucketValue.devices.find((entry) => entry.deviceId === record.deviceId) ?? {
        deviceId: record.deviceId,
        label: record.deviceLabel,
        source: otherDevice ? "sync" : "local",
        credits: 0,
        timedCredits: 0,
        durationSeconds: 0,
      };
      if (!bucketValue.devices.some((entry) => entry.deviceId === record.deviceId)) {
        bucketValue.devices.push(bucketDevice);
      }
      device.credits += record.credits;
      bucketDevice.credits += record.credits;
      if (otherDevice) {
        otherDeviceCredits += record.credits;
        bucketValue.otherDeviceCredits += record.credits;
      } else {
        localCredits += record.credits;
        bucketValue.localCredits += record.credits;
      }
      if (record.credits > 0) {
        if (Number.isFinite(record.durationSeconds) && record.durationSeconds > 0) {
          totalTimedCredits += record.credits;
          bucketValue.timedCredits += record.credits;
          totalDurationSeconds += record.durationSeconds;
          bucketValue.durationSeconds += record.durationSeconds;
          if (otherDevice) {
            otherDeviceTimedCredits += record.credits;
            otherDeviceDurationSeconds += record.durationSeconds;
            bucketValue.otherDeviceTimedCredits += record.credits;
            bucketValue.otherDeviceDurationSeconds += record.durationSeconds;
          } else {
            localTimedCredits += record.credits;
            localDurationSeconds += record.durationSeconds;
            bucketValue.localTimedCredits += record.credits;
            bucketValue.localDurationSeconds += record.durationSeconds;
          }
          device.timedCredits += record.credits;
          device.durationSeconds += record.durationSeconds;
          bucketDevice.timedCredits += record.credits;
          bucketDevice.durationSeconds += record.durationSeconds;
        } else {
          untimedCreditCount += 1;
        }
      }
      deviceTotals.set(record.deviceId, device);
    }
    buckets.set(bucket, bucketValue);
  }
  /* Внутри суток точки идут сплошной сеткой, включая пустые: линия расхода
     не должна перепрыгивать через часы, когда ничего не считалось. */
  const points = dayBuckets
    ? calendarDayPoints(fromMs, toMs, buckets)
    : groupedCalendarDays
      ? (() => {
        const firstOrdinal = localDayOrdinal(fromMs);
        const lastOrdinal = localDayOrdinal(toMs);
        const groupDays = Math.max(1, Math.ceil((lastOrdinal - firstOrdinal + 1) / pointLimit));
        const filled = [];
        for (let ordinal = firstOrdinal; ordinal <= lastOrdinal; ordinal += groupDays) {
          const at = localMsFromDayOrdinal(ordinal);
          filled.push(usageHistoryPoint(at, buckets.get(at)));
        }
        return filled;
      })()
    : (() => {
      const filled = [];
      for (let cursor = fromMs; cursor <= Math.min(toMs, axisToMs); cursor += bucketMs) {
        filled.push(usageHistoryPoint(cursor, buckets.get(cursor)));
      }
      return filled.slice(-pointLimit);
    })();
  return {
    range: normalizedRange,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    axisTo: new Date(axisToMs).toISOString(),
    bucketMs,
    bucket: dayBuckets || groupedCalendarDays ? "day" : "fixed",
    turnTimeMode: normalizedTimeMode,
    accountKey: requestedAccountKey,
    ...(requestedProvider ? { provider: requestedProvider } : {}),
    ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
    ...(requestedStreamId ? { streamId: requestedStreamId } : {}),
    totalCredits,
    totalTokenCredits,
    totalTimedCredits,
    totalDurationSeconds,
    localCredits,
    localTimedCredits,
    localDurationSeconds,
    otherDeviceCredits,
    otherDeviceTimedCredits,
    otherDeviceDurationSeconds,
    devices: [...deviceTotals.values()].sort((left, right) => (
      Number(right.source === "local") - Number(left.source === "local")
      || left.label.localeCompare(right.label, "ru")
      || left.deviceId.localeCompare(right.deviceId)
    )),
    untimedCreditCount,
    // Compatibility aliases used by the selectable hourly-rate basis.
    timedCredits: totalTimedCredits,
    taskDurationSeconds: totalDurationSeconds,
    unpricedCount,
    untimedCount: untimedCreditCount,
    ...(reconstructionStepMs > 0 ? {
      reconstruction: {
        bucketMs: reconstructionStepMs,
        points: [...reconstructionBuckets.entries()]
          .sort(([left], [right]) => left - right)
          .map(([at, value]) => ({ at: new Date(at).toISOString(), ...value })),
      },
    } : {}),
    points: points.map((point) => ({
      ...point,
      taskDurationSeconds: point.durationSeconds,
    })),
  };
}

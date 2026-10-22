import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm as removeFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";

import {
  applyWorkLogUsage,
  buildWorkLogAccountUsageSummary,
  buildWorkLogUsageHistory,
  formatWorkLogUsage,
  groupWorkLogUsageByWorkspace,
  incomingLedgerRecord,
  mergeLedgerRecord,
  normalizeWorkLogId,
  normalizePersistedWorkLog,
  projectWorkLogAccountUsage,
  projectWorkLogRateLimits,
  projectWorkLogUsage,
  restoreLegacyOutcomes,
  searchWorkLogRecords,
  WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
  workLogTurnKey,
} from "../../src/application/work-log-usage-projection.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { THIRD_ACCOUNT, FOURTH_ACCOUNT } from "../helpers/legacy-account-policy.mjs";
import { usageSyncThreadKey } from "../../src/domain/work-log-usage-sync.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";

const openStores = new Set();

test("service usage is counted once but stays out of the ordinary journal and search", () => {
  const completedAt = "2026-09-20T12:00:00.000Z";
  const base = { provider: "codex", threadId: "thread-service", taskThreadId: "thread-service",
    projectRoot: process.cwd(), completedAt, startedAt: completedAt, usageReported: true,
    accountAttribution: "unknown",
    usage: { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 } };
  const probe = incomingLedgerRecord({ ...base, turnId: "probe", model: "gpt-5.6-sol",
    serviceTier: "default", serviceUsageKind: "context-probe", title: "Probe secret" });
  const compact = incomingLedgerRecord({ ...base, turnId: "compact", model: "gpt-6-astra",
    serviceTier: "default", serviceUsageKind: "context-compaction", title: "Compact secret" });
  const turns = { [workLogTurnKey(probe)]: probe, [workLogTurnKey(compact)]: compact };
  const first = buildWorkLogUsageHistory(turns, { range: "all", now: "2026-09-21T00:00:00.000Z" });
  assert.equal(first.totalQuotaUnits, 2_100);
  assert.equal(first.totalCredits > 0, true);
  mergeLedgerRecord(turns[workLogTurnKey(probe)], incomingLedgerRecord({ ...probe }));
  mergeLedgerRecord(turns[workLogTurnKey(compact)], incomingLedgerRecord({ ...compact }));
  assert.deepEqual(buildWorkLogUsageHistory(structuredClone(turns),
    { range: "all", now: "2026-09-21T00:00:00.000Z" }).totalQuotaUnits, first.totalQuotaUnits);
  assert.equal(searchWorkLogRecords(turns, "secret").length, 0);
  const journal = projectWorkLogUsage("# Глобальный журнал работ\n", turns);
  assert.doesNotMatch(journal, /Probe secret|Compact secret/u);
  assert.doesNotMatch(journal, /data-work-log-turn-id="(?:probe|compact)"/u);
  assert.equal(probe.accountAttribution, "unknown");
});

test("history and journal include numerical QU for Terra, Fast, zero-price Spark and ImageGen estimates", () => {
  const base = { provider: "codex", threadId: "thread-qu-models", taskThreadId: "thread-qu-models",
    projectRoot: process.cwd(), startedAt: "2026-09-29T10:00:00.000Z",
    completedAt: "2026-09-29T10:01:00.000Z", usageReported: true,
    usage: { inputTokens: 1_000_000 } };
  const records = [
    incomingLedgerRecord({ ...base, turnId: "terra", model: "gpt-5.6-terra" }),
    incomingLedgerRecord({ ...base, turnId: "fast", model: "gpt-5.6-sol", serviceTier: "fast" }),
    incomingLedgerRecord({ ...base, turnId: "spark", model: "gpt-5.3-codex-spark" }),
    incomingLedgerRecord({ ...base, turnId: "image", model: "gpt-6-astra",
      usage: { inputTokens: 0 }, estimatedCredits: 90, imageGenerationCount: 1 }),
  ];
  const turns = Object.fromEntries(records.map((record) => [workLogTurnKey(record), record]));
  const history = buildWorkLogUsageHistory(turns, { range: "all", now: Date.parse("2026-09-30T00:00:00Z") });
  assert.equal(history.totalQuotaUnits, 400 + 2000 + 0 + 720);
  assert.equal(history.totalApiEstimateCredits, 50 + 250 + 90);
  assert.equal(history.uncalibratedCount, 3);
  const journal = projectWorkLogUsage("# Глобальный журнал работ\n", turns);
  assert.match(journal, /data-work-log-turn-quota-units="0"/u);
  assert.match(journal, /опора GPT-6 Sol ≈ 8 QU\/cr/u);
});

test("unreported tokens remain an incomplete QU estimate rather than a measured zero", () => {
  const record = incomingLedgerRecord({ provider: "codex", threadId: "missing", turnId: "missing",
    projectRoot: process.cwd(), model: "gpt-5.6-sol", usageReported: false,
    startedAt: "2026-09-20T11:00:00.000Z", completedAt: "2026-09-20T12:00:00.000Z",
    title: "Waiting for usage" });
  const turns = { [workLogTurnKey(record)]: record };
  const history = buildWorkLogUsageHistory(turns, { range: "all", now: "2026-09-21T00:00:00.000Z" });
  assert.equal(history.totalQuotaUnits, 0);
  assert.equal(history.uncalibratedCount, 1);
  const summary = buildWorkLogAccountUsageSummary(turns, { now: Date.parse("2026-09-20T13:00:00.000Z") });
  assert.equal(summary.find((range) => range.id === "today").uncalibratedCount, 1);
  assert.match(projectWorkLogUsage("# Глобальный журнал работ\n", turns),
    /data-work-log-turn-quota-units="0" data-work-log-turn-quota-incomplete="1"/u);
});

test("service repair clears sticky account identity in memory, JSON and SQLite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "service-account-repair-"));
  const identity = { provider: "codex", threadId: "thread-service-repair", turnId: "turn-service-repair",
    projectRoot: root, model: "gpt-5.6-sol", usageReported: true,
    usage: { inputTokens: 1000 }, startedAt: "2026-09-20T11:00:00.000Z",
    completedAt: "2026-09-20T12:00:00.000Z" };
  const known = incomingLedgerRecord({ ...identity, accountKey: "chatgpt:known",
    accountAttribution: "exact", title: "Old classification" });
  const service = incomingLedgerRecord({ ...identity, accountKey: "chatgpt:known",
    accountAttribution: "exact", serviceUsageKind: "context-probe" });
  assert.equal(service.accountKey, "");
  mergeLedgerRecord(known, service);
  assert.equal(known.accountKey, "");
  assert.equal(known.accountAttribution, "unknown");
  const persisted = normalizePersistedWorkLog({ version: 9, turns: {
    [workLogTurnKey(known)]: { ...known, accountKey: "chatgpt:stale", accountAttribution: "exact" },
  } }).ledger.turns[workLogTurnKey(known)];
  assert.equal(persisted.accountKey, "");
  assert.equal(persisted.accountAttribution, "unknown");
  const account = buildWorkLogAccountUsageSummary({ [workLogTurnKey(known)]: known },
    { now: Date.parse("2026-09-20T13:00:00.000Z") }).find((range) => range.id === "today");
  assert.equal(account.unknownTurns, 1);
  assert.equal(account.accounts.some((item) => item.accountKey === "chatgpt:known"), false);
  try {
    const store = new WorkLogUsageStore({ ledgerFile: path.join(root, "usage.json"),
      defaultProjectRoot: root });
    await store.recordAutomaticAndProject({ ...identity, accountKey: "chatgpt:known",
      accountAttribution: "exact", title: "Old classification",
      workLogFile: path.join(root, "WORK_LOG.md") });
    await store.recordAutomaticAndProject({ ...identity, serviceUsageKind: "context-probe",
      accountAttribution: "unknown", workLogFile: path.join(root, "WORK_LOG.md") });
    const saved = Object.values((await store.ledgerSnapshot()).turns)[0];
    assert.equal(saved.accountKey, "");
    assert.equal(saved.accountAttribution, "unknown");
    assert.equal(saved.serviceUsageKind, "context-probe");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("work-log repair accepts late ordinary identity without discarding measured usage", () => {
  const identity = { provider: "codex", threadId: "thread-probe", turnId: "turn-probe", projectRoot: process.cwd() };
  const record = incomingLedgerRecord({ ...identity, contextProbe: false, usage: { inputTokens: 100 }, usageReported: true });
  mergeLedgerRecord(record, incomingLedgerRecord({ ...identity, contextProbe: true }));
  assert.equal(record.contextProbe, undefined);
  assert.equal(record.usage.inputTokens, 100);
  mergeLedgerRecord(record, incomingLedgerRecord({ ...identity, contextProbe: false, clientUserMessageId: "ordinary-command" }));
  assert.equal(record.contextProbe, undefined);
  assert.equal(record.clientUserMessageId, "ordinary-command");
  mergeLedgerRecord(record, incomingLedgerRecord({ ...identity, contextProbe: true }));
  assert.equal(record.contextProbe, undefined);
  assert.equal(record.usage.inputTokens, 100);
});

test("work-log projection preserves an untrusted envelope-shaped literal", () => {
  const literal = [
    "<agent-hub-stream-message>",
    JSON.stringify({
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-release-manager",
      streamName: "Release Manager",
    }),
    "</agent-hub-stream-message>",
    "Keep this literal.",
  ].join("\n");
  const record = incomingLedgerRecord({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    projectRoot: process.cwd(),
    prompt: literal,
    status: "completed",
  });

  assert.equal(record.prompt, literal);
});

test("work-log normalization preserves exact focused-turn interstream identity", () => {
  const messageOrigin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    sourceThreadId: "thread-release-manager",
    requestId: "ledger-origin-1",
  };
  const record = incomingLedgerRecord({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    projectRoot: process.cwd(),
    prompt: "Начни работу",
    clientUserMessageId: "mcp:ledger-origin-1",
    messageOrigin,
    status: "completed",
  });

  assert.equal(record.clientUserMessageId, "mcp:ledger-origin-1");
  assert.deepEqual(record.messageOrigin, { kind: "interstream", ...messageOrigin });
});

test("work-log merge fails closed on a conflicting focused-turn identity", () => {
  const first = incomingLedgerRecord({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    projectRoot: process.cwd(),
    clientUserMessageId: "mcp:ledger-origin-1",
    messageOrigin: {
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-release-manager",
      streamName: "Release Manager",
      provider: "codex",
      sourceThreadId: "thread-release-manager",
      requestId: "ledger-origin-1",
    },
  });
  const second = incomingLedgerRecord({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    projectRoot: process.cwd(),
    clientUserMessageId: "mcp:ledger-origin-2",
    messageOrigin: {
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-other",
      streamName: "Other",
      provider: "codex",
      sourceThreadId: "thread-other",
      requestId: "ledger-origin-2",
    },
  });

  const merged = mergeLedgerRecord(first, second);
  assert.equal(merged.clientUserMessageId, "mcp:ledger-origin-1");
  assert.equal(merged.messageOrigin.requestId, "ledger-origin-1");
  assert.equal(merged.messageOrigin.streamId, "stream-release-manager");
});

test("work-log normalization omits oversized client identity and its origin", () => {
  const record = incomingLedgerRecord({
    workLogId: "oversized-client",
    projectRoot: process.cwd(),
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-oversized-client",
    clientUserMessageId: "x".repeat(201),
    messageOrigin: {
      workspaceId: "workspace-1",
      workspaceName: "Agent HUB",
      streamId: "stream-release-manager",
      streamName: "Release Manager",
      provider: "codex",
      sourceThreadId: "thread-release-manager",
      requestId: "oversized-client",
    },
  });
  assert.equal(record.clientUserMessageId, null);
  assert.equal(record.messageOrigin, undefined);
});

function WorkLogUsageStore(options) {
  const store = createWorkLogUsageStore({
    ...options,
    repositoryFactory: (repositoryOptions) => new WorkLogUsageRepository(repositoryOptions),
  });
  openStores.add(store);
  return store;
}
afterEach(async () => {
  await Promise.all([...openStores].map((store) => store.close()));
  openStores.clear();
});

async function rm(...args) {
  await Promise.all([...openStores].map((store) => store.close()));
  openStores.clear();
  return removeFile(...args);
}

async function projectedJournal(store) {
  const snapshot = await store.journalSnapshot();
  const initialHtml = String(snapshot?.html ?? "");
  const firstDay = initialHtml.indexOf("<details data-work-log-day-section");
  return [
    firstDay >= 0 ? initialHtml.slice(0, firstDay) : initialHtml,
    ...Object.values(snapshot?.days ?? {}).map(String),
  ].join("\n");
}

async function projectedJournalTurns(store) {
  return Object.values((await store.journalSnapshot())?.turns ?? {})
    .map(String)
    .join("\n");
}

async function persistedLedger(store) {
  return store.ledgerSnapshot();
}

const WORK_ID = "123e4567-e89b-42d3-a456-426614174000";
const SECOND_WORK_ID = "223e4567-e89b-42d3-a456-426614174000";
const GIGA_WORK_ID = "323e4567-e89b-42d3-a456-426614174001";
const USG001_DEVICE_ID = "24ab5532-0bbe-4e9a-b5a4-b5f93cfbec53";
const USG001_RUNTIME_HOME_ID = "1".repeat(64);
const USG001_OTHER_RUNTIME_HOME_ID = "2".repeat(64);
const USG001_INSTALLATION_ID = "11111111-2222-3333-8444-555555555555";

function syncedSchema2Turn({
  deviceId = USG001_DEVICE_ID,
  provider = "codex",
  runtimeHomeId = USG001_RUNTIME_HOME_ID,
  threadId = "thread-usg-001",
  turnId = "turn-usg-001",
  taskThreadId = threadId,
  startedAt = "2026-09-02T10:00:00.000Z",
  completedAt = "2026-09-02T10:05:00.000Z",
  observedAt = "2026-09-02T10:05:01.000Z",
  estimatedCredits = 5,
  deviceLabel = "stage2-device",
} = {}) {
  return {
    schemaVersion: 2,
    type: "turn",
    deviceId,
    deviceLabel,
    provider,
    runtimeHomeId,
    threadKey: usageSyncThreadKey({ provider, threadId }),
    taskKey: usageSyncThreadKey({ provider, threadId: taskThreadId }),
    eventId: `usage:${createHash("sha256").update(`${provider}:${threadId}:${turnId}`).digest("hex")}`,
    startedAt,
    completedAt,
    observedAt,
    estimatedCredits,
    usage: {},
    usageReported: true,
  };
}

function authObservation({
  deviceId = USG001_DEVICE_ID,
  provider = "codex",
  runtimeHomeId = USG001_RUNTIME_HOME_ID,
  accountKey = "chatgpt:stage2-owner",
  accountLabel = "stage2@example.test",
  accountType = "chatgpt",
  accountPlan = "pro",
  observedAt = "2026-09-02T09:55:00.000Z",
} = {}) {
  return {
    schemaVersion: 2,
    type: "auth_observation",
    deviceId,
    installationInstanceId: USG001_INSTALLATION_ID,
    provider,
    runtimeHomeId,
    accountKey,
    accountLabel,
    accountType,
    accountPlan,
    observedAt,
    evidenceSource: "account-read",
    authFingerprint: "fingerprint",
  };
}

test("work-log ids are normalized and validated", () => {
  assert.equal(normalizeWorkLogId(WORK_ID.toUpperCase()), WORK_ID);
  assert.throws(() => normalizeWorkLogId("not-a-guid"), /UUID/);
});

test("local usage history buckets priced ledger turns and reports unpriced ones", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const history = buildWorkLogUsageHistory({
    first: {
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 3.25,
      estimateKind: "model",
    },
    second: {
      completedAt: "2026-07-30T10:20:00.000Z",
      estimatedCredits: 1.75,
      estimateKind: "model",
    },
    unpriced: {
      completedAt: "2026-07-30T11:00:00.000Z",
      usageReported: false,
    },
    old: {
      completedAt: "2026-07-28T11:00:00.000Z",
      estimatedCredits: 99,
      estimateKind: "model",
    },
  }, { range: "6h", now });
  assert.equal(history.range, "6h");
  assert.equal(history.totalCredits, 5);
  assert.equal(history.totalTokenCredits, 0);
  assert.equal(history.unpricedCount, 1);
  assert.equal(history.points.length, 25);
  assert.equal(history.points.reduce((sum, point) => sum + point.credits, 0), 5);
  assert.equal(history.points.reduce((sum, point) => sum + point.tokenCredits, 0), 0);
});

test("journal and statistics use the verified Astra price", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const history = buildWorkLogUsageHistory({
    astra: {
      provider: "codex",
      model: "gpt-6-astra",
      completedAt: "2026-07-30T10:10:00.000Z",
      usageReported: true,
      usage: { inputTokens: 1_000_000 },
    },
  }, { range: "6h", now, provider: "codex" });

  assert.equal(history.totalCredits, 250);
  assert.equal(history.totalTokenCredits, 250);
  assert.equal(history.points.reduce((sum, point) => sum + point.credits, 0), 250);
});

test("journal and statistics keep mixed historical and current prices stable", () => {
  const turns = {
    historical: {
      provider: "codex",
      model: "gpt-5.6-sol",
      completedAt: "2026-09-07T23:59:59.999Z",
      usageReported: true,
      usage: { inputTokens: 1_000_000 },
    },
    current: {
      provider: "codex",
      model: "gpt-5.6-sol",
      completedAt: "2026-09-08T00:00:00.000Z",
      usageReported: true,
      usage: { inputTokens: 1_000_000 },
    },
    currentTerra: {
      provider: "codex",
      model: "gpt-5.6-terra",
      completedAt: "2026-09-08T00:00:00.001Z",
      usageReported: true,
      usage: { inputTokens: 1_000_000 },
    },
  };
  const options = {
    range: "6h",
    now: Date.parse("2026-09-08T03:00:00.000Z"),
    provider: "codex",
  };

  const first = buildWorkLogUsageHistory(turns, options);
  const rebuilt = buildWorkLogUsageHistory(structuredClone(turns), options);
  assert.equal(first.totalCredits, 275);
  assert.equal(first.totalTokenCredits, 275);
  assert.deepEqual(rebuilt, first);
});

test("usage history keeps the raw ImageGen estimate but excludes it from accounting", () => {
  const history = buildWorkLogUsageHistory({
    imageTurn: {
      provider: "codex",
      model: "gpt-5.6-sol",
      completedAt: "2026-07-30T10:10:00.000Z",
      usage: { inputTokens: 1_000_000 },
      estimatedCredits: 90,
      estimateKind: "imagegen-default",
    },
  }, { range: "6h", now: Date.parse("2026-07-30T12:00:00.000Z"), provider: "codex" });

  assert.ok(Math.abs(history.totalCredits - history.totalTokenCredits) < 1e-9);
  assert.ok(Math.abs(
    history.points.reduce((sum, point) => sum + point.credits - point.tokenCredits, 0),
  ) < 1e-9);
});

test("journal keeps estimated credits in the total without rendering a separate category", () => {
  const formatted = formatWorkLogUsage({
    total: 4_140.65,
    input: 0,
    cache: 0,
    output: 0,
    reasoning: 0,
    estimate: 4_140.65,
  });

  assert.match(formatted, /^Итого 4,1 kcr(?:<br>|$)/u);
  assert.doesNotMatch(formatted, /ImageGen|Оценка/u);
});

test("cache-write cost is a separate category in journal and QU presentation", () => {
  const record = incomingLedgerRecord({
    provider: "codex", threadId: "pricing-thread", turnId: "pricing-turn",
    taskThreadId: "pricing-thread", projectRoot: process.cwd(),
    startedAt: "2026-10-01T10:00:00.000Z",
    completedAt: "2026-10-01T10:01:00.000Z",
    model: "gpt-6.1-sol", usageReported: true,
    usage: {
      inputTokens: 300_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 50_000,
      outputTokens: 20_000, reasoningOutputTokens: 5_000, totalTokens: 320_000,
      longContextInputTokens: 300_000, longContextCachedInputTokens: 100_000,
      longContextCacheWriteInputTokens: 50_000, longContextOutputTokens: 20_000,
      longContextReasoningOutputTokens: 5_000,
    },
  });
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    [workLogTurnKey(record)]: record,
  });
  assert.match(projected, /data-task-usage-part>Запись кэша: <span [^>]*data-usage-credits="6\.25"[^>]*data-usage-qu="50"/u);
  assert.match(projected, /data-day-usage-part>Запись кэша:/u);
  assert.match(projected, /data-usage-credits="29\.25" data-usage-qu="234"/u);
  assert.match(projected, /длинный контекст >272K учтён/u);
});


test("local usage history derives credit intensity from exact turn duration", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const history = buildWorkLogUsageHistory({
    first: {
      startedAt: "2026-07-30T10:00:00.000Z",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 120,
    },
    second: {
      startedAt: "2026-07-30T10:20:00.000Z",
      completedAt: "2026-07-30T10:25:00.000Z",
      estimatedCredits: 40,
    },
    untimed: {
      completedAt: "2026-07-30T11:00:00.000Z",
      estimatedCredits: 1.1,
    },
  }, { range: "6h", now });

  assert.equal(history.totalCredits, 161.1);
  assert.equal(history.totalTimedCredits, 160);
  assert.equal(history.totalDurationSeconds, 900);
  assert.equal(history.untimedCreditCount, 1);
  assert.equal(history.points.reduce((sum, point) => sum + point.timedCredits, 0), 160);
  assert.equal(history.points.reduce((sum, point) => sum + point.durationSeconds, 0), 900);
});

test("local usage history can anchor a turn at its start, middle, or end", () => {
  const turns = {
    one: {
      startedAt: "2026-07-30T10:10:00.000Z",
      completedAt: "2026-07-30T11:10:00.000Z",
      estimatedCredits: 6,
      estimateKind: "model",
    },
  };
  const options = { range: "6h", now: Date.parse("2026-07-30T12:00:00.000Z") };
  const creditedAt = (mode) => buildWorkLogUsageHistory(turns, {
    ...options, turnTimeMode: mode,
  }).points.find((point) => point.credits > 0)?.at;
  assert.equal(creditedAt("start"), "2026-07-30T10:00:00.000Z");
  assert.equal(creditedAt("middle"), "2026-07-30T10:30:00.000Z");
  assert.equal(creditedAt("end"), "2026-07-30T11:00:00.000Z");
});

test("local usage history exposes compatibility fields for task-time rate", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const history = buildWorkLogUsageHistory({
    first: {
      startedAt: "2026-07-30T10:00:00.000Z",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 20,
      estimateKind: "model",
    },
    second: {
      startedAt: "2026-07-30T10:15:00.000Z",
      completedAt: "2026-07-30T10:35:00.000Z",
      estimatedCredits: 30,
      estimateKind: "model",
    },
    missingDuration: {
      completedAt: "2026-07-30T11:00:00.000Z",
      estimatedCredits: 7,
      estimateKind: "model",
    },
  }, { range: "6h", now });

  assert.equal(history.totalCredits, 57);
  assert.equal(history.timedCredits, 50);
  assert.equal(history.taskDurationSeconds, 30 * 60);
  assert.equal(history.untimedCount, 1);
  assert.equal(history.points.reduce((sum, point) => sum + point.timedCredits, 0), 50);
  assert.equal(history.points.reduce((sum, point) => sum + point.taskDurationSeconds, 0), 30 * 60);
});

test("local usage history can exclude Claude from global totals", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const turns = {
    codex: {
      provider: "codex",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 5,
      estimateKind: "model",
    },
    claude: {
      provider: "claude",
      completedAt: "2026-07-30T10:20:00.000Z",
      estimatedCredits: 7,
      estimateKind: "model",
    },
  };
  assert.equal(buildWorkLogUsageHistory(turns, { range: "6h", now }).totalCredits, 12);
  const filtered = buildWorkLogUsageHistory(turns, {
    range: "6h",
    now,
    includeClaudeUsage: false,
  });
  assert.equal(filtered.totalCredits, 5);
  assert.equal(filtered.points.reduce((sum, point) => sum + point.credits, 0), 5);
});

test("local usage history can select one provider for limit-price comparison", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const turns = {
    codex: {
      provider: "codex",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 5,
      estimateKind: "model",
    },
    claude: {
      provider: "claude",
      completedAt: "2026-07-30T10:20:00.000Z",
      estimatedCredits: 7,
      estimateKind: "model",
    },
  };
  const codex = buildWorkLogUsageHistory(turns, { range: "6h", now, provider: "CODEX" });
  assert.equal(codex.provider, "codex");
  assert.equal(codex.totalCredits, 5);
  assert.equal(codex.points.reduce((sum, point) => sum + point.credits, 0), 5);
});

test("local usage history matches turn completion to exact account activity intervals", () => {
  const turns = Object.fromEntries([
    ["before", "2026-07-30T10:09:59.999Z", 1],
    ["at-start", "2026-07-30T10:10:00.000Z", 2],
    ["inside", "2026-07-30T10:19:59.999Z", 3],
    ["at-end", "2026-07-30T10:20:00.000Z", 4],
    ["second", "2026-07-30T11:05:00.000Z", 5],
  ].map(([key, completedAt, estimatedCredits]) => [key, {
    provider: "codex",
    completedAt,
    estimatedCredits,
    estimateKind: "model",
  }]));
  const history = buildWorkLogUsageHistory(turns, {
    range: "6h",
    now: Date.parse("2026-07-30T12:00:00.000Z"),
    provider: "codex",
    activeIntervals: [
      { from: "2026-07-30T10:10:00.000Z", to: "2026-07-30T10:20:00.000Z" },
      { from: "2026-07-30T11:00:00.000Z", to: "2026-07-30T11:10:00.000Z" },
    ],
  });
  assert.equal(history.totalCredits, 10);
  assert.equal(history.points.reduce((sum, point) => sum + point.credits, 0), 10);
  assert.equal(buildWorkLogUsageHistory(turns, {
    range: "6h",
    now: Date.parse("2026-07-30T12:00:00.000Z"),
    activeIntervals: [],
  }).totalCredits, 0);
});

test("usage history combines all local accounts with sync only during matching local activity", () => {
  const accountA = "chatgpt:account-a";
  const accountB = "chatgpt:account-b";
  const accountC = "chatgpt:account-c";
  const remoteA = "remote-a";
  const remoteB = "remote-b";
  const remoteC = "remote-c";
  const history = buildWorkLogUsageHistory({
    localA: {
      provider: "codex",
      completedAt: "2026-09-02T10:10:00.000Z",
      estimatedCredits: 5,
      estimateKind: "model",
      accountKey: accountA,
    },
    localB: {
      provider: "codex",
      completedAt: "2026-09-02T10:30:00.000Z",
      estimatedCredits: 7,
      estimateKind: "model",
      accountKey: accountB,
    },
  }, {
    range: "6h",
    now: Date.parse("2026-09-02T12:00:00.000Z"),
    localDeviceId: "this-device",
    accountActivity: [{
      accountKey: accountA,
      intervals: [{ from: "2026-09-02T10:00:00.000Z", to: "2026-09-02T10:20:00.000Z" }],
    }, {
      accountKey: accountB,
      intervals: [{ from: "2026-09-02T10:20:00.000Z", to: "2026-09-02T11:00:00.000Z" }],
    }],
    syncedUsageEvents: [
      syncedSchema2Turn({
        deviceId: remoteA,
        runtimeHomeId: "3".repeat(64),
        threadId: "remote-a-active",
        turnId: "remote-a-active",
        completedAt: "2026-09-02T10:15:00.000Z",
        estimatedCredits: 11,
      }),
      authObservation({
        deviceId: remoteA,
        runtimeHomeId: "3".repeat(64),
        accountKey: accountA,
      }),
      syncedSchema2Turn({
        deviceId: remoteA,
        runtimeHomeId: "3".repeat(64),
        threadId: "remote-a-inactive",
        turnId: "remote-a-inactive",
        completedAt: "2026-09-02T11:15:00.000Z",
        estimatedCredits: 13,
      }),
      syncedSchema2Turn({
        deviceId: remoteB,
        runtimeHomeId: "4".repeat(64),
        threadId: "remote-b-active",
        turnId: "remote-b-active",
        completedAt: "2026-09-02T10:35:00.000Z",
        estimatedCredits: 17,
      }),
      authObservation({
        deviceId: remoteB,
        runtimeHomeId: "4".repeat(64),
        accountKey: accountB,
      }),
      syncedSchema2Turn({
        deviceId: remoteC,
        runtimeHomeId: "5".repeat(64),
        threadId: "remote-c-without-local-activity",
        turnId: "remote-c-without-local-activity",
        completedAt: "2026-09-02T10:40:00.000Z",
        estimatedCredits: 19,
      }),
      authObservation({
        deviceId: remoteC,
        runtimeHomeId: "5".repeat(64),
        accountKey: accountC,
      }),
    ],
  });

  assert.equal(history.accountKey, "");
  assert.equal(history.localCredits, 12);
  assert.equal(history.otherDeviceCredits, 28);
  assert.equal(history.totalCredits, 40);
  assert.deepEqual(history.devices.map((device) => [device.deviceId, device.credits]), [
    ["this-device", 12],
    [remoteA, 11],
    [remoteB, 17],
  ]);
});

test("usage history excludes synced account hints from selected-account totals", () => {
  const now = Date.parse("2026-07-30T12:00:00.000Z");
  const accountKey = "chatgpt:shared";
  const history = buildWorkLogUsageHistory({
    local: {
      provider: "codex",
      threadId: "local-thread",
      turnId: "local-turn",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 5,
      estimateKind: "model",
      accountKey,
    },
    wrongLocal: {
      provider: "codex",
      threadId: "wrong-local-thread",
      turnId: "wrong-local-turn",
      completedAt: "2026-07-30T10:15:00.000Z",
      estimatedCredits: 19,
      estimateKind: "model",
      accountKey: "chatgpt:other",
    },
  }, {
    range: "6h",
    now,
    localDeviceId: "this-device",
    accountKey,
    syncedUsageEvents: [{
      deviceId: "other-device",
      provider: "codex",
      threadId: "remote-thread",
      turnId: "remote-turn",
      completedAt: "2026-07-30T10:20:00.000Z",
      estimatedCredits: 7,
      accountKey,
      deviceLabel: "Ноутбук",
    }, {
      deviceId: "third-device",
      provider: "codex",
      threadId: "third-thread",
      turnId: "third-turn",
      completedAt: "2026-07-30T10:25:00.000Z",
      estimatedCredits: 3,
      accountKey,
      deviceLabel: "Телефон",
    }, {
      deviceId: "late-device",
      provider: "codex",
      threadId: "late-thread",
      turnId: "late-turn",
      completedAt: "2026-07-30T11:30:00.000Z",
      estimatedCredits: 17,
      accountKey,
      deviceLabel: "Ноутбук вне активности этого устройства",
    }, {
      deviceId: "other-device",
      provider: "codex",
      threadId: "wrong-account-thread",
      turnId: "wrong-account-turn",
      completedAt: "2026-07-30T10:30:00.000Z",
      estimatedCredits: 11,
      accountKey: "chatgpt:other",
    }, {
      deviceId: "this-device",
      provider: "codex",
      threadId: "same-device-thread",
      turnId: "same-device-turn",
      completedAt: "2026-07-30T10:40:00.000Z",
      estimatedCredits: 13,
      accountKey,
    }],
  });

  assert.equal(history.accountKey, accountKey);
  assert.equal(history.totalCredits, 5);
  assert.equal(history.localCredits, 5);
  assert.equal(history.otherDeviceCredits, 0);
  assert.deepEqual(history.devices.map((device) => ({
    deviceId: device.deviceId,
    label: device.label,
    credits: device.credits,
  })), [{
    deviceId: "this-device",
    label: "Это устройство",
    credits: 5,
  }]);
  assert.equal(history.points.reduce((sum, point) => sum + point.localCredits, 0), 5);
  assert.equal(history.points.reduce((sum, point) => sum + point.otherDeviceCredits, 0), 0);
});

test("usage history excludes accountless synced records from account history", () => {
  const targetDeviceId = "6148fb62-e3fb-411a-939e-ef4db9aaa475";
  const sameNicknameDeviceId = "89abcdef-second-device";
  const history = buildWorkLogUsageHistory({}, {
    range: "all",
    now: Date.parse("2026-09-01T08:00:00.000Z"),
    syncedUsageEvents: [{
      deviceId: targetDeviceId,
      deviceLabel: "",
      provider: "codex",
      threadId: "target-empty-thread",
      turnId: "target-empty-turn",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 1,
      accountKey: THIRD_ACCOUNT.key,
      accountLabel: THIRD_ACCOUNT.label,
      accountAttribution: "exact",
    }, {
      deviceId: targetDeviceId,
      deviceLabel: "DESKTOP-4QPHRPH",
      provider: "codex",
      threadId: "target-host-thread",
      turnId: "target-host-turn",
      completedAt: "2026-08-27T09:00:00.000Z",
      estimatedCredits: 2,
      accountKey: THIRD_ACCOUNT.key,
      accountLabel: THIRD_ACCOUNT.label,
      accountAttribution: "exact",
    }, {
      deviceId: targetDeviceId,
      deviceLabel: "IIITYRAELIII",
      provider: "codex",
      threadId: "target-nickname-thread",
      turnId: "target-nickname-turn",
      completedAt: "2026-09-01T07:00:00.000Z",
      estimatedCredits: 3,
      accountKey: "chatgpt:new",
      accountLabel: "new@example.test",
      accountAttribution: "exact",
    }, {
      deviceId: sameNicknameDeviceId,
      deviceLabel: "IIITYRAELIII",
      provider: "codex",
      threadId: "same-nickname-thread",
      turnId: "same-nickname-turn",
      completedAt: "2026-08-21T09:00:00.000Z",
      estimatedCredits: 4,
      accountKey: THIRD_ACCOUNT.key,
      accountLabel: THIRD_ACCOUNT.label,
      accountAttribution: "exact",
    }],
  });

  assert.equal(history.totalCredits, 0);
  assert.equal(history.devices.length, 0);
});

test("usage history filters schema 2 synced turns by account inferred from same-home auth observation", () => {
  const history = buildWorkLogUsageHistory({}, {
    range: "all",
    now: Date.parse("2026-09-02T12:00:00.000Z"),
    accountKey: "chatgpt:stage2-owner",
    syncedUsageEvents: [
      syncedSchema2Turn(),
      authObservation(),
      syncedSchema2Turn({
        threadId: "unmatched-thread",
        turnId: "unmatched-turn",
        runtimeHomeId: USG001_OTHER_RUNTIME_HOME_ID,
        estimatedCredits: 11,
      }),
    ],
  });

  assert.equal(history.totalCredits, 5);
  assert.equal(history.otherDeviceCredits, 5);
  assert.deepEqual(history.devices.map((device) => device.deviceId), [USG001_DEVICE_ID]);
});

test("provider history adds fine accounting buckets beside a daily chart", () => {
  const history = buildWorkLogUsageHistory({
    first: {
      provider: "codex",
      completedAt: "2026-07-30T10:10:00.000Z",
      estimatedCredits: 5,
      estimateKind: "model",
      accountKey: "chatgpt:shared",
    },
    second: {
      provider: "codex",
      completedAt: "2026-07-30T10:20:00.000Z",
      estimatedCredits: 7,
      estimateKind: "model",
      accountKey: "chatgpt:shared",
    },
  }, {
    range: "7d",
    now: Date.parse("2026-07-30T12:00:00.000Z"),
    provider: "codex",
    accountKey: "chatgpt:shared",
  });

  assert.equal(history.bucket, "day");
  assert.equal(history.reconstruction.bucketMs, 60 * 60 * 1_000);
  assert.deepEqual(history.reconstruction.points.map((point) => point.credits), [12]);
});

test("account usage summary separates exact, inferred and unknown ledger turns", () => {
  const knownKey = `chatgpt:${createHash("sha256").update("owner@example.com").digest("hex")}`;
  const summary = buildWorkLogAccountUsageSummary({
    exact: {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 3,
      accountKey: knownKey,
      accountAttribution: "exact",
    },
    inferred: {
      provider: "codex",
      threadId: "thread-2",
      turnId: "turn-2",
      completedAt: "2026-08-20T10:00:00.000Z",
      estimatedCredits: 5,
      accountKey: knownKey,
      accountAttribution: "inferred",
    },
    unknown: {
      provider: "claude",
      threadId: "thread-3",
      turnId: "turn-3",
      completedAt: "2026-08-20T11:00:00.000Z",
      estimatedCredits: 7,
    },
    noCost: {
      provider: "claude",
      threadId: "thread-5",
      turnId: "turn-5",
      completedAt: "2026-08-20T11:30:00.000Z",
      model: "<synthetic>",
      estimatedCredits: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
    },
    old: {
      provider: "codex",
      threadId: "thread-4",
      turnId: "turn-4",
      completedAt: "2026-08-18T11:00:00.000Z",
      estimatedCredits: 11,
      accountKey: "chatgpt:old",
      accountAttribution: "inferred",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    accountCatalog: [{ key: knownKey, label: "owner@example.com", type: "chatgpt", planType: "plus" }],
  });
  const today = summary.find((range) => range.id === "today");
  assert.equal(today.totalCredits, 15);
  assert.equal(today.totalTurns, 4);
  assert.equal(today.exactTurns, 1);
  assert.equal(today.inferredTurns, 1);
  assert.equal(today.unknownTurns, 1);
  assert.equal(today.noCostTurns, 1);
  assert.equal(today.accounts[0].label, "owner@example.com");
  assert.equal(today.accounts[0].credits, 8);
  assert.deepEqual(today.accounts[0].providers, { codex: 2 });
  assert.deepEqual(today.accounts[0].devices.map((device) => ({
    label: device.label,
    credits: device.credits,
    turns: device.turns,
    localTurns: device.localTurns,
    syncedTurns: device.syncedTurns,
  })), [{
    label: "Это устройство",
    credits: 8,
    turns: 2,
    localTurns: 2,
    syncedTurns: 0,
  }]);
  assert.equal(today.accounts[1].label, "Неизвестный аккаунт");
  assert.equal(today.accounts[2].label, "Без расхода");
  assert.equal(today.accounts[2].credits, 0);
  assert.equal(today.accounts[2].noCost, true);
  const all = summary.find((range) => range.id === "all");
  assert.equal(all.totalCredits, 26);
  assert.equal(all.accounts.length, 4);
});

test("account usage summary does not map Nikita sync device from a label fallback", () => {
  const summary = buildWorkLogAccountUsageSummary({}, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    ranges: ["today"],
    accountCatalog: [FOURTH_ACCOUNT],
    syncedUsageEvents: [{
      deviceId: "remote-nikita",
      deviceLabel: "Nikita",
      provider: "codex",
      threadId: "thread-nikita",
      turnId: "turn-nikita",
      completedAt: "2026-08-20T10:00:00.000Z",
      estimatedCredits: 7,
      accountAttribution: "inferred",
    }],
  });

  const today = summary.find((range) => range.id === "today");
  assert.equal(today.accounts.length, 1);
  assert.equal(today.accounts[0].accountKey, "");
  assert.equal(today.accounts[0].label, "Неизвестный аккаунт");
  assert.equal(today.accounts[0].unknownTurns, 1);
  assert.equal(today.accounts[0].devices[0].label, "Nikita");
});

test("account usage summary keeps sanitized legacy sync events unknown", () => {
  const summary = buildWorkLogAccountUsageSummary({}, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    ranges: ["today"],
    accountCatalog: [THIRD_ACCOUNT],
    syncedUsageEvents: [{
      deviceId: "remote-baseus",
      deviceLabel: "old-hostname",
      provider: "codex",
      threadId: "thread-legacy",
      turnId: "turn-legacy",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 7,
      accountKey: "chatgpt:untrusted",
      accountLabel: "untrusted@example.com",
      accountAttribution: "inferred",
    }, {
      deviceId: "remote-baseus",
      deviceLabel: "new-nickname",
      provider: "codex",
      threadId: "thread-exact",
      turnId: "turn-exact",
      completedAt: "2026-08-20T10:00:00.000Z",
      estimatedCredits: 3,
      accountKey: THIRD_ACCOUNT.key,
      accountLabel: THIRD_ACCOUNT.label,
      accountType: THIRD_ACCOUNT.type,
      accountPlan: THIRD_ACCOUNT.planType,
      accountAttribution: "exact",
    }, {
      deviceId: "remote-baseus",
      deviceLabel: "old-hostname",
      provider: "claude",
      threadId: "thread-claude-legacy",
      turnId: "turn-claude-legacy",
      completedAt: "2026-08-20T11:00:00.000Z",
      estimatedCredits: 5,
    }],
  });

  const today = summary.find((range) => range.id === "today");
  assert.equal(today.accounts.length, 1);
  assert.equal(today.accounts[0].label, "Неизвестный аккаунт");
  assert.equal(today.accounts[0].turns, 3);
  assert.equal(today.accounts[0].exactTurns, 0);
  assert.equal(today.accounts[0].inferredTurns, 0);
  assert.equal(today.accounts[0].deviceRecoveredTurns, 0);
  assert.equal(today.accounts[0].unknownTurns, 3);
  assert.equal(today.accounts[0].credits, 15);
  assert.deepEqual(today.accounts[0].providers, { claude: 1, codex: 2 });
});

test("account usage summary attributes schema 2 turns from same device runtime-home auth observations", () => {
  const summary = buildWorkLogAccountUsageSummary({}, {
    now: Date.parse("2026-09-02T12:00:00.000Z"),
    ranges: ["today"],
    syncedUsageEvents: [
      syncedSchema2Turn(),
      authObservation(),
    ],
  });

  const today = summary.find((range) => range.id === "today");
  assert.equal(today.totalCredits, 5);
  assert.equal(today.accounts.length, 1);
  assert.equal(today.unknownTurns, 0);
  assert.equal(today.inferredTurns, 1);
  assert.equal(today.accounts[0].accountKey, "chatgpt:stage2-owner");
  assert.equal(today.accounts[0].label, "stage2@example.test");
  assert.equal(today.accounts[0].type, "chatgpt");
  assert.equal(today.accounts[0].planType, "pro");
  assert.equal(today.accounts[0].inferredTurns, 1);
  assert.equal(today.accounts[0].unknownTurns, 0);
  assert.equal(today.accounts[0].devices[0].deviceId, USG001_DEVICE_ID);
});

test("account usage summary does not attribute schema 2 turns across devices or runtime homes", () => {
  const facts = [
    syncedSchema2Turn({
      turnId: "cross-device-turn",
      runtimeHomeId: "3".repeat(64),
      estimatedCredits: 3,
    }),
    authObservation({ deviceId: "other-device" }),
    syncedSchema2Turn({
      threadId: "cross-home-thread",
      turnId: "cross-home-turn",
      runtimeHomeId: USG001_OTHER_RUNTIME_HOME_ID,
      estimatedCredits: 7,
    }),
    authObservation({ runtimeHomeId: USG001_RUNTIME_HOME_ID }),
  ];
  const summary = buildWorkLogAccountUsageSummary({}, {
    now: Date.parse("2026-09-02T12:00:00.000Z"),
    ranges: ["today"],
    syncedUsageEvents: facts,
  });

  const today = summary.find((range) => range.id === "today");
  assert.equal(today.totalCredits, 10);
  assert.equal(today.accounts.length, 1);
  assert.equal(today.accounts[0].accountKey, "");
  assert.equal(today.accounts[0].label, "Неизвестный аккаунт");
  assert.equal(today.unknownTurns, 2);
  assert.equal(today.inferredTurns, 0);
});

test("account usage summary keeps multi-candidate auth observations unknown without discriminator evidence", () => {
  const summary = buildWorkLogAccountUsageSummary({}, {
    now: Date.parse("2026-09-02T12:00:00.000Z"),
    ranges: ["today"],
    syncedUsageEvents: [
      syncedSchema2Turn(),
      authObservation({ accountKey: "chatgpt:first", accountLabel: "first@example.test" }),
      authObservation({
        accountKey: "chatgpt:second",
        accountLabel: "second@example.test",
        observedAt: "2026-09-02T10:10:00.000Z",
      }),
    ],
  });

  const today = summary.find((range) => range.id === "today");
  assert.equal(today.accounts.length, 1);
  assert.equal(today.accounts[0].accountKey, "");
  assert.equal(today.accounts[0].unknownTurns, 1);
  assert.equal(today.inferredTurns, 0);
});

test("account usage summary includes fifteen calendar days", () => {
  const now = new Date(2026, 7, 20, 12, 0, 0, 0).getTime();
  const completedAt = (daysAgo) => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(9, 0, 0, 0);
    return date.toISOString();
  };
  const summary = buildWorkLogAccountUsageSummary({
    firstIncludedDay: {
      provider: "codex",
      completedAt: completedAt(14),
      estimatedCredits: 3,
      accountKey: "chatgpt:owner",
    },
    dayBeforeRange: {
      provider: "codex",
      completedAt: completedAt(15),
      estimatedCredits: 7,
      accountKey: "chatgpt:owner",
    },
    today: {
      provider: "codex",
      completedAt: completedAt(0),
      estimatedCredits: 5,
      accountKey: "chatgpt:owner",
    },
  }, { now });

  assert.deepEqual(summary.map((range) => range.id), ["today", "24h", "7d", "15d", "30d", "all"]);
  assert.equal(summary.find((range) => range.id === "15d")?.totalCredits, 8);
});

test("journal projection renders account usage panel with catalog labels", () => {
  const key = `chatgpt:${createHash("sha256").update("owner@example.com").digest("hex")}`;
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    exact: {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 3,
      accountKey: key,
      accountAttribution: "exact",
    },
    inferred: {
      provider: "codex",
      threadId: "thread-2",
      turnId: "turn-2",
      completedAt: "2026-08-20T10:00:00.000Z",
      estimatedCredits: 5,
      accountKey: key,
      accountAttribution: "inferred",
    },
    retired: {
      provider: "codex",
      threadId: "thread-3",
      turnId: "turn-3",
      completedAt: "2026-07-01T09:00:00.000Z",
      estimatedCredits: 4,
      accountKey: "chatgpt:retired",
      accountAttribution: "inferred",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    accountCatalog: [{ key, label: "owner@example.com", type: "chatgpt", planType: "plus" }],
  });
  assert.match(projected, /data-work-log-account-panel/u);
  assert.match(projected, /owner@example\.com/u);
  assert.match(projected, /data-work-log-account-panel-total>2 аккаунта</u);
  assert.match(projected, /data-work-log-account-idle>Ещё 1 аккаунт без расхода сегодня<\/span>/u);
  const tabs = /<div data-work-log-account-period-tabs>([\s\S]*?)<\/div>\s*<div data-work-log-account-period-body/u
    .exec(projected)?.[1];
  assert.ok(tabs, "period tabs are grouped before period bodies");
  assert.equal((tabs.match(/data-work-log-account-period-tab/gu) ?? []).length, 6);
  assert.equal((tabs.match(/data-work-log-account-period-body/gu) ?? []).length, 0);
  assert.match(tabs, /data-work-log-account-period-tab data-account-range="today" data-active aria-expanded="true"/u);
  assert.equal((projected.match(/data-work-log-account-period-body data-account-range=/gu) ?? []).length, 6);
  assert.match(
    projected,
    /data-work-log-account-period-body data-account-range="today" data-active/u,
  );
  assert.match(projected, /data-account-range="15d"[^>]*>[\s\S]*?15 дней/u);
  assert.match(projected, /data-work-log-account-period-amount>8<\/span>/u);
  assert.match(projected, /data-work-log-account-period-unit>cr<\/span>/u);
  assert.match(projected, /data-work-log-account-period-quality>точно 1 · восст\. 1</u);
  assert.match(projected, /data-work-log-account-column="account">Аккаунт · сегодня</u);
  assert.match(projected, /data-work-log-account-quality>точно 1 · восст\. 1</u);
  assert.match(projected, /data-work-log-account-device-count>1 устройство</u);
  assert.match(
    projected,
    /data-work-log-account-provider-rail[^>]*>[\s\S]*?data-work-log-account-provider-rail-segment data-provider-tone="codex"/u,
  );
  assert.match(
    projected,
    /data-work-log-account-provider-name>[\s\S]*?data-work-log-account-provider-label data-provider-tone="codex">Codex<\/span>/u,
  );
  assert.match(projected, /data-work-log-account-plan data-provider-tone="codex">Plus<\/span>/u);
  assert.match(
    projected,
    /data-work-log-account-bar-segment data-device-index="0" data-account-share="100\.00"/u,
  );
  assert.match(
    projected,
    /data-work-log-account-bar-device-fill data-device-index="0" data-account-offset="0\.00" data-account-share="100\.00"/u,
  );
  assert.match(projected, /data-work-log-account-device-label>Это устройство<\/span>/u);
  assert.match(projected, /data-work-log-account-provider-label data-provider-tone="codex">Codex<\/span>/u);
  assert.match(projected, /data-account-key="chatgpt:/u);
  assert.match(projected, /data-work-log-account-row [^>]*data-account-color="\d"/u);
  /* style-src приложения не разрешает 'unsafe-inline', поэтому геометрию полос
     расставляет клиент, а разметка панели остаётся без инлайновых стилей. */
  const panel = /<!-- work-log-account-panel:start -->[\s\S]*?<!-- work-log-account-panel:end -->/u
    .exec(projected)?.[0];
  assert.ok(panel, "проекция не отдала панель аккаунтов");
  assert.doesNotMatch(panel, /\sstyle="/u);
  assert.equal((projected.match(/work-log-account-panel:start/gu) ?? []).length, 1);
  const repeated = projectWorkLogUsage(projected, {}, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
  });
  assert.equal((repeated.match(/work-log-account-panel:start/gu) ?? []).length, 0);
});

test("account usage projection separates the Claude provider from OAuth and billing metadata", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    claude: {
      provider: "claude",
      threadId: "claude-thread",
      turnId: "claude-turn",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 3,
      accountKey: "anthropic:account-1",
      accountLabel: "claude@example.test",
      accountType: "oauth",
      accountPlan: "apple_subscription",
      accountAttribution: "exact",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
  });

  assert.match(projected, /data-work-log-account-provider-label data-provider-tone="claude">Claude<\/span>/u);
  assert.match(projected, /data-work-log-account-plan data-provider-tone="claude">Pro<\/span>/u);
  assert.doesNotMatch(projected, /data-work-log-account-provider-label[^>]*>oauth<\/span>/u);
  assert.doesNotMatch(projected, /data-work-log-account-plan>apple_subscription<\/span>/u);
});

test("account usage projection gives mixed providers one segmented rail and hides ambiguous plans", () => {
  const common = {
    accountKey: "anthropic:mixed-account",
    accountLabel: "mixed@example.test",
    accountType: "oauth",
    accountPlan: "max:subscription",
    accountAttribution: "exact",
  };
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    claude: {
      ...common,
      provider: "claude",
      threadId: "claude-thread",
      turnId: "claude-turn",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 3,
    },
    codex: {
      ...common,
      provider: "codex",
      threadId: "codex-thread",
      turnId: "codex-turn",
      completedAt: "2026-08-20T10:00:00.000Z",
      estimatedCredits: 2,
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
  });

  assert.match(
    projected,
    /data-work-log-account-provider-name><span data-work-log-account-provider-label data-provider-tone="claude">Claude<\/span><span data-work-log-account-provider-separator> · <\/span><span data-work-log-account-provider-label data-provider-tone="codex">Codex<\/span><\/span>/u,
  );
  assert.match(
    projected,
    /data-work-log-account-provider-rail[^>]*><span data-work-log-account-provider-rail-segment data-provider-tone="claude"><\/span><span data-work-log-account-provider-rail-segment data-provider-tone="codex"><\/span><\/span>/u,
  );
  assert.doesNotMatch(projected, /data-work-log-account-plan/u);
  assert.doesNotMatch(projected, /data-work-log-account-plan>max:subscription<\/span>/u);
});

test("account usage projection omits unknown plan badges instead of exposing technical values", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    codex: {
      provider: "codex",
      threadId: "codex-thread",
      turnId: "codex-turn",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 3,
      accountKey: "chatgpt:unknown-plan",
      accountLabel: "unknown-plan@example.test",
      accountPlan: "workspace_internal_v7",
      accountAttribution: "exact",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
  });

  assert.match(projected, /data-work-log-account-provider-label data-provider-tone="codex">Codex<\/span>/u);
  assert.doesNotMatch(projected, /data-work-log-account-plan/u);
  assert.doesNotMatch(projected, /workspace_internal_v7/u);
});

test("account usage panel keeps synced legacy device history unknown", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {}, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    localDeviceId: "local-device",
    accountCatalog: [THIRD_ACCOUNT],
    syncedUsageEvents: [{
      deviceId: "remote-baseus",
      deviceLabel: "baseus-laptop",
      provider: "codex",
      threadId: "thread-exact",
      turnId: "turn-exact",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 3,
      accountKey: THIRD_ACCOUNT.key,
      accountLabel: THIRD_ACCOUNT.label,
      accountType: THIRD_ACCOUNT.type,
      accountPlan: THIRD_ACCOUNT.planType,
      accountAttribution: "exact",
    }, {
      deviceId: "remote-baseus",
      deviceLabel: "baseus-laptop",
      provider: "codex",
      threadId: "thread-legacy-codex",
      turnId: "turn-legacy-codex",
      completedAt: "2026-08-20T09:30:00.000Z",
      estimatedCredits: 2,
    }, {
      deviceId: "remote-baseus",
      deviceLabel: "baseus-laptop",
      provider: "claude",
      threadId: "thread-legacy-claude",
      turnId: "turn-legacy-claude",
      completedAt: "2026-08-20T10:00:00.000Z",
      estimatedCredits: 7,
    }],
  });

  assert.doesNotMatch(projected, /data-account-key="chatgpt:/u);
  assert.doesNotMatch(projected, /data-account-recovery-device="1"/u);
  assert.match(projected, /__unknown_account__/u);
  assert.match(projected, /data-work-log-account-quality>без ключа 3 · sync 3<\/span>/u);
  assert.match(projected, /data-work-log-account-device-quality>без ключа 3 · sync 3<\/span>/u);
});

test("account usage summary uses the best known device nickname across all periods", () => {
  const deviceId = "6148fb62-e3fb-411a-939e-ef4db9aaa475";
  const syncedUsageEvents = [{
    deviceId,
    deviceLabel: "",
    provider: "codex",
    threadId: "thread-empty",
    turnId: "turn-empty",
    completedAt: "2026-08-20T09:00:00.000Z",
    estimatedCredits: 1,
    accountKey: THIRD_ACCOUNT.key,
    accountLabel: THIRD_ACCOUNT.label,
    accountAttribution: "exact",
  }, {
    deviceId,
    deviceLabel: "DESKTOP-4QPHRPH",
    provider: "codex",
    threadId: "thread-host",
    turnId: "turn-host",
    completedAt: "2026-08-27T09:00:00.000Z",
    estimatedCredits: 1,
    accountKey: THIRD_ACCOUNT.key,
    accountLabel: THIRD_ACCOUNT.label,
    accountAttribution: "exact",
  }, {
    deviceId,
    deviceLabel: "IIITYRAELIII",
    provider: "codex",
    threadId: "thread-nickname",
    turnId: "turn-nickname",
    completedAt: "2026-09-01T07:00:00.000Z",
    estimatedCredits: 1,
    accountKey: THIRD_ACCOUNT.key,
    accountLabel: THIRD_ACCOUNT.label,
    accountAttribution: "exact",
  }];
  const summary = buildWorkLogAccountUsageSummary({}, {
    now: Date.parse("2026-09-01T08:00:00.000Z"),
    ranges: ["today", "24h", "all"],
    accountCatalog: [THIRD_ACCOUNT],
    syncedUsageEvents,
  });

  for (const range of summary) {
    assert.equal(range.accounts[0].devices[0].label, "IIITYRAELIII", range.id);
  }

  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {}, {
    now: Date.parse("2026-09-01T08:00:00.000Z"),
    accountCatalog: [THIRD_ACCOUNT],
    syncedUsageEvents,
  });
  assert.match(projected, /data-work-log-account-device-label>IIITYRAELIII<\/span>/u);
  assert.doesNotMatch(projected, /data-work-log-account-device-label>DESKTOP-4QPHRPH<\/span>/u);
  assert.doesNotMatch(projected, /data-work-log-account-device-label>device 6148fb62<\/span>/u);
});

test("account usage panel keeps zero-token unattributed turns in the period footnote", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    known: {
      provider: "codex",
      threadId: "thread-known",
      turnId: "turn-known",
      completedAt: "2026-08-20T08:00:00.000Z",
      estimatedCredits: 1,
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
    },
    billableUnknown: {
      provider: "claude",
      threadId: "thread-unknown",
      turnId: "turn-unknown",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 7,
    },
    noCost: {
      provider: "claude",
      threadId: "thread-no-cost",
      turnId: "turn-no-cost",
      completedAt: "2026-08-20T10:00:00.000Z",
      model: "<synthetic>",
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
  });

  assert.match(projected, /data-work-log-account-label>Неизвестный аккаунт<\/span>/u);
  assert.match(projected, /data-work-log-account-row [^>]*data-account-key="__unknown_account__"/u);
  assert.match(projected, /data-work-log-account-quality>без ключа 1<\/span>/u);
  assert.match(projected, /data-work-log-account-device-count>1 устройство<\/span>/u);
  assert.match(projected, /data-work-log-account-device-row [^>]*data-account-key="__unknown_account__"/u);
  assert.doesNotMatch(projected, /data-work-log-account-label>Без расхода<\/span>/u);
  assert.doesNotMatch(projected, /data-account-key="__no_cost__"/u);
  assert.match(projected, /data-work-log-account-idle>1 ход без стоимости<\/span>/u);
  assert.match(projected, /data-work-log-account-panel-total>2 аккаунта</u);
});

test("account usage panel includes synced remote devices without duplicating local export", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    local: {
      provider: "codex",
      threadId: "thread-local",
      turnId: "turn-local",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 3,
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    localDeviceId: "device-local",
    accountCatalog: [{ key: "chatgpt:owner", label: "owner@example.com" }],
    syncedUsageEvents: [
      {
        deviceId: "device-local",
        provider: "codex",
        threadId: "thread-local",
        turnId: "turn-local",
        completedAt: "2026-08-20T09:00:00.000Z",
        estimatedCredits: 3,
        accountKey: "chatgpt:owner",
        accountAttribution: "exact",
      },
      {
        deviceId: "laptop",
        deviceLabel: "teammate",
        provider: "codex",
        threadId: "thread-remote-same-account",
        turnId: "turn-remote-same-account",
        completedAt: "2026-08-20T09:30:00.000Z",
        estimatedCredits: 2,
        accountKey: "chatgpt:owner",
        accountAttribution: "exact",
      },
      {
        deviceId: "phone",
        deviceLabel: "SidorukSV-phone",
        provider: "claude",
        threadId: "thread-remote",
        turnId: "turn-remote",
        completedAt: "2026-08-20T10:00:00.000Z",
        estimatedCredits: 7,
        accountKey: "anthropic:owner",
        accountLabel: "owner@anthropic.example",
        accountType: "oauth",
        accountPlan: "pro",
        accountAttribution: "exact",
      },
    ],
  });

  assert.match(projected, /owner@example\.com/u);
  assert.doesNotMatch(projected, /owner@anthropic\.example/u);
  assert.match(projected, /data-account-key="__unknown_account__"/u);
  assert.match(projected, /data-account-sync-turns="2"/u);
  assert.match(projected, /data-work-log-account-device-count>2 устройства<\/span>/u);
  assert.match(
    projected,
    /data-work-log-account-devices-toggle aria-pressed="false">Показать устройства<\/button>/u,
  );
  assert.match(
    projected,
    /data-work-log-account-device-row [^>]*data-device-id="device-local" [^>]*data-device-source="local"/u,
  );
  assert.match(projected, /data-work-log-account-device-label>Это устройство<\/span>/u);
  assert.match(projected, /data-work-log-account-device-id>device-local<\/span>/u);
  assert.match(projected, /data-work-log-account-device-origin>local<\/span>/u);
  assert.match(projected, /data-work-log-account-device-quality>точно 1<\/span>/u);
  assert.match(
    projected,
    /data-work-log-account-device-row [^>]*data-device-id="laptop" [^>]*data-device-source="sync"/u,
  );
  assert.match(projected, /data-work-log-account-device-label>teammate<\/span>/u);
  assert.match(projected, /data-work-log-account-device-id>laptop<\/span>/u);
  assert.match(projected, /data-work-log-account-device-origin>sync<\/span>/u);
  assert.match(projected, /data-work-log-account-device-quality>без ключа 1 · sync 1<\/span>/u);
  assert.match(projected, /data-work-log-account-device-label>SidorukSV-phone<\/span>/u);
  assert.match(projected, /data-work-log-account-quality>без ключа 2 · sync 2<\/span>/u);
  assert.match(
    projected,
    /data-work-log-account-total>итого <span data-kilo-usage data-usage-credits="12"[^>]*>12 cr<\/span> · 3 ход\./u,
  );
  assert.match(projected, /data-work-log-account-idle><\/span>/u);
});

test("account-only projection preserves lazy journal fragments", () => {
  const lazyDay = '<details data-lazy-day="20.08.2026"><summary>День сохранён</summary></details>';
  const projected = projectWorkLogAccountUsage(`# Глобальный журнал работ\n${lazyDay}\n`, {
    local: {
      provider: "codex",
      threadId: "thread-local",
      turnId: "turn-local",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 3,
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    localDeviceId: "device-local",
    accountCatalog: [{ key: "chatgpt:owner", label: "owner@example.com" }],
  });

  assert.match(projected, /data-work-log-account-panel/u);
  assert.ok(projected.includes(lazyDay));
  assert.doesNotMatch(projected, /data-work-log-day-section/u);
});

test("usage sync updates only the lazy account index after a remote delta", async () => {
  const lazyDay = '<details data-lazy-day="20.08.2026"><summary>День сохранён</summary></details>';
  let replacement = null;
  const repository = {
    databaseFile: "memory.sqlite",
    ledger: {
      version: 9,
      turns: {
        local: {
          provider: "codex",
          threadId: "thread-local",
          turnId: "turn-local",
          projectRoot: "D:/project",
          completedAt: "2026-08-20T09:00:00.000Z",
          estimatedCredits: 3,
          accountKey: "chatgpt:owner",
          accountAttribution: "exact",
        },
      },
    },
    enqueue: async (operation) => operation(),
    save: async () => {},
    payload: async () => ({
      html: `# Глобальный журнал работ\n${lazyDay}\n`,
      version: "old",
      revision: 7,
    }),
    replaceProjection: async () => {},
    replaceIndexProjection: async (html, options) => {
      replacement = { html, options };
      return { projected: true, revision: 8 };
    },
    accountCatalog: async () => [{ key: "chatgpt:owner", label: "owner@example.com" }],
    close: async () => {},
  };
  const store = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    defaultProjectRoot: "D:/project",
    usageSyncDeviceId: "device-local",
    usageSyncStore: {
      importSnapshot: async () => ({ imported: true, added: 1, updated: 0 }),
      events: async () => [],
      projectAccountUsage: async ({ html, projectRoots, ...options }) => {
        assert.deepEqual(projectRoots, ["D:/project"]);
        return {
          projected: true,
          html: projectWorkLogAccountUsage(html, repository.ledger.turns, {
            ...options,
            syncedUsageEvents: [],
          }),
          version: "sha256:account-panel",
          durationMs: 12,
          eventCount: 0,
          workerThreadId: 3,
        };
      },
    },
  });

  const result = await store.importUsageSyncSnapshotAndProject({
    snapshot: { events: [] },
    projectRoot: "D:/project",
  });

  assert.equal(result.projected, true);
  assert.ok(replacement.html.includes(lazyDay));
  assert.match(replacement.html, /data-work-log-account-panel/u);
  assert.equal(replacement.options.expectedRevision, 7);
  assert.equal(result.workerThreadId, 3);
});

test("usage sync skips projection for an unchanged remote snapshot", async () => {
  let payloadReads = 0;
  const repository = {
    databaseFile: "memory.sqlite",
    ledger: { version: 9, turns: {} },
    enqueue: async (operation) => operation(),
    save: async () => {},
    payload: async () => { payloadReads += 1; return { html: "" }; },
    replaceProjection: async () => {},
    close: async () => {},
  };
  const store = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    usageSyncStore: {
      importSnapshot: async () => ({ imported: true, added: 0, updated: 0 }),
      events: async () => { throw new Error("events must not be read"); },
    },
  });

  const result = await store.importUsageSyncSnapshotAndProject({ snapshot: { events: [] } });

  assert.equal(result.projected, false);
  assert.equal(result.reason, "unchanged");
  assert.equal(payloadReads, 0);
});

test("stale shipped projection version rebuilds Provider Column C with zero remote delta", async () => {
  const staleHtml = [
    "# Глобальный журнал работ",
    "<!-- work-log-account-panel:start -->",
    '<section data-work-log-account-panel><span>chatgpt pro</span></section>',
    "<!-- work-log-account-panel:end -->",
  ].join("\n");
  let current = { html: staleHtml, version: "sha256:stale", revision: 7 };
  let projectionVersion = "legacy-v0";
  let workerCalls = 0;
  const ledger = {
    version: 9,
    turns: {
      local: {
        provider: "codex",
        threadId: "thread-local",
        turnId: "turn-local",
        projectRoot: "D:/project",
        completedAt: "2026-08-20T09:00:00.000Z",
        estimatedCredits: 3,
        accountKey: "chatgpt:owner",
        accountPlan: "pro",
        accountAttribution: "exact",
      },
    },
  };
  const repository = {
    databaseFile: "memory.sqlite",
    ledger,
    enqueue: async (operation) => operation(),
    save: async () => {},
    payload: async () => current,
    replaceProjection: async () => {},
    accountUsageProjectionVersion: async () => projectionVersion,
    replaceIndexProjection: async (html, options) => {
      current = { html, version: options.version, revision: current.revision + 1 };
      projectionVersion = options.accountUsageProjectionVersion;
      return { projected: true, version: options.version, revision: current.revision };
    },
    accountCatalog: async () => [{ key: "chatgpt:owner", label: "owner@example.test" }],
    close: async () => {},
  };
  const store = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    defaultProjectRoot: "D:/project",
    usageSyncDeviceId: "device-local",
    usageSyncStore: {
      events: async () => [],
      projectAccountUsage: async ({ html, force, ...options }) => {
        workerCalls += 1;
        assert.equal(force, true);
        const updated = projectWorkLogAccountUsage(html, ledger.turns, {
          ...options,
          syncedUsageEvents: [],
        });
        return {
          projected: true,
          reason: "updated",
          html: updated,
          version: "sha256:provider-column-c",
          durationMs: 4,
          eventCount: 0,
          workerThreadId: 3,
        };
      },
    },
  });

  const rebuilt = await store.ensureAccountUsageProjectionCurrent();

  assert.equal(rebuilt.projected, true);
  assert.equal(rebuilt.projectionRequired, true);
  assert.equal(rebuilt.projectionVersion, WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION);
  assert.equal(rebuilt.triggerReason, "shipped-version-check");
  assert.equal(projectionVersion, WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION);
  assert.equal(workerCalls, 1);
  assert.match(current.html, /data-work-log-account-provider-rail/u);
  assert.match(current.html, /data-work-log-account-provider-label data-provider-tone="codex">Codex</u);
  assert.match(current.html, /data-work-log-account-plan data-provider-tone="codex">Pro</u);
  assert.doesNotMatch(current.html, /chatgpt pro/u);

  assert.deepEqual(await store.ensureAccountUsageProjectionCurrent(), {
    projected: false,
    projectionRequired: false,
    projectionVersion: WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
    reason: "current",
  });
  assert.equal(workerCalls, 1);
});

test("failed required projection keeps the shipped version stale for retry", async () => {
  let projectionVersion = "legacy-v0";
  let replacementCalls = 0;
  const repository = {
    databaseFile: "memory.sqlite",
    ledger: { version: 9, turns: {} },
    enqueue: async (operation) => operation(),
    save: async () => {},
    payload: async () => ({
      html: "# Глобальный журнал работ\n",
      version: "sha256:stale",
      revision: 3,
    }),
    replaceProjection: async () => {},
    accountUsageProjectionVersion: async () => projectionVersion,
    replaceIndexProjection: async (_html, options) => {
      replacementCalls += 1;
      projectionVersion = options.accountUsageProjectionVersion;
      return { projected: true, revision: 4 };
    },
    accountCatalog: async () => [],
    close: async () => {},
  };
  const store = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    defaultProjectRoot: "D:/project",
    usageSyncDeviceId: "device-local",
    usageSyncStore: {
      events: async () => [],
      projectAccountUsage: async () => ({
        projected: true,
        reason: "forced",
        html: "# Глобальный журнал работ\n<!-- projected -->\n",
        version: "sha256:current",
      }),
    },
    beforeProjectionWrite: async () => {
      throw new Error("projection storage unavailable");
    },
  });

  await assert.rejects(
    store.ensureAccountUsageProjectionCurrent({ required: true, reason: "sync-repair" }),
    /projection storage unavailable/u,
  );
  assert.equal(replacementCalls, 0);
  assert.equal(projectionVersion, "legacy-v0");
});

test("required projection serializes with a concurrent local record and preserves both facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-projection-version-race-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  try {
    await journal.upsertRecords([{
      provider: "codex",
      threadId: "seed-thread",
      taskThreadId: "seed-thread",
      turnId: "seed-turn",
      projectRoot: root,
      startedAt: "2026-09-07T08:59:00.000Z",
      completedAt: "2026-09-07T09:00:00.000Z",
      observedAt: "2026-09-07T09:00:00.000Z",
      estimatedCredits: 3,
      accountKey: "chatgpt:owner",
      accountPlan: "pro",
      accountAttribution: "exact",
      usageReported: true,
      usage: { inputTokens: 100 },
    }]);
    await journal.replaceProjection({
      html: "# Глобальный журнал работ\nСтарая materialized проекция\n",
      days: {},
      turns: {},
    }, { accountUsageProjectionVersion: "legacy-v0" });
  } finally {
    journal.close();
  }

  let releaseProjection;
  let projectionEntered;
  const projectionGate = new Promise((resolve) => { releaseProjection = resolve; });
  const projectionStarted = new Promise((resolve) => { projectionEntered = resolve; });
  let pauseFirstProjection = true;
  const store = WorkLogUsageStore({
    ledgerFile: path.join(root, "work-log-usage.json"),
    databaseFile,
    defaultProjectRoot: root,
    usageSyncDeviceId: "device-local",
    usageSyncStore: new WorkLogUsageSyncWorkerStore({
      databaseFile,
      deviceId: "device-local",
    }),
    beforeProjectionWrite: async () => {
      if (!pauseFirstProjection) return;
      pauseFirstProjection = false;
      projectionEntered();
      await projectionGate;
    },
  });
  try {
    const ensure = store.ensureAccountUsageProjectionCurrent();
    await projectionStarted;
    const record = store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "concurrent-thread",
      turnId: "concurrent-turn",
      projectRoot: root,
      startedAt: "2026-09-07T09:29:00.000Z",
      completedAt: "2026-09-07T09:30:00.000Z",
      observedAt: "2026-09-07T09:30:00.000Z",
      usageReported: true,
      usage: { inputTokens: 50 },
      estimatedCredits: 1,
      text: "Одновременный локальный ход",
      resolveAccount: false,
    });
    releaseProjection();

    const [projectionResult, recordResult] = await Promise.all([ensure, record]);
    assert.equal(projectionResult.projected, true);
    assert.equal(recordResult.recorded, true);
    const snapshot = await store.journalSnapshot();
    assert.match(snapshot.html, /data-work-log-account-provider-rail/u);
    assert.match(JSON.stringify(snapshot), /concurrent-turn/u);
    assert.equal(Object.keys((await store.ledgerSnapshot()).turns).length, 2);
    const verification = new JournalDatabase(databaseFile);
    try {
      assert.equal(
        await verification.accountUsageProjectionVersion(),
        WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
      );
    } finally {
      verification.close();
    }
  } finally {
    releaseProjection();
    await rm(root, { recursive: true, force: true });
  }
});


test("account usage panel keeps unlabeled sync device ids separate", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    local: {
      provider: "codex",
      threadId: "thread-local",
      turnId: "turn-local",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 1,
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    localDeviceId: "device-local",
    accountCatalog: [{ key: "chatgpt:owner", label: "owner@example.com" }],
    syncedUsageEvents: [
      {
        deviceId: "remote-old-id",
        provider: "codex",
        threadId: "thread-remote-a",
        turnId: "turn-remote-a",
        completedAt: "2026-08-20T09:30:00.000Z",
        estimatedCredits: 2,
        accountKey: "chatgpt:owner",
        accountAttribution: "exact",
      },
      {
        deviceId: "remote-new-id",
        provider: "codex",
        threadId: "thread-remote-b",
        turnId: "turn-remote-b",
        completedAt: "2026-08-20T10:00:00.000Z",
        estimatedCredits: 3,
        accountKey: "chatgpt:owner",
        accountAttribution: "exact",
      },
    ],
  });

  assert.match(projected, /data-work-log-account-device-count>2 устройства<\/span>/u);
  assert.match(
    projected,
    /data-work-log-account-device-row [^>]*data-device-id="remote-old-id" [^>]*data-device-source="sync"/u,
  );
  assert.match(
    projected,
    /data-work-log-account-device-row [^>]*data-device-id="remote-new-id" [^>]*data-device-source="sync"/u,
  );
  assert.match(projected, /data-work-log-account-device-label>remote-old-id<\/span>/u);
  assert.match(projected, /data-work-log-account-device-label>remote-new-id<\/span>/u);
  assert.match(projected, /data-work-log-account-device-quality>без ключа 1 · sync 1<\/span>/u);
  assert.doesNotMatch(projected, /data-device-id="__sync_unlabeled__"/u);
});

test("account usage panel keeps raw Windows hostname labels visible and separate", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    local: {
      provider: "codex",
      threadId: "thread-local",
      turnId: "turn-local",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 1,
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    localDeviceId: "device-local",
    accountCatalog: [{ key: "chatgpt:owner", label: "owner@example.com" }],
    syncedUsageEvents: [
      {
        deviceId: "remote-host-a",
        deviceLabel: "DESKTOP-F5OM6BN",
        provider: "codex",
        threadId: "thread-remote-a",
        turnId: "turn-remote-a",
        completedAt: "2026-08-20T09:30:00.000Z",
        estimatedCredits: 2,
        accountKey: "chatgpt:owner",
        accountAttribution: "exact",
      },
      {
        deviceId: "remote-host-b",
        deviceLabel: "DESKTOP-4QPHRPH",
        provider: "codex",
        threadId: "thread-remote-b",
        turnId: "turn-remote-b",
        completedAt: "2026-08-20T10:00:00.000Z",
        estimatedCredits: 3,
        accountKey: "chatgpt:owner",
        accountAttribution: "exact",
      },
    ],
  });

  assert.match(projected, /data-work-log-account-device-count>2 устройства<\/span>/u);
  assert.match(
    projected,
    /data-work-log-account-device-row [^>]*data-device-id="remote-host-a" [^>]*data-device-source="sync"/u,
  );
  assert.match(
    projected,
    /data-work-log-account-device-row [^>]*data-device-id="remote-host-b" [^>]*data-device-source="sync"/u,
  );
  assert.match(projected, /data-work-log-account-device-label>DESKTOP-F5OM6BN<\/span>/u);
  assert.match(projected, /data-work-log-account-device-label>DESKTOP-4QPHRPH<\/span>/u);
  assert.match(projected, /data-work-log-account-device-quality>без ключа 1 · sync 1<\/span>/u);
  assert.doesNotMatch(projected, /data-work-log-account-device-label>Другое устройство<\/span>/u);
});

test("account usage panel keeps remote devices separate when labels match", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    local: {
      provider: "codex",
      threadId: "thread-local",
      turnId: "turn-local",
      completedAt: "2026-08-20T09:00:00.000Z",
      estimatedCredits: 1,
      accountKey: "chatgpt:owner",
      accountAttribution: "exact",
    },
  }, {
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    localDeviceId: "device-local",
    localDeviceLabel: "SidorukSV",
    accountCatalog: [{ key: "chatgpt:owner", label: "owner@example.com" }],
    syncedUsageEvents: [
      {
        deviceId: "remote-a",
        deviceLabel: "shared-label",
        provider: "codex",
        threadId: "thread-remote-a",
        turnId: "turn-remote-a",
        completedAt: "2026-08-20T09:30:00.000Z",
        estimatedCredits: 2,
        accountKey: "chatgpt:owner",
        accountAttribution: "exact",
      },
      {
        deviceId: "remote-b",
        deviceLabel: "shared-label",
        provider: "codex",
        threadId: "thread-remote-b",
        turnId: "turn-remote-b",
        completedAt: "2026-08-20T10:00:00.000Z",
        estimatedCredits: 3,
        accountKey: "chatgpt:owner",
        accountAttribution: "exact",
      },
    ],
  });

  assert.match(projected, /data-work-log-account-device-count>2 устройства<\/span>/u);
  assert.match(projected, /data-device-id="device-local"[^>]*data-device-source="local"/u);
  assert.match(projected, /data-work-log-account-device-label>SidorukSV<\/span>/u);
  assert.match(projected, /data-device-id="remote-a"[^>]*data-device-source="sync"/u);
  assert.match(projected, /data-device-id="remote-b"[^>]*data-device-source="sync"/u);
  assert.equal((projected.match(/data-work-log-account-device-label>shared-label<\/span>/gu) ?? []).length, 12);
});

test("usage history does not trust synced account fields absent from local ledger", () => {
  const history = buildWorkLogUsageHistory({}, {
    range: "24h",
    now: Date.parse("2026-08-20T12:00:00.000Z"),
    localDeviceId: "device-local",
    localDeviceLabel: "SidorukSV",
    syncedUsageEvents: [
      {
        deviceId: "remote-baseus",
        deviceLabel: "yarik",
        provider: "codex",
        threadId: "thread-remote",
        turnId: "turn-remote",
        completedAt: "2026-08-20T10:00:00.000Z",
        estimatedCredits: 7,
        accountKey: "chatgpt:baseus",
        accountLabel: "account-3@example.invalid",
        accountAttribution: "exact",
      },
    ],
  });

  assert.equal(history.totalCredits, 0);
  assert.equal(history.devices.length, 0);
});

test("workspace usage aggregates sequential Threads and retains Stream detail", () => {
  const resolver = ({ provider, threadId }) => ({
    workspaceId: "workspace-hub",
    workspaceName: "Agent HUB",
    workspaceKind: "user",
    streamId: threadId === "thread-themes" ? "stream-themes" : "stream-main",
    streamOrdinal: threadId === "thread-themes" ? 2 : 1,
    streamName: threadId === "thread-themes" ? "Themes" : null,
    streamDisplayName: threadId === "thread-themes" ? "Themes" : "Stream 1",
    provider,
  });
  const turns = {
    first: { provider: "codex", threadId: "thread-main", turnId: "turn-1",
      completedAt: "2026-07-30T10:00:00.000Z", estimatedCredits: 2 },
    continuation: { provider: "codex", threadId: "thread-main-next", turnId: "turn-2",
      completedAt: "2026-07-30T10:10:00.000Z", estimatedCredits: 3 },
    themes: { provider: "codex", threadId: "thread-themes", turnId: "turn-3",
      completedAt: "2026-07-30T10:20:00.000Z", estimatedCredits: 5 },
  };
  const grouped = groupWorkLogUsageByWorkspace(turns, { workspaceResolver: resolver });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].name, "Agent HUB");
  assert.equal(grouped[0].credits, 10);
  assert.equal(grouped[0].streams.length, 2);
  assert.equal(grouped[0].streams.find((stream) => stream.id === "stream-main").credits, 5);
  const history = buildWorkLogUsageHistory(turns, {
    range: "6h",
    now: Date.parse("2026-07-30T12:00:00.000Z"),
    workspaceResolver: resolver,
    streamId: "stream-main",
  });
  assert.equal(history.totalCredits, 5);
});

test("journal projection groups all Stream turns under one expandable Workspace", () => {
  const resolver = ({ threadId }) => ({
    workspaceId: "workspace-hub",
    workspaceName: "Agent HUB",
    workspaceKind: "user",
    streamId: threadId === "thread-themes" ? "stream-themes" : "stream-main",
    streamOrdinal: threadId === "thread-themes" ? 2 : 1,
    streamName: threadId === "thread-themes" ? "Themes" : null,
    streamDisplayName: threadId === "thread-themes" ? "Themes" : "Stream 1",
  });
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    main: { provider: "codex", threadId: "thread-main", turnId: "turn-main",
      taskTitle: "Agent HUB 1", title: "Первый", estimatedCredits: 2,
      completedAt: "2026-07-30T10:00:00.000Z" },
    continuation: { provider: "codex", threadId: "thread-main-next", turnId: "turn-main-next",
      taskTitle: "Agent HUB 2", title: "Продолжение", estimatedCredits: 4,
      completedAt: "2026-07-30T10:10:00.000Z" },
    themes: { provider: "codex", threadId: "thread-themes", turnId: "turn-themes",
      taskTitle: "Themes", title: "Второй", estimatedCredits: 3,
      completedAt: "2026-07-30T10:20:00.000Z" },
  }, { workspaceResolver: resolver });
  assert.equal((projected.match(/<details data-work-log-workspace data-work-log-workspace-id="workspace-hub"/gu) ?? []).length, 1);
  assert.equal((projected.match(/<details data-work-log-stream /gu) ?? []).length, 2);
  assert.equal((projected.match(/<div data-work-log-row/gu) ?? []).length, 2);
  assert.ok(projected.includes("data-work-log-workspace-streams"));
  assert.ok(projected.includes("data-work-log-stream-turns"));
  assert.ok(projected.includes("Agent HUB"));
  assert.equal((projected.match(/data-work-log-turn-stream>Stream 1<\/span>/gu) ?? []).length, 2);
  assert.equal((projected.match(/data-work-log-turn-stream>Themes<\/span>/gu) ?? []).length, 1);
  assert.ok(!projected.includes("Codex - Agent HUB 1"));
  assert.ok(!projected.includes("Codex - Agent HUB 2"));
  assert.match(
    projected,
    /data-open-task data-provider="codex" data-thread-id="thread-main-next">Stream 1/u,
  );
  assert.match(
    projected,
    /data-work-log-task-content><button[^>]*data-thread-id="thread-main-next">Agent HUB - Stream 1<\/button>/u,
  );
  assert.match(
    projected,
    /data-work-log-task-content><button[^>]*data-thread-id="thread-themes">Agent HUB - Themes<\/button>/u,
  );
  assert.match(
    projected,
    /data-work-log-turn-provider="codex" data-work-log-turn-thread-id="thread-main"[\s\S]*?data-open-turn/u,
  );
  assert.ok(projected.includes('data-usage-credits="9"'));
});

test("journal projection indexes automatic turns by exact day provider and root thread", () => {
  const originalDateToString = Date.prototype.toString;
  let parsedDateStringifications = 0;
  Date.prototype.toString = function trackedDateToString() {
    parsedDateStringifications += 1;
    return originalDateToString.call(this);
  };
  try {
    const turns = {
      codexFirst: {
        provider: "codex", threadId: "codex-child", taskThreadId: "shared-root",
        turnId: "codex-first", taskTitle: "Codex", title: "Codex first",
        completedAt: "2026-07-30T10:00:00.000Z",
      },
      claudeSameThread: {
        provider: "claude", threadId: "shared-root", turnId: "claude-first",
        taskTitle: "Claude", title: "Claude first", completedAt: "2026-07-30T11:00:00.000Z",
      },
      codexNextDay: {
        provider: "codex", threadId: "codex-child-2", taskThreadId: "shared-root",
        turnId: "codex-next", taskTitle: "Codex", title: "Codex next",
        completedAt: "2026-07-31T10:00:00.000Z",
      },
      probe: {
        provider: "codex", threadId: "probe-thread", turnId: "probe-turn",
        taskTitle: "Probe", title: "AGENT_HUB_CONTEXT_PROBE_OK_V1",
        contextProbe: true, completedAt: "2026-07-30T12:00:00.000Z",
      },
    };
    const projected = projectWorkLogUsage("# Глобальный журнал работ\n", turns);

    assert.equal(parsedDateStringifications, 0);
    assert.equal((projected.match(/data-work-log-turn-id="codex-first"/gu) ?? []).length, 1);
    assert.equal((projected.match(/data-work-log-turn-id="claude-first"/gu) ?? []).length, 1);
    assert.equal((projected.match(/data-work-log-turn-id="codex-next"/gu) ?? []).length, 1);
    assert.match(projected, /AGENT_HUB_CONTEXT_PROBE_OK_V1/u);
    assert.equal(projectWorkLogUsage(projected, turns), projected);
  } finally {
    Date.prototype.toString = originalDateToString;
  }
});

test("journal assigns an unknown root Thread to Other instead of a fake group", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-workspace-fallback-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const assigned = [];
    let resolution = null;
    const workspaceCatalogStore = {
      resolveThread: ({ threadId }) => (
        resolution?.threadId === threadId ? resolution : null
      ),
      assignUnknownThread: (reference, options) => {
        assigned.push({ reference, options });
        resolution = {
          ...reference,
          workspaceId: "workspace-experiments",
          workspaceName: "Other",
          workspaceKind: "system",
          streamId: "stream-experiments",
          streamOrdinal: 1,
          streamName: null,
          streamDisplayName: "Stream 1",
        };
        return resolution;
      },
    };
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
      workspaceCatalogStore,
    });
    await store.recordAutomaticBatchAndProject({
      records: [{
        provider: "codex",
        threadId: "child-thread",
        taskThreadId: "root-thread",
        parentThreadId: "root-thread",
        turnId: "child-turn",
        projectRoot: root,
        taskTitle: "Root task",
        title: "Child result",
        completedAt: "2026-08-08T10:00:00.000Z",
        estimatedCredits: 1,
      }],
      projectRoot: root,
    });

    assert.deepEqual(assigned, [{
      reference: {
        provider: "codex",
        threadId: "root-thread",
        projectRoot: root,
      },
      options: { source: "discovered" },
    }]);
    const projected = await projectedJournal(store);
    assert.match(projected, /<strong>Other<\/strong>/u);
    assert.doesNotMatch(projected, /Без воркспейса/u);
    assert.doesNotMatch(projected, /data-thread-id="child-thread">Stream/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal keeps one Stream expandable and owns its total at Workspace level", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    only: {
      provider: "codex",
      threadId: "thread-only",
      turnId: "turn-only",
      taskTitle: "Only task",
      title: "Готово",
      estimatedCredits: 4,
      startedAt: "2026-07-30T09:00:00.000Z",
      completedAt: "2026-07-30T10:00:00.000Z",
    },
  }, {
    workspaceResolver: () => ({
      workspaceId: "workspace-only",
      workspaceName: "Only Workspace",
      workspaceKind: "user",
      streamId: "stream-only",
      streamOrdinal: 1,
      streamName: null,
      streamDisplayName: "",
    }),
  });
  assert.match(projected, /<details data-work-log-workspace[^>]* open>/u);
  assert.match(projected, /<summary data-work-log-workspace-header>/u);
  assert.match(projected, /<details data-work-log-stream[^>]* open>/u);
  assert.match(projected, /<summary data-work-log-stream-summary>/u);
  assert.match(projected, /data-work-log-turn-stream>Stream 1<\/span>/u);
  assert.match(
    projected,
    /data-work-log-workspace-usage>[\s\S]*?data-usage-credits="4"/u,
  );
  const workspaceSummary = projected.match(
    /<summary data-work-log-workspace-header>[\s\S]*?<\/summary>/u,
  )?.[0] ?? "";
  assert.match(workspaceSummary, /data-usage-credits="4"/u);
  assert.doesNotMatch(workspaceSummary, /Итого|data-usage-label/u);
  assert.doesNotMatch(workspaceSummary, /data-work-log-duration/u);
  const collapsedUsage = projected.match(
    /<div data-work-log-collapsed-workspace-usage hidden>[\s\S]*?<\/div>/u,
  )?.[0] ?? "";
  assert.match(collapsedUsage, /data-work-log-collapsed-workspace-usage-details/u);
  assert.match(collapsedUsage, /data-task-usage-breakdown/u);
  assert.match(collapsedUsage, /data-usage-credits="4"/u);
  assert.match(
    collapsedUsage,
    /data-work-log-duration-summary data-work-log-duration-seconds="3600"><span data-work-log-duration-percent>\(100%\)<\/span> <span data-work-log-duration>1 ч 0 мин<\/span><\/span><span data-kilo-usage[^>]*data-usage-credits="4"[^>]*>4 cr<\/span> <span data-usage-percent>\(100%\)<\/span>/u,
  );
  assert.doesNotMatch(collapsedUsage, /Итого|data-usage-label/u);
  assert.match(
    projected,
    /data-work-log-day-duration data-work-log-duration-seconds="3600">· 1 ч 0 мин/u,
  );
});

test("collapsed Workspace totals show elapsed time as a share of the day", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    short: {
      provider: "codex",
      threadId: "thread-short",
      turnId: "turn-short",
      estimatedCredits: 1,
      startedAt: "2026-07-30T09:00:00.000Z",
      completedAt: "2026-07-30T10:00:00.000Z",
    },
    long: {
      provider: "codex",
      threadId: "thread-long",
      turnId: "turn-long",
      estimatedCredits: 3,
      startedAt: "2026-07-30T10:00:00.000Z",
      completedAt: "2026-07-30T13:00:00.000Z",
    },
  }, {
    workspaceResolver: ({ threadId }) => ({
      workspaceId: threadId === "thread-short" ? "workspace-short" : "workspace-long",
      workspaceName: threadId === "thread-short" ? "Short" : "Long",
      workspaceKind: "user",
      streamId: threadId,
      streamOrdinal: 1,
      streamName: null,
      streamDisplayName: "Stream 1",
    }),
  });
  assert.match(
    projected,
    /data-work-log-workspace-id="workspace-short"[\s\S]*?data-work-log-duration-seconds="3600"[\s\S]*?data-work-log-duration-percent>\(25%\)/u,
  );
  assert.match(
    projected,
    /data-work-log-workspace-id="workspace-long"[\s\S]*?data-work-log-duration-seconds="10800"[\s\S]*?data-work-log-duration-percent>\(75%\)/u,
  );
  assert.match(
    projected,
    /data-work-log-day-duration data-work-log-duration-seconds="14400">· 4 ч 0 мин/u,
  );
});

test("seven-day usage matches journal calendar days and includes empty days", () => {
  const now = new Date(2026, 6, 30, 18, 0, 0, 0).getTime();
  const completedAt = (daysAgo, hour) => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hour, 0, 0, 0);
    return date.toISOString();
  };
  const history = buildWorkLogUsageHistory({
    first: { completedAt: completedAt(6, 10), estimatedCredits: 3, estimateKind: "model" },
    second: { completedAt: completedAt(0, 9), estimatedCredits: 4, estimateKind: "model" },
    third: { completedAt: completedAt(0, 17), estimatedCredits: 5, estimateKind: "model" },
  }, { range: "7d", now });
  assert.equal(history.bucket, "day");
  assert.equal(history.points.length, 7);
  assert.deepEqual(history.points.map((point) => point.credits), [3, 0, 0, 0, 0, 0, 9]);
  assert.ok(history.points.every((point) => new Date(point.at).getHours() === 0));
});

test("fifteen-day usage includes today and the fourteen preceding calendar days", () => {
  const now = new Date(2026, 7, 7, 18, 0, 0, 0).getTime();
  const completedAt = (daysAgo) => {
    const date = new Date(now);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(9, 0, 0, 0);
    return date.toISOString();
  };
  const history = buildWorkLogUsageHistory({
    firstIncludedDay: { completedAt: completedAt(14), estimatedCredits: 3, estimateKind: "model" },
    dayBeforeRange: { completedAt: completedAt(15), estimatedCredits: 7, estimateKind: "model" },
    today: { completedAt: completedAt(0), estimatedCredits: 5, estimateKind: "model" },
  }, { range: "15d", now });
  assert.equal(history.range, "15d");
  assert.equal(history.points.length, 15);
  assert.equal(history.totalCredits, 8);
  assert.deepEqual(history.points.map((point) => point.credits), [3, ...Array(13).fill(0), 5]);
});

test("day range covers the whole calendar day and keeps an axis to midnight", () => {
  const now = new Date(2026, 6, 30, 18, 36, 0, 0).getTime();
  const history = buildWorkLogUsageHistory({
    early: {
      completedAt: new Date(2026, 6, 30, 1, 15, 0, 0).toISOString(),
      estimatedCredits: 4,
      estimateKind: "model",
    },
  }, { range: "24h", now });
  assert.equal(new Date(history.from).getHours(), 0);
  assert.equal(new Date(history.axisTo).getHours(), 0);
  assert.equal(Date.parse(history.axisTo) - Date.parse(history.from), 24 * 60 * 60 * 1_000);
  assert.equal(history.totalCredits, 4);
  assert.equal(history.bucketMs, 30 * 60 * 1_000);
});

test("all-time history falls back to calendar days on long spans", () => {
  const now = new Date(2026, 6, 30, 18, 0, 0, 0).getTime();
  const turns = {};
  for (let index = 0; index < 60; index += 1) {
    const at = new Date(now);
    at.setDate(at.getDate() - index);
    at.setHours(9, 30, 0, 0);
    turns["turn" + index] = {
      completedAt: at.toISOString(),
      estimatedCredits: 2,
      estimateKind: "model",
    };
  }
  const history = buildWorkLogUsageHistory(turns, { range: "all", now });
  assert.equal(history.bucket, "day");
  assert.ok(history.points.every((point) => new Date(point.at).getHours() === 0));
});

test("all-time history respects maxPoints while preserving all credits", () => {
  const now = new Date(2026, 6, 30, 18, 0, 0, 0).getTime();
  const turns = {};
  for (let index = 0; index < 3_000; index += 1) {
    const at = new Date(now);
    at.setDate(at.getDate() - index);
    turns[`turn-${index}`] = {
      completedAt: at.toISOString(),
      estimatedCredits: 1,
      estimateKind: "model",
    };
  }
  const history = buildWorkLogUsageHistory(turns, { range: "all", now, maxPoints: 10 });
  assert.ok(history.points.length <= 10);
  assert.equal(history.points.reduce((sum, point) => sum + point.credits, 0), 3_000);
  assert.equal(history.totalCredits, 3_000);
});

test("Fast label uses the same model multiplier as credit calculation", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    mini: {
      provider: "codex",
      threadId: "thread-mini",
      turnId: "turn-mini",
      taskTitle: "Mini",
      title: "Проверка",
      usageReported: true,
      usage: { inputTokens: 1_000 },
      model: "gpt-5.4-mini",
      serviceTier: "fast",
      completedAt: "2026-07-30T12:00:00.000Z",
    },
  });
  assert.match(projected, /gpt-5\.4-mini · Fast ×1/u);
  assert.doesNotMatch(projected, /gpt-5\.4-mini · Fast ×2/u);
});

test("rate-limit summary is replaced in place above the journal days", () => {
  const first = projectWorkLogRateLimits(
    "# Глобальный журнал работ\n\n<details></details>\n",
    "CODEX - 94.0%\nSpark - 100.0%",
    "2026-07-29T10:00:00.000Z",
  );
  const second = projectWorkLogRateLimits(first, "CODEX - 93.0%", "2026-07-29T10:05:00.000Z");
  assert.equal((second.match(/data-work-log-rate-limits/gu) ?? []).length, 1);
  assert.match(
    second,
    /<span data-rate-limit><span data-rate-limit-name>CODEX<\/span><span data-rate-limit-value>93\.0%<\/span>/u,
  );
  assert.doesNotMatch(second, /94\.0%/u);
});

test("each rate-limit measure becomes a chip with its own reset", () => {
  const projected = projectWorkLogRateLimits(
    "# Глобальный журнал работ\n\n<details></details>\n",
    "CODEX - 87.0% - 6 дн. 14 ч.\nSpark - 100.0% - 7 дн.\nДоступно сбросов: 5",
    "",
  );
  assert.equal((projected.match(/data-rate-limit>/gu) ?? []).length, 2);
  assert.match(projected, /<span data-rate-limit-reset>6 дн\. 14 ч\.<\/span>/u);
  assert.match(projected, /<span data-rate-limit-group>/u);
  assert.match(
    projected,
    /<span data-rate-limit-credit><span data-rate-limit-credit-count>Сбросов 5<\/span><\/span>/u,
  );
  assert.match(projected, /<span data-rate-limit-caption>Лимиты<\/span>/u);
});

test("reset credits use a compact two-line cloud", () => {
  const projected = projectWorkLogRateLimits(
    "# Глобальный журнал работ\n\n<details></details>\n",
    "CODEX - 87.0% - 6 дн.\nСбросов 2\nДо 31 июл.",
    "",
  );
  assert.match(
    projected,
    /data-rate-limit-credit-count>Сбросов 2<\/span><span data-rate-limit-credit-deadline>До 31 июл\.<\/span>/u,
  );
});

test("applyWorkLogUsage replaces only the matching per-turn placeholder", () => {
  const source = [
    "<tr><td>",
    `<span data-usage-id="${WORK_ID}">${WORK_ID}</span> + `,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
    "</td></tr>",
  ].join("");
  assert.equal(
    applyWorkLogUsage(source, WORK_ID, {
      inputTokens: 356_973,
      cachedInputTokens: 348_672,
      outputTokens: 894,
      reasoningOutputTokens: 672,
    }),
    [
      "<tr><td>",
      `<span data-usage-id="${WORK_ID}">Итого 6,1 cr<br>Вход: 1,0 cr (17,1%)<br>Кэш: 4,4 cr (71,8%)<br>Запись кэша: 0 cr (0%)<br>Выход: 0,2 cr (2,8%)<br>Думы: 0,5 cr (8,3%)</span> + `,
      `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
      "</td></tr>",
    ].join(""),
  );
  assert.throws(() => applyWorkLogUsage("<table></table>", WORK_ID, 10), /found 0/);
});

test("projectWorkLogUsage renders turn tables, preserves legacy outcomes and calculates shares", () => {
  const firstCompletedAt = new Date(2026, 6, 25, 12, 34).toISOString();
  const secondCompletedAt = new Date(2026, 6, 25, 13, 45).toISOString();
  const firstStartedAt = new Date(2026, 6, 25, 12, 30, 30).toISOString();
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><colgroup><col><col><col></colgroup><thead>",
    "<tr><th>Задача</th><th>Итог</th><th>Расход</th></tr></thead><tbody>",
    `<tr><td>Task A</td><td>Outcome A<details><summary>Изменённые файлы</summary>a.mjs</details></td><td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span><br>`,
    `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span></td>`,
    "<td data-work-log-turns>legacy</td></tr>",
    `<tr><td>Task B</td><td>Outcome B</td><td><span data-usage-id="323e4567-e89b-42d3-a456-426614174000">pending</span></td></tr>`,
    `<tr><td>Task C</td><td>Outcome C</td><td><span data-usage-id="423e4567-e89b-42d3-a456-426614174000">recorded</span></td></tr>`,
    "</tbody></table>",
    "</details>",
  ].join("");
  const turns = {
    first: {
      workLogId: WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
      startedAt: firstStartedAt,
      completedAt: firstCompletedAt,
      text: "Первый <ход>\nСтрока",
      prompt: [
        "# Response annotations:",
        "<response-annotations>",
        '[{"text":"Старый ответ","annotation":"Короткий вопрос"}]',
        "</response-annotations>",
        "## My request for Codex:",
      ].join("\n"),
    },
    second: {
      workLogId: SECOND_WORK_ID,
      usage: { inputTokens: 50, cachedInputTokens: 0, outputTokens: 0 },
      completedAt: secondCompletedAt,
      text: "Второй & ход",
    },
    third: {
      workLogId: "423e4567-e89b-42d3-a456-426614174000",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 },
    },
  };
  const projected = projectWorkLogUsage(source, turns);
  assert.match(projected, /^<details data-work-log-day-section open>/);
  assert.match(projected, /<div data-work-log-table>/);
  assert.equal((projected.match(/<table\b/g) ?? []).length, 0);
  assert.equal((projected.match(/<div data-work-log-row/g) ?? []).length, 3);
  assert.doesNotMatch(projected, /data-work-log-previous-turn-table/);
  assert.match(
    projected,
    /<div data-work-log-header><strong>Поток<\/strong><strong>Ходы<\/strong><\/div>/,
  );
  assert.doesNotMatch(projected, /<strong>Расход<\/strong>/);
  assert.match(
    projected,
    /data-work-log-task-content>Task A<\/div><div data-work-log-usage><details data-task-usage-details>/,
  );
  assert.match(projected, /data-work-log-legacy-outcome>Outcome A<\/div>/);
  assert.match(projected, /data-work-log-legacy-outcome>Outcome B<\/div>/);
  assert.match(
    projected,
    /<div data-work-log-turn-table>[\s\S]*?data-work-log-turn-measure>13:45 — <span data-kilo-usage[^>]*>0,0 cr<\/span><\/span><span data-work-log-turn-share>\(50%\)<\/span>[\s\S]*?data-work-log-turn-title>Второй &amp; ход<\/span>[\s\S]*?<details data-work-log-previous-turns>[\s\S]*?data-work-log-turn-measure>12:34 — <span data-kilo-usage[^>]*>0,0 cr<\/span><\/span><span data-work-log-turn-share>\(50%\)<\/span>[\s\S]*?data-work-log-turn-title>Первый &lt;ход&gt; Строка<\/span>/,
  );
  assert.doesNotMatch(projected, /data-work-log-turn-files|a\.mjs/u);
  assert.match(
    projected,
    /<details data-work-log-previous-turns><summary><span data-work-log-previous-turns-closed>Показать предыдущие ходы \(1\)<\/span><span data-work-log-previous-turns-open>Свернуть<\/span><\/summary>/,
  );
  assert.match(
    projected,
    /<button type="button" data-work-log-collapse-turns>Свернуть ходы<\/button>/,
  );
  assert.match(
    projected,
    /<div data-work-log-usage>[\s\S]*?<button type="button" data-work-log-collapse-turns>Свернуть ходы<\/button><\/div><\/div>\s*<div data-work-log-turn-list>/,
  );
  assert.doesNotMatch(
    projected,
    /<details data-work-log-previous-turns>[\s\S]*?<button type="button" data-work-log-collapse-turns>/,
  );
  assert.equal((projected.match(/data-work-log-no-previous-turns/g) ?? []).length, 1);
  assert.match(projected, /data-work-log-no-previous-turns>Предыдущих ходов нет\.<\/div>/);
  assert.doesNotMatch(projected, /<details data-work-log-previous-turns open>/);
  assert.match(
    projected,
    /Второй &amp; ход[\s\S]*?<details data-work-log-previous-turns>[\s\S]*?data-work-log-previous-turn-list>[\s\S]*?Первый &lt;ход&gt; Строка[\s\S]*?<\/div><\/details>/,
  );
  assert.match(projected, /<strong>Длит\.:<\/strong> 3 мин 30 с/);
  assert.ok(projected.includes('data-work-log-turn-duration-seconds="210"'));
  assert.ok(projected.includes(`data-work-log-turn-completed-at="${firstCompletedAt}"`));
  assert.equal((projected.match(/data-work-log-turn-duration-seconds=/g) ?? []).length, 1);
  assert.equal((projected.match(/data-work-log-turn-credits=/g) ?? []).length, 3);
  assert.equal((projected.match(/data-work-log-turn-file-count=/g) ?? []).length, 3);
  assert.equal((projected.match(/data-work-log-turn-change-lines=/g) ?? []).length, 3);
  assert.equal((projected.match(/data-work-log-turn-subagent=/g) ?? []).length, 3);
  assert.match(projected, /<strong>Запрос:<\/strong> Короткий вопрос/);
  assert.doesNotMatch(projected, /Response annotations|response-annotations|Старый ответ/);
  assert.doesNotMatch(projected, /data-work-log-legacy-files/);
  assert.match(
    projected,
    /data-day-usage><span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="[^"]+"[^>]*>0,0 cr<\/span>/,
  );
  assert.match(
    projected,
    /data-work-log-day-duration data-work-log-duration-seconds="210">· 4 мин<\/span>/,
  );
  assert.doesNotMatch(projected, /За день:/);
  assert.match(
    projected,
    /<summary data-work-log-day><strong>25\.07\.2026<\/strong> <span data-day-usage-table>[\s\S]*?<\/summary>/,
  );
  assert.doesNotMatch(projected, /data-day-usage-details/);
  assert.doesNotMatch(
    projected.match(/<span data-day-usage-breakdown>[\s\S]*?<\/span>/)?.[0] ?? "",
    /<br>/,
  );
  assert.equal((projected.match(/data-day-usage-part/g) ?? []).length, 5);
  assert.match(projected, /Task A[\s\S]*?<span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="[^"]+"[^>]*>0,0 cr<\/span> <span data-usage-percent>\(50%\)<\/span>/);
  assert.match(projected, /Task C[\s\S]*?<span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="[^"]+"[^>]*>0,0 cr<\/span> <span data-usage-percent>\(50%\)<\/span>/);
  assert.match(
    projected,
    /<details data-task-usage-details><summary data-task-usage><span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="[^"]+"[^>]*>0,0 cr<\/span> <span data-usage-percent>\(50%\)<\/span><\/summary><span data-task-usage-breakdown><span data-task-usage-part>Вход:/,
  );
  assert.doesNotMatch(projected, /<details data-task-usage-details open>/);
  assert.match(
    projected,
    /data-work-log-task-content>Task B<\/div><div data-work-log-usage><span data-usage-id="323e4567-e89b-42d3-a456-426614174000" hidden>[\s\S]*?data-work-log-legacy-outcome>Outcome B<\/div>/,
  );
  assert.equal((projected.match(/data-task-usage>/g) ?? []).length, 2);
  assert.equal((projected.match(/data-task-usage-details/g) ?? []).length, 2);
  assert.equal((projected.match(/data-task-usage-part/g) ?? []).length, 10);
  assert.equal((projected.match(/data-usage-id=/g) ?? []).length, 4);
  assert.equal((projected.match(/data-usage-id=[^>]+hidden/g) ?? []).length, 4);
  const reprojected = projectWorkLogUsage(projected, turns);
  assert.equal((reprojected.match(/data-work-log-day-section/g) ?? []).length, 1);
  assert.equal(reprojected, projected);
});

test("projectWorkLogUsage keeps Claude turns visible but excludes their spend when disabled", () => {
  const completedAt = new Date(2026, 6, 25, 12, 0).toISOString();
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    codex: {
      provider: "codex",
      threadId: "codex-thread",
      turnId: "codex-turn",
      taskTitle: "Codex task",
      completedAt,
      estimatedCredits: 5,
      estimateKind: "model",
    },
    claude: {
      provider: "claude",
      threadId: "claude-thread",
      turnId: "claude-turn",
      taskTitle: "Claude task",
      completedAt,
      estimatedCredits: 7,
      estimateKind: "model",
    },
  }, { includeClaudeUsage: false });

  assert.match(projected, /data-day-usage><span data-usage-label>Итого<\/span> <span data-kilo-usage data-usage-credits="5"[^>]*>5 cr<\/span>/u);
  assert.match(projected, /data-work-log-provider="claude"[\s\S]*?Claude task/u);
  assert.equal((projected.match(/data-task-usage>/gu) ?? []).length, 1);
  assert.equal((projected.match(/data-work-log-turn-credits=/gu) ?? []).length, 2);
});

test("usage breakdown keeps exact credits behind the rounded label", () => {
  const completedAt = new Date(2026, 6, 25, 12, 0).toISOString();
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    codex: {
      provider: "codex",
      threadId: "codex-thread",
      turnId: "codex-turn",
      taskTitle: "Codex task",
      completedAt,
      model: "gpt-5.6-sol",
      usage: { inputTokens: 9_876_543, outputTokens: 1_234_567 },
    },
  });

  /* «1,2 kcr» нельзя разобрать обратно без потери 2,8 %, поэтому точное значение
     обязано ехать атрибутом у каждой части разбивки, а не только у итогов. */
  assert.match(
    projected,
    /data-task-usage-part>Вход: <span data-mega-usage data-usage-credits="1234\.567875"[^>]*>1,2 kcr<\/span>/u,
  );
  assert.match(
    projected,
    /data-task-usage-part>Выход: <span data-kilo-usage data-usage-credits="925\.92525"[^>]*>925,9 cr<\/span>/u,
  );
  assert.match(
    projected,
    /data-day-usage-part>Вход: <span data-mega-usage data-usage-credits="1234\.567875"[^>]*>1,2 kcr<\/span>/u,
  );
  assert.doesNotMatch(projected, /data-(?:kilo|mega|high)-usage>/u);
});

test("tasks inside a day are sorted by their latest turn descending", () => {
  const source = [
    "<details><summary><strong>25.07.2026</strong></summary>",
    "<div data-work-log-table><div data-work-log-body>",
    '<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="old">',
    "<div data-work-log-task-cell><div data-work-log-task-content>Old task</div></div>",
    '<div data-work-log-turn-list></div></div>',
    '<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="fresh">',
    "<div data-work-log-task-cell><div data-work-log-task-content>Fresh task</div></div>",
    '<div data-work-log-turn-list></div></div>',
    "</div></div></details>",
  ].join("");
  const projected = projectWorkLogUsage(source, {
    old: {
      provider: "codex",
      threadId: "old",
      turnId: "turn-old",
      taskTitle: "Old task",
      completedAt: "2026-07-25T10:00:00.000Z",
      usage: { inputTokens: 1 },
    },
    fresh: {
      provider: "codex",
      threadId: "fresh",
      turnId: "turn-fresh",
      taskTitle: "Fresh task",
      completedAt: "2026-07-25T12:00:00.000Z",
      usage: { inputTokens: 1 },
    },
  });

  assert.ok(projected.indexOf("Fresh task") < projected.indexOf("Old task"));
  assert.equal(projectWorkLogUsage(projected, {
    old: {
      provider: "codex",
      threadId: "old",
      turnId: "turn-old",
      taskTitle: "Old task",
      completedAt: "2026-07-25T10:00:00.000Z",
      usage: { inputTokens: 1 },
    },
    fresh: {
      provider: "codex",
      threadId: "fresh",
      turnId: "turn-fresh",
      taskTitle: "Fresh task",
      completedAt: "2026-07-25T12:00:00.000Z",
      usage: { inputTokens: 1 },
    },
  }), projected);
});

test("projectWorkLogUsage keeps exact diffs out of the compact journal projection", () => {
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><tbody><tr>",
    "<td>Task</td><td></td>",
    `<td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span></td>`,
    "</tr></tbody></table>",
    "</details>",
  ].join("");
  const projected = projectWorkLogUsage(source, {
    diff: {
      workLogId: WORK_ID,
      provider: "codex",
      threadId: "thread-diff",
      turnId: "turn-diff",
      taskThreadId: "thread-diff",
      taskTitle: "Task",
      completedAt: new Date(2026, 6, 25, 13, 45).toISOString(),
      changedFiles: ["src/a.mjs"],
      diff: [
        "diff --git a/src/a.mjs b/src/a.mjs",
        "--- a/src/a.mjs",
        "+++ b/src/a.mjs",
        "@@ -1 +1 @@",
        "-const value = 1;",
        "+const value = 2;",
      ].join("\n"),
    },
  });
  assert.doesNotMatch(projected, /data-work-log-turn-diff/u);
  assert.doesNotMatch(projected, /const value/u);
  assert.doesNotMatch(projected, /data-work-log-turn-files>[\s\S]*src\/a\.mjs/u);
  assert.match(projected, /data-work-log-turn-file-count="1"/u);
  assert.match(projected, /data-work-log-turn-change-lines="2"/u);
});

test("projectWorkLogUsage exposes compact skill and MCP profile metrics", () => {
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><tbody><tr>",
    "<td>Task</td><td></td>",
    `<td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span></td>`,
    "</tr></tbody></table>",
    "</details>",
  ].join("");
  const projected = projectWorkLogUsage(source, {
    tools: {
      workLogId: WORK_ID,
      provider: "codex",
      threadId: "thread-tools",
      turnId: "turn-tools",
      taskThreadId: "thread-tools",
      taskTitle: "Task",
      completedAt: new Date(2026, 6, 25, 13, 45).toISOString(),
      skillsUsed: ["openai-docs", "plugin:review"],
      mcpCalls: [
        { id: "one", server: "docs", tool: "search", status: "completed" },
        { id: "two", server: "github", tool: "read", status: "failed" },
      ],
      toolMetricsKnown: true,
    },
  });
  assert.match(projected, /data-work-log-turn-skills="\[&quot;openai-docs&quot;,&quot;plugin:review&quot;\]"/u);
  assert.match(projected, /data-work-log-turn-mcp-calls="2"/u);
  assert.match(projected, /data-work-log-turn-mcp-tools="\[&quot;docs\/search&quot;,&quot;github\/read&quot;\]"/u);
  assert.match(projected, /data-work-log-turn-mcp-failures="1"/u);
});

test("projectWorkLogUsage does not present changed-file paths as a missing diff", () => {
  const source = [
    "<details open>",
    "<summary><strong>25.07.2026</strong></summary>",
    "<table><tbody><tr>",
    "<td>Task</td><td></td>",
    `<td data-work-log-usage><span data-usage-id="${WORK_ID}">${WORK_ID}</span></td>`,
    "</tr></tbody></table>",
    "</details>",
  ].join("");
  const projected = projectWorkLogUsage(source, {
    missingDiff: {
      workLogId: WORK_ID,
      provider: "codex",
      threadId: "thread-no-diff",
      turnId: "turn-no-diff",
      taskThreadId: "thread-no-diff",
      taskTitle: "Task",
      completedAt: new Date(2026, 6, 25, 13, 45).toISOString(),
      changedFiles: ["src/noisy-path.mjs"],
      diff: "",
    },
  });
  assert.doesNotMatch(projected, /noisy-path\.mjs/u);
  assert.doesNotMatch(projected, /data-work-log-turn-diff/u);
});

test("projectWorkLogUsage marks every day as an independent layout section", () => {
  const source = [
    "<details open><summary><strong>25.07.2026</strong></summary></details>",
    "<details open><summary><strong>24.07.2026</strong></summary></details>",
  ].join("\n");
  const projected = projectWorkLogUsage(source);

  assert.match(projected, /^<details data-work-log-day-section open>/);
  assert.match(projected, /\n<details data-work-log-day-section>/);
  assert.equal((projected.match(/data-work-log-day-section open/g) ?? []).length, 1);
  assert.equal((projected.match(/data-work-log-day-section/g) ?? []).length, 2);
  assert.equal((projected.match(/summary data-work-log-day/g) ?? []).length, 2);
});

test("projectWorkLogUsage removes stale table fragments from a partially migrated day", () => {
  const source = [
    '<details open><summary><strong>27.07.2026</strong></summary>',
    '<div data-work-log-table><div data-work-log-body>',
    '<div data-work-log-row><div data-work-log-task-cell>',
    `<div data-work-log-task-content>Task</div><div data-work-log-usage><span data-usage-id="${WORK_ID}" hidden></span></div>`,
    '</div><div data-work-log-turn-list></div></div></div></div>',
    '<tr><td>stale task</td><td>stale turn</td></tr></tbody></table>',
    "</details>",
  ].join("");
  const turns = {
    turn: {
      workLogId: WORK_ID,
      turnId: "turn",
      usage: { inputTokens: 100 },
      completedAt: new Date(2026, 6, 27, 10, 0).toISOString(),
    },
  };

  const projected = projectWorkLogUsage(source, turns);

  assert.equal((projected.match(/<div data-work-log-row/g) ?? []).length, 1);
  assert.doesNotMatch(projected, /<(?:table|tr|td)\b|stale task|stale turn/);
  assert.equal(projectWorkLogUsage(projected, turns), projected);
});

test("projectWorkLogUsage canonicalizes a unique legacy row and refreshes its task title", () => {
  const workLogId = "823e4567-e89b-42d3-a456-426614174000";
  const completedAt = new Date(2026, 6, 27, 10, 0).toISOString();
  const source = "<details open><summary><strong>27.07.2026</strong></summary><table><tbody>"
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-legacy">Codex - Старое имя</a></td>'
    + `<td></td><td><span data-usage-id="${workLogId}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const turns = {
    "codex\0thread-legacy\0turn-legacy": {
      provider: "codex",
      threadId: "thread-legacy",
      turnId: "turn-legacy",
      workLogId,
      taskTitle: "Название из Agent Hub",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 100 },
    },
  };

  const projected = projectWorkLogUsage(source, turns);

  assert.match(
    projected,
    /<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="thread-legacy">/,
  );
  assert.match(
    projected,
    /<button type="button" data-open-task data-provider="codex" data-thread-id="thread-legacy">Codex - Название из Agent Hub<\/button>/,
  );
  assert.match(
    projected,
    /data-work-log-turn-provider="codex" data-work-log-turn-thread-id="thread-legacy" data-work-log-task-thread-id="thread-legacy"[^>]*data-work-log-turn-id="turn-legacy"/,
  );
  assert.match(
    projected,
    /<button type="button" data-open-turn[^>]*><svg data-phosphor-icon="arrow-square-out"/,
  );
  assert.doesNotMatch(projected, />Codex - Старое имя<\/a>/);
});

test("projectWorkLogUsage keeps ambiguous legacy rows with one thread separate", () => {
  const firstId = "923e4567-e89b-42d3-a456-426614174000";
  const secondId = "a23e4567-e89b-42d3-a456-426614174000";
  const completedAt = new Date(2026, 6, 26, 10, 0).toISOString();
  const source = "<details><summary><strong>26.07.2026</strong></summary><table><tbody>"
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-shared">Codex - Первая работа</a></td>'
    + `<td></td><td><span data-usage-id="${firstId}" hidden></span></td></tr>`
    + '<tr><td><a href="vscode://openai.chatgpt/local/thread-shared">Codex - Вторая работа</a></td>'
    + `<td></td><td><span data-usage-id="${secondId}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const turns = Object.fromEntries([
    ["turn-first", firstId],
    ["turn-second", secondId],
  ].map(([turnId, workLogId]) => [
    `codex\0thread-shared\0${turnId}`,
    {
      provider: "codex",
      threadId: "thread-shared",
      turnId,
      workLogId,
      taskTitle: "Общее имя",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 100 },
    },
  ]));

  const projected = projectWorkLogUsage(source, turns);

  assert.equal((projected.match(/data-work-log-thread-id="thread-shared"/g) ?? []).length, 0);
  assert.match(projected, />Codex - Первая работа<\/a>/);
  assert.match(projected, />Codex - Вторая работа<\/a>/);
});

test("work log colors kilo, mega and giga-or-higher usage independently", () => {
  const source = `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
    + `<tr><td>Task</td><td></td><td><span data-usage-id="${GIGA_WORK_ID}" hidden></span></td></tr>`
    + "</tbody></table></details>";
  const projected = projectWorkLogUsage(source, {
    turn: {
      workLogId: GIGA_WORK_ID,
      usage: { inputTokens: 1_000_000_000 },
      completedAt: "2026-07-25T00:00:00.000Z",
      text: "Большой ход",
    },
  });
  assert.match(projected, /data-mega-usage[^>]*>125,0 kcr<\/span>/);
});

test("work log CSS keeps dates equal and shows a compact always-visible turn list", async () => {
  const css = await readFile(new URL("../../work-log.css", import.meta.url), "utf8");
  assert.match(
    css,
    /details\[data-work-log-day-section\][\s\S]*?background-color:[\s\S]*?border-radius:[\s\S]*?padding:/,
  );
  assert.match(
    css,
    /details\[data-work-log-day-section\]\[open\][\s\S]*?background-color:/,
  );
  assert.match(css, /summary\[data-work-log-day\][\s\S]*?font-size:\s*1em/);
  assert.match(
    css,
    /div\[data-work-log-header\],[\s\S]*?div\[data-work-log-row\][\s\S]*?grid-template-columns:\s*28ch minmax\(0, 1fr\)/,
  );
  assert.match(css, /--work-log-task-card-width:\s*26ch/);
  assert.match(
    css,
    /div\[data-work-log-turn-table\][\s\S]*?width:\s*100%[\s\S]*?data-work-log-turn-entry\] \+ div\[data-work-log-turn-entry\][\s\S]*?margin-top:\s*0\.35em/,
  );
  assert.match(
    css,
    /div\[data-work-log-task-cell\] > div\[data-work-log-task-content\][\s\S]*?border:[\s\S]*?padding:\s*0\.3em 0\.45em[\s\S]*?width:\s*var\(--work-log-task-card-width\)/,
  );
  assert.match(
    css,
    /summary\[data-task-usage\][\s\S]*?padding:\s*0\.3em 0\.45em[\s\S]*?width:\s*var\(--work-log-task-card-width\)/,
  );
  assert.doesNotMatch(css, /table\[data-work-log-table\]/);
  assert.match(css, /details\[data-work-log-turn-details\] > summary[\s\S]*?display:\s*grid/);
  assert.match(
    css,
    /span\[data-work-log-turn-meta\][\s\S]*?display:\s*flex[\s\S]*?justify-content:\s*space-between/,
  );
  assert.match(css, /summary::-webkit-details-marker[\s\S]*?display:\s*none/);
  assert.match(
    css,
    /details\[data-work-log-turn-details\]\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?border-radius:\s*4px/,
  );
  assert.match(
    css,
    /details\[data-work-log-turn-details\]\[open\]\s*\{[\s\S]*?border:\s*2px solid var\(--vscode-focusBorder/,
  );
  assert.match(
    css,
    /div\[data-work-log-turn-table\]\s*\{[\s\S]*?border:\s*1px solid[\s\S]*?border-radius:\s*4px[\s\S]*?overflow:\s*hidden/,
  );
  assert.match(
    css,
    /details\[data-work-log-previous-turns\]\s*\{[\s\S]*?border-top:\s*1px solid[\s\S]*?flex-direction:\s*column/,
  );
  assert.match(
    css,
    /details\[data-work-log-previous-turns\] > summary[\s\S]*?order:\s*2/,
  );
  assert.match(
    css,
    /div\[data-work-log-usage\] > button\[data-work-log-collapse-turns\]\s*\{[\s\S]*?display:\s*none[\s\S]*?width:\s*100%/,
  );
  assert.match(
    css,
    /div\[data-work-log-row\]:has\(details\[data-work-log-previous-turns\]\[open\]\)[\s\S]*?div\[data-work-log-usage\] > button\[data-work-log-collapse-turns\][\s\S]*?display:\s*block/,
  );
  assert.match(
    css,
    /div\[data-work-log-previous-turn-list\]\s*\{[\s\S]*?order:\s*1/,
  );
  assert.match(
    css,
    /div\[data-work-log-no-previous-turns\]\s*\{[\s\S]*?border-bottom:\s*1px solid[\s\S]*?padding:\s*0\.3em 0\.45em/,
  );
  assert.match(
    css,
    /data-work-log-previous-turns\]\[open\][\s\S]*?data-work-log-previous-turns-closed[\s\S]*?display:\s*none/,
  );
  assert.match(
    css,
    /data-work-log-previous-turns\]\[open\][\s\S]*?data-work-log-previous-turns-open[\s\S]*?display:\s*inline/,
  );
  assert.doesNotMatch(css, /data-work-log-turns-toggle/);
  assert.match(
    css,
    /span\[data-kilo-usage\][\s\S]*?#e5c07b[\s\S]*?span\[data-mega-usage\][\s\S]*?#ff9d00[\s\S]*?span\[data-high-usage\][\s\S]*?#f14c4c/,
  );
});

test("work log limits visible turn titles to 100 characters", () => {
  const source = "<details open><summary><strong>27.07.2026</strong></summary>"
    + "<table><tbody><tr><td>Task</td><td></td><td></td></tr></tbody></table></details>";
  const projected = projectWorkLogUsage(source, {
    turn: {
      provider: "codex",
      threadId: "thread-title",
      turnId: "turn-title",
      taskTitle: "Title",
      title: "Т".repeat(120),
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
    },
  });
  assert.match(projected, new RegExp(`data-work-log-turn-title>${"Т".repeat(100)}<\\/span>`));
  assert.doesNotMatch(projected, new RegExp("Т{101}"));
});

test("collapsed previous turns remain idempotent without a legacy outcome", () => {
  const source = "<details open><summary><strong>27.07.2026</strong></summary>"
    + '<table><tbody><tr data-work-log-provider="codex" data-work-log-thread-id="thread-idempotent">'
    + "<td>Task</td><td></td></tr></tbody></table></details>";
  const turns = Object.fromEntries(["first", "second"].map((turnId, index) => [
    `codex\0thread-idempotent\0${turnId}`,
    {
      provider: "codex",
      threadId: "thread-idempotent",
      turnId,
      taskTitle: "Title",
      title: `Ход ${index + 1}`,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: `2026-07-27T00:0${index}:00.000Z`,
    },
  ]));
  const projected = projectWorkLogUsage(source, turns);
  const reprojected = projectWorkLogUsage(projected, turns);
  assert.equal(reprojected, projected);
  assert.equal((reprojected.match(/data-work-log-turn-id=/g) ?? []).length, 2);
  assert.equal((reprojected.match(/data-work-log-legacy-outcome/g) ?? []).length, 0);
});

test("subagent usage is summed into its root task and shown as child turns", () => {
  const projected = projectWorkLogUsage("# Глобальный журнал работ\n", {
    "codex\0root\0root-turn": {
      provider: "codex",
      threadId: "root",
      turnId: "root-turn",
      taskTitle: "Root task",
      title: "Основной результат",
      usageReported: true,
      usage: { inputTokens: 100_000 },
      completedAt: "2026-07-27T00:01:00.000Z",
    },
    "codex\0child\0child-turn": {
      provider: "codex",
      threadId: "child",
      taskThreadId: "root",
      parentThreadId: "root",
      parentTurnId: "root-turn",
      aggregateOnly: true,
      turnId: "child-turn",
      taskTitle: "Root task",
      title: "Скрытый результат субагента",
      usageReported: true,
      usage: { inputTokens: 50_000 },
      completedAt: "2026-07-27T00:02:00.000Z",
    },
    "codex\0child-2\0child-turn-2": {
      provider: "codex",
      threadId: "child-2",
      taskThreadId: "root",
      parentThreadId: "root",
      parentTurnId: "root-turn",
      aggregateOnly: true,
      turnId: "child-turn-2",
      taskTitle: "Root task",
      title: "Прерванный скрытый результат субагента",
      status: "aborted",
      usageReported: true,
      usage: { inputTokens: 25_000 },
      completedAt: "2026-07-27T00:03:00.000Z",
    },
    "codex\0grandchild\0grandchild-turn": {
      provider: "codex",
      threadId: "grandchild",
      taskThreadId: "root",
      parentThreadId: "child",
      parentTurnId: "child-turn",
      aggregateOnly: true,
      turnId: "grandchild-turn",
      taskTitle: "Root task",
      title: "Вложенный субагент",
      usageReported: true,
      usage: { inputTokens: 10_000 },
      completedAt: "2026-07-27T00:04:00.000Z",
    },
  });

  assert.match(projected, /data-work-log-thread-id="root"/);
  assert.match(projected, /<span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>23,1 cr<\/span>/);
  assert.equal((projected.match(/data-work-log-turn-id=/g) ?? []).length, 4);
  assert.equal((projected.match(/data-work-log-turn-subagent="1"/g) ?? []).length, 3);
  assert.match(projected, /Основной результат/);
  assert.match(projected, /Субагент · Скрытый результат субагента/);
  assert.match(projected, /Субагент · Прерванный скрытый результат субагента/);
  assert.match(projected, /Субагент · Вложенный субагент/);
  assert.match(
    projected,
    /data-work-log-turn-thread-id="child" data-work-log-task-thread-id="root" data-work-log-turn-parent-thread-id="root" data-work-log-turn-parent-turn-id="root-turn" data-work-log-turn-depth="1" data-work-log-turn-id="child-turn"/,
  );
  assert.match(
    projected,
    /data-work-log-turn-id="root-turn"[\s\S]*data-work-log-turn-children-details>[\s\S]*data-work-log-turn-id="child-turn"[\s\S]*data-work-log-turn-children-details>[\s\S]*data-work-log-turn-id="grandchild-turn"/,
  );
  assert.match(projected, /Показать субагентов \(3\)/);
  assert.match(projected, /Показать субагентов \(1\)/);
  assert.doesNotMatch(projected, /data-work-log-turn-children-details open/);
  assert.match(
    projected,
    /data-work-log-turn-id="root-turn"[^>]*data-work-log-turn-credits="12\.5"[^>]*data-work-log-turn-total-credits="23\.125"/,
  );
  assert.match(
    projected,
    /root-turn[\s\S]*data-work-log-turn-measure>[^<]+ — <span [^>]*>23,1 cr<\/span>[\s\S]*<strong>Свой расход:<\/strong> <span [^>]*>12,5 cr<\/span>/,
  );
  assert.match(
    projected,
    /child-turn[\s\S]*data-work-log-turn-measure>[^<]+ — <span [^>]*>7,5 cr<\/span>[\s\S]*<strong>Свой расход:<\/strong> <span [^>]*>6,3 cr<\/span>/,
  );
  assert.match(projected, /data-work-log-turn-depth="2" data-work-log-turn-id="grandchild-turn"/);
  assert.doesNotMatch(projected, /data-work-log-thread-id="child"/);
});

test("usage store quarantines inherited parent turns copied into a subagent rollout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-subagent-fork-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const childThreadId = "019fa366-e7a9-7aa1-b38a-6823c3a67e77";
    const inheritedTurnId = "019fa362-ffaf-7cd3-9c8f-480d9724657a";
    const childTurnId = "019fa366-e87d-7933-8ae8-f33a5200b24e";
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 5,
      turns: {
        [`codex\0${childThreadId}\0${inheritedTurnId}`]: {
          provider: "codex",
          threadId: childThreadId,
          taskThreadId: "root",
          parentThreadId: "root",
          aggregateOnly: true,
          turnId: inheritedTurnId,
          taskTitle: "Root task",
          title: "Copied parent turn",
          usage: { inputTokens: 100_000 },
          completedAt: "2026-07-27T11:47:38.192Z",
        },
        [`codex\0${childThreadId}\0${childTurnId}`]: {
          provider: "codex",
          threadId: childThreadId,
          taskThreadId: "root",
          parentThreadId: "root",
          aggregateOnly: true,
          turnId: childTurnId,
          taskTitle: "Root task",
          title: "Real child turn",
          usage: { inputTokens: 50_000 },
          completedAt: "2026-07-27T11:50:38.875Z",
        },
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");

    const store = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await store.project(workLogFile), { projected: true });
    const projected = await projectedJournal(store);
    assert.match(projected, /<span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>6,3 cr<\/span>/);
    assert.match(projected, /Субагент · Real child turn/);
    assert.doesNotMatch(projected, /Copied parent turn/);
    const persisted = await persistedLedger(store);
    assert.deepEqual(Object.keys(persisted.turns), [`codex\0${childThreadId}\0${childTurnId}`]);
    const quarantined = JSON.parse(await readFile(`${ledgerFile}.invalid-records.json`, "utf8"));
    assert.equal(quarantined.records.length, 1);
    assert.equal(quarantined.records[0].record.turnId, inheritedTurnId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store projects each turn into its own placeholder and deduplicates retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-usage-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      [
        "<details open><summary><strong>25.07.2026</strong></summary><table><tbody><tr><td>Task</td><td>Outcome</td><td>",
        `<span data-usage-id="${WORK_ID}">${WORK_ID}</span> + `,
        `<span data-usage-id="${SECOND_WORK_ID}">${SECOND_WORK_ID}</span>`,
        "</td></tr></tbody></table></details>",
      ].join(""),
      "utf8",
    );
    const store = new WorkLogUsageStore({ ledgerFile });
    const base = {
      provider: "codex",
      threadId: "thread-1",
      workLogId: WORK_ID,
      usageReported: true,
      workLogFile,
      usage: {
        inputTokens: 110,
        cachedInputTokens: 100,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      },
      text: "Первый результат",
    };
    await store.recordAndProject({ ...base, turnId: "turn-1" });
    await store.recordAndProject({ ...base, turnId: "turn-1" });
    await store.recordAndProject({
      ...base,
      turnId: "turn-2",
      workLogId: SECOND_WORK_ID,
      text: "Второй результат",
    });
    const projected = await projectedJournal(store);
    assert.match(
      projected,
      /data-day-usage><span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>0,0 cr<\/span>/,
    );
    assert.equal((projected.match(/data-day-usage-breakdown/g) ?? []).length, 1);
    assert.match(
      projected,
      /<details data-task-usage-details><summary data-task-usage><span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>0,0 cr<\/span> <span data-usage-percent>\(100%\)<\/span><\/summary><span data-task-usage-breakdown><span data-task-usage-part>Вход:/,
    );
    assert.doesNotMatch(projected, /data-usage-id=/u);
    const ledger = await persistedLedger(store);
    assert.equal(Object.keys(ledger.turns).length, 2);
    assert.deepEqual(
      Object.values(ledger.turns).map((record) => record.body),
      ["Первый результат", "Второй результат"],
    );
    const restored = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await restored.project(workLogFile), {
      projected: false,
      reason: "unchanged",
    });
    assert.deepEqual(await restored.project(path.join(root, "MISSING.md")), {
      projected: false,
      reason: "unchanged",
    });
    await assert.rejects(
      store.recordAndProject({ ...base, turnId: "turn-3" }),
      /already assigned to another turn/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh usage store reprojects an existing work log with its persisted ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-reproject-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 1,
      turns: {
        turn: {
          workLogId: WORK_ID,
          usage: { inputTokens: 1_756_500 },
          completedAt: "2026-07-25T00:00:00.000Z",
          text: "Сохранённый результат",
          prompt: [
            "# Response annotations:",
            "<response-annotations>",
            '[{"text":"Старый ответ","annotation":"Сохранённый вопрос"}]',
            "</response-annotations>",
            "## My request for Codex:",
          ].join("\n"),
        },
      },
    })}\n`, "utf8");
    await writeFile(
      workLogFile,
      `<details open><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td>Task</td><td>Outcome</td><td><span data-usage-id="${WORK_ID}" hidden></span></td></tr>`
        + "</tbody></table></details>",
      "utf8",
    );

    const store = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await store.project(workLogFile), { projected: true });
    const projected = await projectedJournal(store);
    const projectedTurns = await projectedJournalTurns(store);
    assert.match(projected, /data-task-usage><span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>219,6 cr<\/span> <span data-usage-percent>\(100%\)<\/span>/);
    assert.match(projectedTurns, /data-work-log-turn-body>Сохранённый результат<\/div>/);
    assert.match(projectedTurns, /<strong>Запрос:<\/strong> Сохранённый вопрос/);
    assert.doesNotMatch(projectedTurns, /response-annotations|Старый ответ/);
    assert.doesNotMatch(projected, /data-mega-usage[^>]*>[^<]*cr/);
    const persisted = await persistedLedger(store);
    assert.equal(Object.values(persisted.turns)[0].prompt, "Сохранённый вопрос");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("versioned prices survive pricing backfill, restart and reprojection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-versioned-pricing-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const oldKey = "codex\u0000thread-old-price\u0000turn-old-price";
    const currentKey = "codex\u0000thread-current-price\u0000turn-current-price";
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 9,
      turns: {
        [oldKey]: {
          provider: "codex",
          threadId: "thread-old-price",
          taskThreadId: "thread-old-price",
          turnId: "turn-old-price",
          projectRoot: root,
          taskTitle: "Historical tariff",
          title: "Before price change",
          usageReported: true,
          usage: { inputTokens: 1_000_000 },
          model: "",
          serviceTier: "default",
          pricingMetadataResolved: false,
          completedAt: "2026-09-07T23:59:59.999Z",
        },
        [currentKey]: {
          provider: "codex",
          threadId: "thread-current-price",
          taskThreadId: "thread-current-price",
          turnId: "turn-current-price",
          projectRoot: root,
          taskTitle: "Current tariff",
          title: "At price change",
          usageReported: true,
          usage: { inputTokens: 1_000_000 },
          model: "gpt-5.6-sol",
          serviceTier: "default",
          pricingMetadataResolved: true,
          completedAt: "2026-09-08T00:00:00.000Z",
        },
      },
    })}\n`, "utf8");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");

    const firstStore = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await firstStore.project(workLogFile);
    const beforeBackfill = await projectedJournal(firstStore);
    assert.match(beforeBackfill, /data-usage-label>Итого<\/span> <span [^>]*>225 cr<\/span>/u);

    const backfill = await firstStore.synchronizePricingMetadataAndProject({
      projectRoot: root,
      workLogFile,
      items: [{
        provider: "codex",
        threadId: "thread-old-price",
        turnId: "turn-old-price",
        model: "gpt-5.6-sol",
        serviceTier: "default",
      }],
    });
    assert.equal(backfill.updated, 1);
    assert.equal((await persistedLedger(firstStore)).turns[oldKey].completedAt, "2026-09-07T23:59:59.999Z");
    const afterBackfill = await projectedJournal(firstStore);
    assert.match(afterBackfill, /data-usage-label>Итого<\/span> <span [^>]*>225 cr<\/span>/u);
    assert.notEqual(afterBackfill, beforeBackfill, "exact model adds QU metadata without repricing credits");
    await firstStore.close();
    openStores.delete(firstStore);

    const restoredStore = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await restoredStore.project(workLogFile);
    assert.equal(await projectedJournal(restoredStore), afterBackfill);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store backfills exact model and Fast tier before recalculating credits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-pricing-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const turnId = "turn-pricing";
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 6,
      turns: {
        [`codex\u0000thread-pricing\u0000${turnId}`]: {
          provider: "codex",
          threadId: "thread-pricing",
          turnId,
          workLogId: WORK_ID,
          projectRoot: root,
           usageReported: true,
           usage: { inputTokens: 1_000_000 },
           model: "gpt-5.6-sol",
           serviceTier: "default",
           startedAt: "2026-07-25T00:00:00.000Z",
           completedAt: "2026-07-25T00:00:00.000Z",
          title: "Тариф восстановлен",
        },
      },
    })}\n`, "utf8");
    await writeFile(
      workLogFile,
      `<details open><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td>Task</td><td>Outcome</td><td><span data-usage-id="${WORK_ID}" hidden></span></td></tr>`
        + "</tbody></table></details>",
      "utf8",
    );

    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    assert.deepEqual(await store.missingPricingTurns(), [{
      provider: "codex",
      threadId: "thread-pricing",
      turnId,
      projectRoot: root,
      startedAt: "2026-07-25T00:00:00.000Z",
    }]);
    assert.deepEqual(await store.synchronizePricingMetadataAndProject({
      items: [{
        provider: "codex",
        threadId: "thread-pricing",
        turnId,
        model: "gpt-5.4",
        serviceTier: "fast",
      }],
      projectRoot: root,
      workLogFile,
    }), {
      updated: 1,
      projected: true,
    });
    const projected = await projectedJournal(store);
    const projectedTurns = await projectedJournalTurns(store);
    assert.match(projected, /Итого<\/span> <span [^>]*data-kilo-usage[^>]*>125 cr<\/span>/);
    assert.match(
      projectedTurns,
      /<div data-work-log-turn-facts><div data-work-log-turn-pricing>gpt-5\.4 · Fast ×2<\/div><div data-work-log-turn-context><strong>Длит\.:<\/strong>/,
    );
    const persisted = await persistedLedger(store);
    assert.equal(
      persisted.turns[`codex\u0000thread-pricing\u0000${turnId}`].pricingMetadataResolved,
      true,
    );
    assert.deepEqual(await store.missingPricingTurns(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store backfills a verified image generation estimate and reprojects credits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-image-estimate-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const turnId = "turn-image";
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 6,
      turns: {
        [`codex\u0000thread-image\u0000${turnId}`]: {
          provider: "codex",
          threadId: "thread-image",
          turnId,
          workLogId: WORK_ID,
          projectRoot: root,
          usageReported: true,
          usage: { inputTokens: 100_000 },
          prompt: "Сгенерируй навыком imagegen фон ночного леса",
          model: "gpt-5.6-sol",
          serviceTier: "default",
          startedAt: "2026-07-25T00:00:00.000Z",
          completedAt: "2026-07-25T00:03:00.000Z",
          title: "Фон создан",
        },
      },
    })}\n`, "utf8");
    await writeFile(
      workLogFile,
      `<details open><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td>Task</td><td>Outcome</td><td><span data-usage-id="${WORK_ID}" hidden></span></td></tr>`
        + "</tbody></table></details>",
      "utf8",
    );

    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    assert.deepEqual(await store.missingImageGenerationEstimateTurns(), [{
      provider: "codex",
      threadId: "thread-image",
      turnId,
      projectRoot: root,
      startedAt: "2026-07-25T00:00:00.000Z",
    }]);
    assert.deepEqual(await store.synchronizeUsageEstimatesAndProject({
      items: [{
        provider: "codex",
        threadId: "thread-image",
        turnId,
        estimatedCredits: 90,
        estimateKind: "imagegen-default",
      }],
      projectRoot: root,
      workLogFile,
    }), {
      updated: 1,
      projected: true,
    });
    const stored = await store.getTurn({ provider: "codex", threadId: "thread-image", turnId });
    assert.equal(stored.estimatedCredits, 90);
    assert.equal(stored.imageGenerationCount, 1);
    const projected = await projectedJournal(store);
    assert.doesNotMatch(projected, /ImageGen:|Оценка:/u);
    assert.deepEqual(await store.missingImageGenerationEstimateTurns(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store restores exact turn texts from deferred notification state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-text-restore-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 1,
      turns: {
        turn: {
          workLogId: WORK_ID,
          usage: { inputTokens: 100 },
          completedAt: "2026-07-25T00:00:00.000Z",
        },
      },
    })}\n`, "utf8");
    const store = new WorkLogUsageStore({ ledgerFile });
    assert.deepEqual(await store.mergeTurnTexts([
      { workLogId: WORK_ID, text: "Точный текст из Telegram" },
      { workLogId: "invalid", text: "Не попадёт" },
    ]), { updated: 1 });
    assert.deepEqual(await store.mergeTurnTexts([
      { workLogId: WORK_ID, text: "Точный текст из Telegram" },
    ]), { updated: 0 });
    const ledger = await persistedLedger(store);
    assert.equal(Object.values(ledger.turns)[0].body, "Точный текст из Telegram");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic usage attaches to the only row for the thread and is idempotent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-automatic-exact-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const completedAt = new Date(2026, 6, 25, 12, 34).toISOString();
    await writeFile(
      workLogFile,
      `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + `<tr><td><a href="vscode://openai.chatgpt/local/thread-1">Task</a></td>`
        + "<td>Outcome</td><td></td></tr></tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({
      ledgerFile,
      randomUUID: () => WORK_ID,
    });
    const input = {
      threadId: "thread-1",
      turnId: "turn-aborted",
      runId: "run-aborted",
      usageReported: true,
      usage: { inputTokens: 1_756_500 },
      completedAt,
      text: "Остановленный ход",
      workLogFile,
    };
    assert.deepEqual(await store.recordAutomaticAndProject(input), {
      recorded: true,
      usage: {
        inputTokens: 1_756_500,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
      },
      workLogId: null,
      target: "thread-day-row",
      projected: true,
    });
    let projected = await projectedJournal(store);
    assert.equal(projected.match(/data-usage-id=/g)?.length ?? 0, 0);
    assert.match(projected, /data-work-log-thread-id="thread-1"/);
    assert.match(projected, /data-work-log-turn-id="turn-aborted"/);
    assert.match(projected, /Остановленный ход/);
    const persisted = await persistedLedger(store);
    assert.equal(persisted.turns["codex\u0000thread-1\u0000turn-aborted"].runId, "run-aborted");
    assert.equal((await store.recordAutomaticAndProject(input)).recorded, false);
    projected = await projectedJournal(store);
    assert.equal(projected.match(/data-usage-id=/g)?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical automatic usage can defer the expensive journal projection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-deferred-projection-"));
  try {
    const store = new WorkLogUsageStore({
      ledgerFile: path.join(root, "work-log-usage.json"),
      defaultProjectRoot: root,
    });
    const result = await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "historical-thread",
      turnId: "historical-turn",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 10 },
      completedAt: "2026-08-20T00:00:00.000Z",
      text: "Historical",
      workLogFile: path.join(root, "WORK_LOG.md"),
      deferProjection: true,
    });

    assert.equal(result.recorded, true);
    assert.equal(result.projected, false);
    assert.equal(result.projectionDeferred, true);
    const ledger = await persistedLedger(store);
    assert.ok(ledger.turns["codex\u0000historical-thread\u0000historical-turn"]);
    assert.doesNotMatch(await projectedJournal(store), /historical-turn/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical deferred usage persists one row without scanning the full ledger", async () => {
  const ledger = {
    version: 9,
    turns: Object.fromEntries(Array.from({ length: 3_000 }, (_, index) => [
      `codex\u0000seed-thread\u0000seed-${index}`,
      {
        provider: "codex",
        threadId: "seed-thread",
        turnId: `seed-${index}`,
        projectRoot: "D:\\workspace",
        status: "completed",
      },
    ])),
  };
  let fullSaves = 0;
  const rowSaves = [];
  const enqueueOptions = [];
  const store = createWorkLogUsageStore({
    defaultProjectRoot: "D:\\workspace",
    repositoryFactory: () => ({
      ledger,
      enqueue: async (operation, options) => {
        enqueueOptions.push(options);
        return operation();
      },
      getRecord: async () => null,
      save: async () => { fullSaves += 1; },
      saveRecord: async (key, record) => { rowSaves.push([key, record.turnId]); },
      payload: async () => ({ html: "", version: "" }),
      replaceProjection: async () => ({ projected: true }),
      close: async () => {},
    }),
  });

  const result = await store.recordAutomaticAndProject({
    provider: "codex",
    threadId: "historical-thread",
    turnId: "historical-turn",
    projectRoot: "D:\\workspace",
    usageReported: true,
    usage: { inputTokens: 10 },
    completedAt: "2026-08-20T00:00:00.000Z",
    status: "completed",
    resolveAccount: false,
    deferProjection: true,
  });

  assert.equal(result.projectionDeferred, true);
  assert.equal(fullSaves, 0);
  assert.deepEqual(enqueueOptions, [{ load: false, pointRead: true }]);
  assert.deepEqual(rowSaves, [[
    "codex\u0000historical-thread\u0000historical-turn",
    "historical-turn",
  ]]);
});

test("deferred point recording skips identical full records but persists body and metadata corrections", async () => {
  let persisted = null;
  let saves = 0;
  let projections = 0;
  const store = createWorkLogUsageStore({
    defaultProjectRoot: "D:\\workspace",
    repositoryFactory: () => ({
      get ledger() { throw new Error("Full ledger access is forbidden"); },
      enqueue: async (operation, options) => {
        assert.equal(options.load, false);
        return operation();
      },
      getRecord: async () => structuredClone(persisted),
      save: async () => { throw new Error("Full save is forbidden"); },
      saveRecord: async (_key, record) => { saves += 1; persisted = structuredClone(record); },
      payload: async () => { throw new Error("Main projection is forbidden"); },
      replaceProjection: async () => { throw new Error("Main projection is forbidden"); },
      close: async () => {},
    }),
    usageSyncStore: {
      events: async () => [],
      projectJournal: async () => { projections += 1; return { projected: true }; },
    },
  });
  const input = {
    provider: "codex", threadId: "thread-point", turnId: "turn-point",
    usageReported: true, usage: { inputTokens: 100 }, model: "gpt-6-astra",
    completedAt: "2026-09-08T10:00:00.000Z", title: "Initial title", body: "Initial answer",
    status: "completed", resolveAccount: false,
  };
  assert.equal((await store.recordAutomaticAndProject({ ...input, deferProjection: true })).projectionDeferred, true);
  const unchanged = await store.recordAutomaticAndProject({ ...input, deferProjection: true });
  assert.equal(unchanged.recorded, false);
  assert.equal(unchanged.projected, false);
  assert.equal(unchanged.projectionDeferred, false);
  assert.equal(saves, 1);
  assert.equal(projections, 0);
  const correction = { ...input, body: "Corrected answer" };
  assert.equal((await store.recordAutomaticAndProject(correction)).projected, true);
  assert.equal(persisted.body, correction.body);
  assert.equal(saves, 2);
  assert.equal(projections, 1);
  const metadata = { ...correction, title: "Corrected title", changedFiles: ["src/changed.mjs"] };
  const deferred = await store.recordAutomaticAndProject({ ...metadata, deferProjection: true });
  assert.equal(deferred.projectionDeferred, true);
  assert.equal(persisted.title, metadata.title);
  assert.deepEqual(persisted.changedFiles, metadata.changedFiles);
  const repeated = await store.recordAutomaticAndProject({ ...metadata, deferProjection: true });
  assert.equal(repeated.projectionDeferred, false);
  assert.equal(saves, 3);
  assert.equal(projections, 1);
  await store.close();
});

test("non-deferred identical retry projects again after the durable record outlives a projection failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-point-projection-retry-"));
  let projections = 0;
  const store = new WorkLogUsageStore({
    ledgerFile: path.join(root, "retired.json"), defaultProjectRoot: root,
    usageSyncStore: {
      events: async () => [],
      projectJournal: async () => {
        projections += 1;
        if (projections === 1) throw new Error("projection unavailable");
        return { projected: true };
      },
    },
  });
  try {
    const input = {
      provider: "codex", threadId: "thread-retry", turnId: "turn-retry",
      completedAt: "2026-09-08T10:00:00.000Z", body: "Durable answer", resolveAccount: false,
    };
    const failed = await store.recordAutomaticAndProject(input);
    assert.equal(failed.recorded, true);
    assert.equal(failed.projected, false);
    assert.equal(failed.projectionError, "projection unavailable");
    const persisted = await store.getTurn(input);
    const retried = await store.recordAutomaticAndProject(input);
    assert.equal(retried.recorded, false);
    assert.equal(retried.projected, true);
    assert.equal(projections, 2);
    assert.deepEqual(await store.getTurn(input), persisted);
    assert.equal(store.diagnostics().retainedRecords, 0);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("provisional retraction missing and non-provisional paths only read exact identities", async () => {
  const reads = [];
  const store = createWorkLogUsageStore({
    repositoryFactory: () => ({
      get ledger() { throw new Error("Full ledger read is forbidden"); },
      enqueue: async (operation, options) => {
        assert.deepEqual(options, { load: false, pointRead: true });
        return operation();
      },
      getRecord: async (identity) => {
        reads.push(identity);
        return identity.turnId === "missing" ? null : { ...identity, provisional: false };
      },
      deleteRecord: async () => { throw new Error("Unexpected delete"); },
      save: async () => { throw new Error("Unexpected full save"); },
      payload: async () => { throw new Error("Unexpected projection read"); },
      replaceProjection: async () => { throw new Error("Unexpected projection"); },
      close: async () => {},
    }),
    usageSyncStore: {
      events: async () => [],
      projectJournal: async () => { throw new Error("Unexpected worker projection"); },
    },
  });
  for (const turnId of ["missing", "final"]) {
    assert.deepEqual(await store.retractProvisionalAndProject({ provider: "codex", threadId: "thread-1", turnId }), {
      retracted: false, projected: false,
    });
  }
  assert.deepEqual(reads.map((identity) => identity.turnId), ["missing", "final"]);
  await store.close();
});

test("same-id provisional retractions delete once and project after the repository lock is released", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-exact-retraction-"));
  const databaseFile = path.join(root, "journal.sqlite");
  class PointOnlyJournal extends JournalDatabase {
    async loadLedger() { throw new Error("Full ledger load is forbidden"); }
  }
  const journal = new PointOnlyJournal(databaseFile);
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  let projections = 0;
  let failProjection = false;
  let first;
  const usageSyncStore = {
    events: async () => [],
    projectJournal: async () => {
      projections += 1;
      assert.equal(await first.getTurn(identity), null);
      if (failProjection) throw new Error("projection unavailable");
      return { projected: true };
    },
  };
  const options = { ledgerFile: path.join(root, "retired.json"), databaseFile, journalDatabase: journal, usageSyncStore };
  first = new WorkLogUsageStore(options);
  const second = new WorkLogUsageStore(options);
  try {
    await journal.upsertRecords([
      { ...identity, provisional: true, body: "Provisional" },
      { ...identity, threadId: "other-thread", provisional: true, body: "Keep other identity" },
    ]);
    const results = await Promise.all([
      first.retractProvisionalAndProject(identity), second.retractProvisionalAndProject(identity),
    ]);
    assert.equal(results.filter((result) => result.retracted).length, 1);
    assert.equal(results.filter((result) => result.projected).length, 1);
    assert.equal(projections, 1);
    assert.ok(await journal.getRecord({ ...identity, threadId: "other-thread" }));
    assert.equal(first.diagnostics().retainedRecords, 0);
    assert.equal(second.diagnostics().retainedRecords, 0);
    await journal.upsertRecords([{ ...identity, provisional: true, body: "Another provisional" }]);
    failProjection = true;
    assert.deepEqual(await first.retractProvisionalAndProject(identity), {
      retracted: true, projected: false, projectionError: "projection unavailable",
    });
    assert.equal(await journal.getRecord(identity), null);
  } finally {
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("exact repository deletion invalidates retained ledger and fingerprints without resurrecting a deleted turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-delete-cache-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const repository = new WorkLogUsageRepository({
    ledgerFile: path.join(root, "retired.json"), databaseFile, journalDatabase: journal,
    normalizePersisted: (value) => normalizePersistedWorkLog(value, { defaultProjectRoot: root }),
  });
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  try {
    await journal.upsertRecords([
      incomingLedgerRecord({ ...identity, projectRoot: root, provisional: true }),
      incomingLedgerRecord({ ...identity, turnId: "keep", projectRoot: root }),
    ]);
    await repository.enqueue(() => assert.equal(Object.keys(repository.ledger.turns).length, 2));
    const deleted = await repository.enqueue(() => repository.deleteRecord(identity), { load: false, pointRead: true });
    assert.equal(deleted.deleted, 1);
    assert.deepEqual(repository.diagnostics(), { loaded: false, retainedRecords: 0, loadedRevision: deleted.revision });
    await repository.enqueue(async () => {
      assert.deepEqual(Object.keys(repository.ledger.turns), ["codex\0thread-1\0keep"]);
      await repository.save();
    });
    assert.equal(await journal.getRecord(identity), null);
    assert.ok(await journal.getRecord({ ...identity, turnId: "keep" }));
  } finally {
    await repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic single-turn records resolve an exact account key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-account-key-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
      resolveAccount: async () => ({
        account: { type: "chatgpt", email: "Private@Example.Test", planType: "pro" },
      }),
    });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-account",
      turnId: "turn-account",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 10 },
      completedAt: "2026-08-20T00:00:00.000Z",
      text: "Accounted",
      workLogFile: path.join(root, "WORK_LOG.md"),
    });
    const record = (await persistedLedger(store)).turns["codex\u0000thread-account\u0000turn-account"];
    const expected = createHash("sha256").update("private@example.test").digest("hex");
    assert.equal(record.accountKey, `chatgpt:${expected}`);
    assert.equal(record.accountAttribution, "exact");
    assert.equal(record.accountLabel, "Private@Example.Test");
    assert.equal(record.accountType, "chatgpt");
    assert.equal(record.accountPlan, "pro");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent automatic records resolve account before the journal mutation lane", async () => {
  const records = new Map();
  let lane = Promise.resolve();
  let laneActive = false;
  let enqueueCalls = 0;
  let resolverCalls = 0;
  let releaseAccount;
  const accountGate = new Promise((resolve) => { releaseAccount = resolve; });
  const repository = {
    ledger: { version: 9, turns: {} },
    enqueue(operation) {
      enqueueCalls += 1;
      const queued = lane.catch(() => {}).then(async () => {
        laneActive = true;
        try {
          return await operation();
        } finally {
          laneActive = false;
        }
      });
      lane = queued;
      return queued;
    },
    async getRecord(identity) {
      return records.get(workLogTurnKey(identity)) ?? null;
    },
    async saveRecord(key, record) {
      records.set(key, record);
      return { revision: records.size };
    },
    async save() {},
    async payload() { return { html: "", version: "" }; },
    async replaceProjection() { return { projected: true }; },
    async close() {},
  };
  const store = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    resolveAccount: async () => {
      resolverCalls += 1;
      assert.equal(laneActive, false, "provider account RPC must not hold the journal mutation lane");
      await accountGate;
      return { account: { type: "chatgpt", email: "owner@example.test", planType: "pro" } };
    },
  });
  const writes = ["one", "two", "three"].map((turnId) => store.recordAutomaticAndProject({
    provider: "codex", threadId: "thread", turnId, projectRoot: process.cwd(),
    completedAt: "2026-09-21T00:00:00.000Z", status: "completed", body: turnId,
    deferProjection: true,
  }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolverCalls, 1);
  assert.equal(enqueueCalls, 0);
  releaseAccount();
  await Promise.all(writes);
  assert.equal(records.size, 3);
  assert.equal(resolverCalls, 1);
});

test("automatic account resolution is provider-scoped and refreshes after settlement", async () => {
  const records = new Map();
  const resolverCalls = { codex: 0, claude: 0 };
  const repository = {
    ledger: { version: 9, turns: {} },
    enqueue: async (operation) => operation(),
    async getRecord(identity) { return records.get(workLogTurnKey(identity)) ?? null; },
    async saveRecord(key, record) { records.set(key, record); },
    async save() {},
    async payload() { return { html: "", version: "" }; },
    async replaceProjection() { return { projected: true }; },
    async close() {},
  };
  const store = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    resolveAccount: async (provider) => {
      resolverCalls[provider] += 1;
      const suffix = resolverCalls[provider];
      if (provider === "codex") {
        return { account: { type: "chatgpt", email: `codex-${suffix}@example.test`, planType: "pro" } };
      }
      return { key: `anthropic:claude-${suffix}`, label: `claude-${suffix}@example.test`, type: "oauth" };
    },
  });
  const record = (provider, turnId) => store.recordAutomaticAndProject({
    provider, threadId: `${provider}-thread`, turnId, projectRoot: process.cwd(),
    completedAt: "2026-09-21T00:00:00.000Z", status: "completed", body: turnId,
    deferProjection: true,
  });

  await Promise.all([
    record("codex", "codex-1"),
    record("codex", "codex-2"),
    record("claude", "claude-1"),
    record("claude", "claude-2"),
  ]);
  assert.deepEqual(resolverCalls, { codex: 1, claude: 1 });
  assert.equal(records.get("codex\0codex-thread\0codex-1").accountLabel, "codex-1@example.test");
  assert.equal(records.get("codex\0codex-thread\0codex-2").accountLabel, "codex-1@example.test");
  assert.equal(records.get("claude\0claude-thread\0claude-1").accountKey, "anthropic:claude-1");
  assert.equal(records.get("claude\0claude-thread\0claude-2").accountKey, "anthropic:claude-1");

  await record("codex", "codex-3");
  assert.deepEqual(resolverCalls, { codex: 2, claude: 1 });
  assert.equal(records.get("codex\0codex-thread\0codex-3").accountLabel, "codex-2@example.test");
});

test("failed automatic account resolution stays unattributed and retries fresh", async () => {
  const records = new Map();
  const warnings = [];
  let resolverCalls = 0;
  const repository = {
    ledger: { version: 9, turns: {} },
    enqueue: async (operation) => operation(),
    async getRecord(identity) { return records.get(workLogTurnKey(identity)) ?? null; },
    async saveRecord(key, record) { records.set(key, record); },
    async save() {},
    async payload() { return { html: "", version: "" }; },
    async replaceProjection() { return { projected: true }; },
    async close() {},
  };
  const store = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    logger: { warn: (message) => warnings.push(message) },
    resolveAccount: async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) throw new Error("account read timed out");
      return { account: { type: "chatgpt", email: "recovered@example.test", planType: "pro" } };
    },
  });
  const record = (turnId) => store.recordAutomaticAndProject({
    provider: "codex", threadId: "thread", turnId, projectRoot: process.cwd(),
    completedAt: "2026-09-21T00:00:00.000Z", status: "completed", body: turnId,
    deferProjection: true,
  });

  await record("failed");
  await record("retried");
  assert.equal(resolverCalls, 2);
  assert.equal(records.get("codex\0thread\0failed").accountKey, "");
  assert.equal(records.get("codex\0thread\0retried").accountLabel, "recovered@example.test");
  assert.deepEqual(warnings, [
    "Cannot identify codex account for journal record: account read timed out",
  ]);
});

test("replacing the account resolver invalidates in-flight sharing for later terminals", async () => {
  const records = new Map();
  let releaseOld;
  const oldGate = new Promise((resolve) => { releaseOld = resolve; });
  const repository = {
    ledger: { version: 9, turns: {} },
    enqueue: async (operation) => operation(),
    async getRecord(identity) { return records.get(workLogTurnKey(identity)) ?? null; },
    async saveRecord(key, record) { records.set(key, record); },
    async save() {},
    async payload() { return { html: "", version: "" }; },
    async replaceProjection() { return { projected: true }; },
    async close() {},
  };
  const store = createWorkLogUsageStore({
    repositoryFactory: () => repository,
    resolveAccount: async () => {
      await oldGate;
      return { account: { type: "chatgpt", email: "old@example.test", planType: "pro" } };
    },
  });
  const record = (turnId) => store.recordAutomaticAndProject({
    provider: "codex", threadId: "thread", turnId, projectRoot: process.cwd(),
    completedAt: "2026-09-21T00:00:00.000Z", status: "completed", body: turnId,
    deferProjection: true,
  });

  const oldTerminal = record("old");
  await new Promise((resolve) => setImmediate(resolve));
  store.setResolveAccount(async () => ({
    account: { type: "chatgpt", email: "new@example.test", planType: "pro" },
  }));
  await record("new");
  releaseOld();
  await oldTerminal;

  assert.equal(records.get("codex\0thread\0old").accountLabel, "old@example.test");
  assert.equal(records.get("codex\0thread\0new").accountLabel, "new@example.test");
});

test("usage sync snapshot publishes device-owned auth observations for current runtime homes", async () => {
  const importedSnapshots = [];
  const store = createWorkLogUsageStore({
    repositoryFactory: () => ({
      ledger: { version: 9, turns: {} },
      enqueue: async (operation) => operation(),
      save: async () => {},
      payload: async () => ({ html: "", version: "" }),
      replaceProjection: async () => ({ projected: true }),
      close: async () => {},
    }),
    resolveAccount: async (provider) => {
      if (provider === "codex") {
        return {
          account: {
            type: "chatgpt",
            email: "Stage2@Example.Test",
            planType: "pro",
            accessToken: "must-not-cross",
          },
        };
      }
      if (provider === "claude") {
        return {
          key: "anthropic:account-1",
          label: "claude@example.test",
          type: "oauth",
          planType: "max:subscription",
          refreshToken: "must-not-cross",
        };
      }
      return null;
    },
    usageSyncStore: {
      events: async () => [],
      importSnapshot: async (snapshot) => {
        importedSnapshots.push(snapshot);
        return { added: snapshot.events.length, updated: 0 };
      },
      usageSyncSnapshot: async (options) => ({
        version: 1,
        deviceId: options.deviceId,
        events: [],
      }),
    },
    usageSyncDeviceId: USG001_DEVICE_ID,
    usageSyncDeviceLabel: "stage2-device",
    usageSyncRuntimeHomeIds: {
      codex: USG001_RUNTIME_HOME_ID,
      claude: USG001_OTHER_RUNTIME_HOME_ID,
    },
    usageSyncIdentity: {
      installationInstanceId: USG001_INSTALLATION_ID,
      authFingerprint: ({ accountKey, accountPlan }) => `fp:${accountKey}:${accountPlan}`,
    },
  });

  await Promise.all(Array.from({ length: 3 }, () => store.usageSyncSnapshot({
    deviceId: USG001_DEVICE_ID, deviceLabel: "stage2-device",
  })));

  assert.equal(importedSnapshots.length, 1);
  const facts = importedSnapshots[0].events;
  assert.deepEqual(facts.map((fact) => fact.type), ["auth_observation", "auth_observation"]);
  assert.deepEqual(facts.map((fact) => fact.provider), ["codex", "claude"]);
  assert.equal(facts[0].deviceId, USG001_DEVICE_ID);
  assert.equal(facts[0].installationInstanceId, USG001_INSTALLATION_ID);
  assert.equal(facts[0].runtimeHomeId, USG001_RUNTIME_HOME_ID);
  assert.equal(facts[0].accountLabel, "Stage2@Example.Test");
  assert.equal(facts[0].accountType, "chatgpt");
  assert.equal(facts[0].accountPlan, "pro");
  assert.equal(facts[0].evidenceSource, "account-read");
  assert.equal(facts[0].authFingerprint, `fp:${facts[0].accountKey}:pro`);
  assert.equal(facts[1].runtimeHomeId, USG001_OTHER_RUNTIME_HOME_ID);
  assert.equal(facts[1].accountKey, "anthropic:account-1");
  assert.equal(facts[1].evidenceSource, "account-read");
  assert.equal(JSON.stringify(importedSnapshots), JSON.stringify(importedSnapshots).replace(/must-not-cross/gu, ""));
});

test("usage sync snapshot retries auth observation publication after import failure", async () => {
  const importedSnapshots = [];
  let attempts = 0;
  const store = createWorkLogUsageStore({
    repositoryFactory: () => ({
      ledger: { version: 9, turns: {} },
      enqueue: async (operation) => operation(),
      save: async () => {},
      payload: async () => ({ html: "", version: "" }),
      replaceProjection: async () => ({ projected: true }),
      close: async () => {},
    }),
    resolveAccount: async (provider) => {
      if (provider !== "codex") return null;
      return {
        account: {
          type: "chatgpt",
          email: "stage2@example.test",
          planType: "pro",
        },
      };
    },
    usageSyncStore: {
      events: async () => [],
      importSnapshot: async (snapshot) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient sqlite failure");
        importedSnapshots.push(snapshot);
        return { added: snapshot.events.length, updated: 0 };
      },
      usageSyncSnapshot: async (options) => ({
        version: 1,
        deviceId: options.deviceId,
        events: [],
      }),
    },
    usageSyncDeviceId: USG001_DEVICE_ID,
    usageSyncDeviceLabel: "stage2-device",
    usageSyncRuntimeHomeIds: {
      codex: USG001_RUNTIME_HOME_ID,
    },
    usageSyncIdentity: {
      installationInstanceId: USG001_INSTALLATION_ID,
      authFingerprint: ({ accountKey, accountPlan }) => `fp:${accountKey}:${accountPlan}`,
    },
  });

  await assert.rejects(
    store.usageSyncSnapshot({ deviceId: USG001_DEVICE_ID, deviceLabel: "stage2-device" }),
    /transient sqlite failure/u,
  );
  await store.usageSyncSnapshot({ deviceId: USG001_DEVICE_ID, deviceLabel: "stage2-device" });

  assert.equal(attempts, 2);
  assert.equal(importedSnapshots.length, 1);
  assert.equal(importedSnapshots[0].events.length, 1);
  assert.equal(importedSnapshots[0].events[0].provider, "codex");
  assert.match(importedSnapshots[0].events[0].accountKey, /^chatgpt:[0-9a-f]{64}$/u);
  assert.equal(importedSnapshots[0].events[0].accountLabel, "stage2@example.test");
  assert.equal(importedSnapshots[0].events[0].evidenceSource, "account-read");
});

test("usage sync snapshot publishes account transitions without repeating unchanged state", async () => {
  const importedSnapshots = [];
  const accounts = ["A", "A", "B", "A"];
  let index = 0;
  const store = createWorkLogUsageStore({
    repositoryFactory: () => ({
      ledger: { version: 9, turns: {} },
      enqueue: async (operation) => operation(),
      save: async () => {},
      payload: async () => ({ html: "", version: "" }),
      replaceProjection: async () => ({ projected: true }),
      close: async () => {},
    }),
    resolveAccount: async (provider) => {
      if (provider !== "codex") return null;
      const account = accounts[index++];
      return {
        account: {
          type: "chatgpt",
          email: `${account}@example.test`,
          planType: "pro",
        },
      };
    },
    usageSyncStore: {
      events: async () => [],
      importSnapshot: async (snapshot) => {
        importedSnapshots.push(snapshot);
        return { added: snapshot.events.length, updated: 0 };
      },
      usageSyncSnapshot: async (options) => ({
        version: 1,
        deviceId: options.deviceId,
        events: [],
      }),
    },
    usageSyncDeviceId: USG001_DEVICE_ID,
    usageSyncRuntimeHomeIds: {
      codex: USG001_RUNTIME_HOME_ID,
    },
    usageSyncIdentity: {
      installationInstanceId: USG001_INSTALLATION_ID,
      authFingerprint: ({ accountKey, accountPlan }) => `fp:${accountKey}:${accountPlan}`,
    },
  });

  for (let count = 0; count < accounts.length; count += 1) {
    await store.usageSyncSnapshot({ deviceId: USG001_DEVICE_ID, deviceLabel: "stage2-device" });
  }

  const published = importedSnapshots.flatMap((snapshot) => snapshot.events);
  assert.deepEqual(published.map((fact) => fact.accountLabel), [
    "A@example.test",
    "B@example.test",
    "A@example.test",
  ]);
});

test("usage sync auth observation timestamps are strictly monotonic", async () => {
  const RealDate = Date;
  const importedSnapshots = [];
  try {
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        return args.length ? new RealDate(...args) : new RealDate("2026-09-03T10:00:00.000Z");
      }

      static now() {
        return new RealDate("2026-09-03T10:00:00.000Z").getTime();
      }

      static parse(value) {
        return RealDate.parse(value);
      }

      static UTC(...args) {
        return RealDate.UTC(...args);
      }
    };
    const accounts = ["A", "B"];
    let index = 0;
    const store = createWorkLogUsageStore({
      repositoryFactory: () => ({
        ledger: { version: 9, turns: {} },
        enqueue: async (operation) => operation(),
        save: async () => {},
        payload: async () => ({ html: "", version: "" }),
        replaceProjection: async () => ({ projected: true }),
        close: async () => {},
      }),
      resolveAccount: async (provider) => {
        if (provider !== "codex") return null;
        const account = accounts[index++];
        return { account: { type: "chatgpt", email: `${account}@example.test`, planType: "pro" } };
      },
      usageSyncStore: {
        events: async () => [],
        importSnapshot: async (snapshot) => {
          importedSnapshots.push(snapshot);
          return { added: snapshot.events.length, updated: 0 };
        },
        usageSyncSnapshot: async () => ({ version: 1, events: [] }),
      },
      usageSyncDeviceId: USG001_DEVICE_ID,
      usageSyncRuntimeHomeIds: {
        codex: USG001_RUNTIME_HOME_ID,
      },
      usageSyncIdentity: {
        installationInstanceId: USG001_INSTALLATION_ID,
        authFingerprint: ({ accountKey, accountPlan }) => `fp:${accountKey}:${accountPlan}`,
      },
    });

    await store.usageSyncSnapshot({ deviceId: USG001_DEVICE_ID });
    await store.usageSyncSnapshot({ deviceId: USG001_DEVICE_ID });
  } finally {
    globalThis.Date = RealDate;
  }

  const observed = importedSnapshots.flatMap((snapshot) => snapshot.events.map((fact) => fact.observedAt));
  assert.equal(observed.length, 2);
  assert.ok(Date.parse(observed[1]) > Date.parse(observed[0]));
});

test("automatic batch does not infer historical turns from the current account", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-account-batch-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    let resolved = 0;
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
      resolveAccount: async () => {
        resolved += 1;
        return { key: "codex:current" };
      },
    });
    await store.recordAutomaticBatchAndProject({
      records: [{
        provider: "codex",
        threadId: "thread-old",
        turnId: "turn-old",
        projectRoot: root,
        usageReported: true,
        usage: { inputTokens: 10 },
        completedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
      }],
      projectRoot: root,
      workLogFile: path.join(root, "WORK_LOG.md"),
    });
    const record = (await persistedLedger(store)).turns["codex\u0000thread-old\u0000turn-old"];
    assert.equal(resolved, 0);
    assert.equal(record.accountKey, "");
    assert.equal(record.accountAttribution, "inferred");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic batch records many historical turns and projects once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-automatic-batch-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const records = ["first", "second"].map((turnId, index) => ({
      provider: "claude",
      threadId: "claude-session",
      turnId,
      projectRoot: root,
      taskTitle: "Claude Work",
      title: `Ход ${index + 1}`,
      body: `Ответ ${index + 1}`,
      prompt: `Запрос ${index + 1}`,
      usageReported: true,
      usage: { inputTokens: 100 + index },
      startedAt: `2026-07-27T0${index}:00:00.000Z`,
      completedAt: `2026-07-27T0${index}:01:00.000Z`,
      status: "completed",
    }));

    assert.deepEqual(await store.recordAutomaticBatchAndProject({
      records,
      projectRoot: root,
      workLogFile,
    }), {
      recorded: 2,
      updated: 0,
      projected: true,
    });
    assert.deepEqual(await store.recordAutomaticBatchAndProject({
      records,
      projectRoot: root,
      workLogFile,
    }), {
      recorded: 0,
      updated: 0,
      projected: false,
      reason: "unchanged",
    });
    const ledger = await persistedLedger(store);
    assert.equal(Object.keys(ledger.turns).length, 2);
    const projected = await projectedJournal(store);
    const projectedTurns = await projectedJournalTurns(store);
    assert.match(projected, /Ход 1/u);
    assert.match(projected, /Ход 2/u);
    assert.match(projectedTurns, /Ответ 1/u);
    assert.match(projectedTurns, /Ответ 2/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage projection ignores the legacy WORK_LOG path and uses SQLite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-manual-edit-race-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await mkdir(path.dirname(ledgerFile), { recursive: true });
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");
    let edited = false;
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
      beforeProjectionWrite: async () => {
        if (edited) return;
        edited = true;
        await writeFile(workLogFile, "Ручная заметка\n", "utf8");
      },
    });

    await store.recordAutomaticAndProject({
      threadId: "thread-manual",
      turnId: "turn-manual",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Автоматический ход",
      workLogFile,
    });

    const projected = await projectedJournal(store);
    assert.equal(edited, true);
    assert.doesNotMatch(projected, /Ручная заметка/u);
    assert.match(projected, /Автоматический ход/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic SQLite ledger survives a projection failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-durable-"));
  try {
    const ledgerFile = path.join(root, "data", "work-log-usage.json");
    const store = new WorkLogUsageStore({
      ledgerFile,
      defaultProjectRoot: root,
      beforeProjectionWrite: async () => {
        throw new Error("projection unavailable");
      },
    });
    const result = await store.recordAutomaticAndProject({
      threadId: "thread-durable",
      turnId: "turn-durable",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Сохранено до проекции",
      workLogFile: path.join(root, "ignored.md"),
    });
    assert.equal(result.recorded, true);
    assert.equal(result.projected, false);
    assert.match(result.projectionError, /projection unavailable/i);
    const ledger = await persistedLedger(store);
    assert.equal(Object.keys(ledger.turns).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task title synchronization updates existing ledger turns and the projected journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-task-title-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await store.recordAutomaticAndProject({
      threadId: "thread-title",
      turnId: "turn-title",
      projectRoot: root,
      taskTitle: "Agent Hub",
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Готово",
      workLogFile,
    });

    const result = await store.synchronizeTaskTitlesAndProject({
      titles: [{ provider: "codex", threadId: "thread-title", taskTitle: "Agent HUB" }],
      projectRoot: root,
      workLogFile,
    });

    assert.equal(result.updated, 1);
    assert.equal(result.projected, true);
    const ledger = await persistedLedger(store);
    assert.equal(Object.values(ledger.turns)[0].taskTitle, "Agent HUB");
    const projected = await projectedJournal(store);
    assert.match(
      projected,
      /<button type="button" data-open-task data-provider="codex" data-thread-id="thread-title">Codex - Agent HUB<\/button>/,
    );
    assert.doesNotMatch(projected, />Codex - Agent Hub<\/a>/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a late unknown Stop result cannot overwrite an exact terminal status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-status-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const input = {
      threadId: "thread-status",
      turnId: "turn-status",
      projectRoot: root,
      usageReported: false,
      usage: {},
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Статус",
      workLogFile,
    };
    await store.recordAutomaticAndProject({ ...input, status: "aborted" });
    await store.recordAutomaticAndProject({ ...input, status: "unknown" });
    const ledger = await persistedLedger(store);
    assert.equal(Object.values(ledger.turns)[0].status, "aborted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy synthetic interruptions are provisional and retract from the projected journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-provisional-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 4,
      turns: {
        "codex\u0000thread-live\u0000turn-live": {
          provider: "codex",
          threadId: "thread-live",
          turnId: "turn-live",
          projectRoot: root,
          taskTitle: "Живая задача",
          title: "Ход остановлен пользователем",
          body: "Ход остановлен пользователем.",
          status: "aborted",
          completedAt: "2026-07-27T04:00:00.000Z",
          usageReported: false,
        },
      },
    }, null, 2)}\n`, "utf8");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    assert.equal((await store.getTurn({
      provider: "codex",
      threadId: "thread-live",
      turnId: "turn-live",
    })).provisional, true);

    const result = await store.retractProvisionalAndProject({
      provider: "codex",
      threadId: "thread-live",
      turnId: "turn-live",
      projectRoot: root,
      workLogFile,
    });

    assert.equal(result.retracted, true);
    const ledger = await persistedLedger(store);
    assert.equal(ledger.version, 9);
    assert.deepEqual(ledger.turns, {});
    assert.doesNotMatch(await projectedJournal(store), /Живая задача/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrated SQLite point reads stay bounded and retain no ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-point-read-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const seed = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await seed.recordAutomaticAndProject({
      threadId: "thread-point",
      turnId: "turn-point",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 10 },
      completedAt: "2026-07-27T05:00:00.000Z",
      text: "Точечное чтение",
      workLogFile,
    });
    await seed.close();

    const reader = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const turn = await reader.getTurn({
      provider: "codex",
      threadId: "thread-point",
      turnId: "turn-point",
    });

    assert.equal(turn.turnId, "turn-point");
    assert.equal(reader.diagnostics().loaded, false);
    assert.equal(reader.diagnostics().retainedRecords, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("thread point reads preserve legacy-first normalization without retaining the ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-thread-read-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const legacyTurn = (turnId, completedAt) => ({
      provider: "codex",
      threadId: "thread-legacy",
      turnId,
      projectRoot: root,
      taskTitle: "Legacy thread",
      title: "Ход остановлен пользователем",
      body: "Ход остановлен пользователем.",
      status: "aborted",
      completedAt,
      usageReported: false,
    });
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 4,
      turns: {
        "codex\u0000thread-legacy\u0000turn-1": legacyTurn(
          "turn-1",
          "2026-07-27T04:00:00.000Z",
        ),
        "codex\u0000thread-legacy\u0000turn-2": legacyTurn(
          "turn-2",
          "2026-07-27T04:01:00.000Z",
        ),
      },
    }, null, 2)}\n`, "utf8");

    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const turns = await store.threadTurns([{ provider: "codex", threadId: "thread-legacy" }]);

    assert.deepEqual(turns.map((turn) => turn.turnId).sort(), ["turn-1", "turn-2"]);
    assert.equal(turns.every((turn) => turn.provisional === true), true);
    assert.equal(store.diagnostics().loaded, false);
    assert.equal(store.diagnostics().retainedRecords, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy empty auto-compaction subagent turns are removed from the ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-auto-compact-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    await writeFile(ledgerFile, `${JSON.stringify({
      version: 8,
      turns: {
        "codex\u0000child-thread\u0000auto-compact-0": {
          provider: "codex",
          threadId: "child-thread",
          taskThreadId: "root-thread",
          parentThreadId: "root-thread",
          aggregateOnly: true,
          turnId: "auto-compact-0",
          projectRoot: root,
          title: "Ход отменён",
          status: "aborted",
          usageReported: false,
          usage: {},
          model: "codex-auto-review",
          startedAt: "2026-07-14T12:00:00.000Z",
          completedAt: "2026-07-14T12:00:00.000Z",
        },
      },
    }, null, 2)}\n`, "utf8");
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    assert.deepEqual((await persistedLedger(store)).turns, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store recovers a damaged primary ledger from its backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-recovery-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const seed = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await seed.recordAutomaticAndProject({
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Восстановлено",
      workLogFile,
    });
    await writeFile(ledgerFile, "{damaged", "utf8");
    const recovered = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await recovered.project(workLogFile, { projectRoot: root });
    const ledger = await persistedLedger(recovered);
    assert.equal(Object.keys(ledger.turns).length, 1);
    assert.equal(ledger.version, 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("usage store verifies, archives and removes retired legacy journal files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-retire-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const backupRoot = path.join(root, "migrations");
    const record = {
      provider: "codex",
      threadId: "thread-retired",
      taskThreadId: "thread-retired",
      turnId: "turn-retired",
      projectRoot: root,
      completedAt: "2026-08-02T00:00:00.000Z",
      taskTitle: "SQLite cutover",
    };
    const ledger = {
      version: 8,
      turns: {
        [workLogTurnKey(record)]: record,
      },
    };
    const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
    await writeFile(ledgerFile, ledgerText, "utf8");
    await writeFile(`${ledgerFile}.bak`, ledgerText, "utf8");
    await writeFile(`${ledgerFile}.delta.jsonl`, "", "utf8");
    await writeFile(`${ledgerFile}.invalid-records.json`, "{}\n", "utf8");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");

    const store = new WorkLogUsageStore({ ledgerFile });
    const result = await store.retireLegacyStorage({
      workLogFile,
      backupRoot,
      now: new Date("2026-08-02T12:34:56.789Z"),
    });

    assert.equal(result.retired, true);
    assert.equal(result.verification.verified, true);
    assert.equal(
      result.backupDirectory,
      path.join(backupRoot, "sqlite-cutover-2026-08-02T12-34-56-789Z"),
    );
    assert.equal(result.archived.length, 5);
    for (const source of [
      ledgerFile,
      `${ledgerFile}.bak`,
      `${ledgerFile}.delta.jsonl`,
      `${ledgerFile}.invalid-records.json`,
      workLogFile,
    ]) {
      await assert.rejects(readFile(source, "utf8"), { code: "ENOENT" });
      const archived = result.archived.find((item) => item.source === source);
      assert.ok(archived);
      assert.equal(typeof await readFile(archived.backupFile, "utf8"), "string");
    }
    const persisted = await persistedLedger(store);
    assert.equal(Object.keys(persisted.turns).length, 1);
    assert.equal(Object.values(persisted.turns)[0].turnId, "turn-retired");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent read-only recovery instances serialize their repair checkpoint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-read-recovery-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const seed = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await seed.recordAutomaticAndProject({
      threadId: "thread-recovery",
      turnId: "turn-recovery",
      projectRoot: root,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      text: "Восстановлено чтением",
      workLogFile,
    });
    await writeFile(ledgerFile, "{damaged", "utf8");
    const first = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const second = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    const [turn, history] = await Promise.all([
      first.getTurn({ provider: "codex", threadId: "thread-recovery", turnId: "turn-recovery" }),
      second.usageHistory(),
    ]);
    assert.equal(turn.turnId, "turn-recovery");
    assert.equal(typeof history.totalCredits, "number");
    assert.equal((await persistedLedger(first)).version, 9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite projection can select one requested project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-projects-"));
  try {
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const firstLog = path.join(firstRoot, "WORK_LOG.md");
    const secondLog = path.join(secondRoot, "WORK_LOG.md");
    const ledgerFile = path.join(root, "work-log-usage.json");
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: firstRoot });
    await store.recordAutomaticAndProject({
      threadId: "thread-first",
      turnId: "turn-first",
      projectRoot: firstRoot,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      taskTitle: "Первая задача",
      text: "Первый проект",
      workLogFile: firstLog,
    });
    await store.recordAutomaticAndProject({
      threadId: "thread-second",
      turnId: "turn-second",
      projectRoot: secondRoot,
      usageReported: true,
      usage: { inputTokens: 200 },
      completedAt: "2026-07-27T00:01:00.000Z",
      taskTitle: "Вторая задача",
      text: "Второй проект",
      workLogFile: secondLog,
    });
    await store.project(null, { projectRoot: firstRoot });
    const first = await projectedJournal(store);
    await store.project(null, { projectRoot: secondRoot });
    const second = await projectedJournal(store);
    assert.match(first, /Первый проект/);
    assert.doesNotMatch(first, /Второй проект/);
    assert.match(second, /Второй проект/);
    assert.doesNotMatch(second, /Первый проект/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one ledger can project all configured projects into one global journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-global-projects-"));
  try {
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const globalLog = path.join(root, "WORK_LOG.md");
    const ledgerFile = path.join(root, "work-log-usage.json");
    const projectionProjectRoots = [firstRoot, secondRoot];
    const store = new WorkLogUsageStore({ ledgerFile, defaultProjectRoot: root });
    await store.recordAutomaticAndProject({
      threadId: "thread-first",
      turnId: "turn-first",
      projectRoot: firstRoot,
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt: "2026-07-27T00:00:00.000Z",
      taskTitle: "Первая задача",
      text: "Первый проект",
      workLogFile: globalLog,
      projectionProjectRoots,
    });
    await store.recordAutomaticAndProject({
      threadId: "thread-second",
      turnId: "turn-second",
      projectRoot: secondRoot,
      usageReported: true,
      usage: { inputTokens: 200 },
      completedAt: "2026-07-27T00:01:00.000Z",
      taskTitle: "Вторая задача",
      text: "Второй проект",
      workLogFile: globalLog,
      projectionProjectRoots,
    });

    const global = await projectedJournal(store);
    assert.match(global, /Первый проект/);
    assert.match(global, /Второй проект/);
    assert.equal((global.match(/data-work-log-turn-entry/gu) ?? []).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic usage creates an explicit fallback row for an ambiguous thread", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-automatic-fallback-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    const completedAt = new Date(2026, 6, 25, 13, 45).toISOString();
    const linkedRow = (title) => (
      `<tr><td><a href="vscode://openai.chatgpt/local/thread-1">${title}</a></td>`
      + "<td>Outcome</td><td></td></tr>"
    );
    await writeFile(
      workLogFile,
      `<details><summary><strong>25.07.2026</strong></summary><table><tbody>`
        + linkedRow("Task A") + linkedRow("Task B")
        + "</tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({
      ledgerFile,
      randomUUID: () => SECOND_WORK_ID,
    });
    const result = await store.recordAutomaticAndProject({
      threadId: "thread-1",
      turnId: "turn-aborted",
      usageReported: true,
      usage: { inputTokens: 100 },
      completedAt,
      text: "Автоматически учтённый ход",
      workLogFile,
    });
    assert.equal(result.target, "thread-day-row");
    const projected = await projectedJournal(store);
    assert.match(projected, /data-work-log-thread-id="thread-1"/);
    assert.match(projected, /Codex - Без названия/);
    assert.doesNotMatch(projected, /data-usage-id=/);
    assert.match(projected, /data-task-usage><span data-usage-label>Итого<\/span> <span [^>]*data-kilo-usage[^>]*>0,0 cr<\/span> <span data-usage-percent>\(100%\)<\/span>/);
    assert.match(projected, /13:45 — <span data-kilo-usage[^>]*>0,0 cr<\/span>/);
    assert.match(projected, /Автоматически учтённый ход/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic journal records a stopped turn even when usage is unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-no-usage-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      "<details open><summary><strong>25.07.2026</strong></summary><table><tbody></tbody></table></details>",
      "utf8",
    );
    const store = new WorkLogUsageStore({ ledgerFile });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-stopped",
      turnId: "turn-stopped",
      taskTitle: "Остановленная задача",
      status: "aborted",
      title: "Ход остановлен",
      body: "Промежуточный результат сохранён.",
      prompt: "Сделай работу",
      changedFiles: ["src/stopped.mjs"],
      diff: "diff --git a/src/stopped.mjs b/src/stopped.mjs\n+const stopped = true;",
      startedAt: new Date(2026, 6, 25, 12, 0).toISOString(),
      completedAt: new Date(2026, 6, 25, 12, 1).toISOString(),
      usageReported: false,
      workLogFile,
    });
    const projected = await projectedJournal(store);
    const projectedTurns = await projectedJournalTurns(store);
    assert.match(projected, /Codex - Остановленная задача/);
    assert.match(projected, /12:01 — нет данных/);
    assert.match(projected, /data-work-log-turn-title>Ход остановлен<\/span>/);
    assert.match(projectedTurns, /data-work-log-turn-prompt><strong>Запрос:<\/strong> Сделай работу<\/div>/);
    assert.doesNotMatch(projectedTurns, /data-work-log-turn-diff/u);
    assert.doesNotMatch(projectedTurns, /data-work-log-turn-files>[\s\S]*stopped\.mjs/u);
    const ledger = await persistedLedger(store);
    assert.equal(Object.values(ledger.turns)[0].usageReported, false);
    assert.match(Object.values(ledger.turns)[0].diff, /stopped = true/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic journal marks only the image-generated turn while task and day totals stay plain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-image-estimate-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(workLogFile, "# Глобальный журнал работ\n", "utf8");
    const store = new WorkLogUsageStore({ ledgerFile });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-art",
      turnId: "turn-art",
      taskTitle: "Art",
      status: "completed",
      title: "Фон создан",
      prompt: "Нарисуй чёрную дыру — это будет фон журнала",
      startedAt: new Date(2026, 6, 25, 12, 0).toISOString(),
      completedAt: new Date(2026, 6, 25, 12, 3).toISOString(),
      usageReported: true,
      usage: { inputTokens: 100_000 },
      estimatedCredits: 90,
      estimateKind: "imagegen-default",
      workLogFile,
    });
    const projected = await projectedJournal(store);
    assert.match(projected, /Итого<\/span> <span [^>]*data-kilo-usage[^>]*>12,5 cr<\/span>/);
    assert.doesNotMatch(projected, /ImageGen:|Оценка:/u);
    assert.match(projected, /12:03 — <span data-kilo-usage data-usage-credits="12.5"[^>]*>12,5 cr<\/span>/);
    assert.doesNotMatch(projected, /≈/u);
    assert.doesNotMatch(projected, /Итого<\/span> ≈/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("automatic journal creates the missing local-date section", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "work-log-new-day-"));
  try {
    const ledgerFile = path.join(root, "work-log-usage.json");
    const workLogFile = path.join(root, "WORK_LOG.md");
    await writeFile(
      workLogFile,
      "# Глобальный журнал работ\n\n"
        + "<details><summary><strong>24.07.2026</strong></summary>"
        + "<table><tbody></tbody></table></details>\n",
      "utf8",
    );
    const completedAt = new Date(2026, 6, 25, 15, 30).toISOString();
    const store = new WorkLogUsageStore({ ledgerFile });
    await store.recordAutomaticAndProject({
      provider: "codex",
      threadId: "thread-new-day",
      turnId: "turn-new-day",
      taskTitle: "Новая дата",
      title: "Автоматически создана строка",
      completedAt,
      usageReported: true,
      usage: { inputTokens: 1_000 },
      workLogFile,
    });
    const projected = await projectedJournal(store);
    assert.match(projected, /<summary data-work-log-day><strong>25\.07\.2026<\/strong>/);
    assert.match(projected, /data-work-log-thread-id="thread-new-day"/);
    assert.match(projected, /data-work-log-turn-id="turn-new-day"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy outcome restoration matches rows by date and task title", () => {
  const previous = "<details><summary><strong>24.07.2026</strong></summary><table><tbody>"
    + "<tr><td>Codex - Task</td><td>Старый итог</td><td></td></tr>"
    + "</tbody></table></details>";
  const current = "<details><summary><strong>24.07.2026</strong></summary><table><tbody>"
    + "<tr><td>Codex - Task</td><td data-work-log-turn-list></td><td></td></tr>"
    + "</tbody></table></details>";
  const restored = restoreLegacyOutcomes(current, previous);
  assert.match(restored, /data-work-log-restored-outcome>Старый итог<\/div>/);
  assert.match(projectWorkLogUsage(restored), /data-work-log-legacy-outcome>Старый итог<\/div>/);
});

test("full-text work-log search covers prompts, answers, files and local dates", () => {
  const turns = {
    first: {
      provider: "codex",
      projectRoot: "C:\\Projects\\Main",
      threadId: "thread-a",
      taskThreadId: "thread-a",
      turnId: "turn-1",
      taskTitle: "Журнал работ",
      title: "Исправлена доставка",
      prompt: "Почему сообщение дублируется?",
      body: "Дедупликация теперь использует точный itemId.",
      changedFiles: ["assets/web-app/hub-client.js"],
      completedAt: "2026-07-30T03:15:00.000Z",
    },
    second: {
      provider: "codex",
      projectRoot: "C:\\Projects\\Other",
      threadId: "thread-b",
      turnId: "turn-2",
      taskTitle: "Чужой проект",
      body: "Дедупликация",
      completedAt: "2026-07-30T04:00:00.000Z",
    },
  };
  const byAnswer = searchWorkLogRecords(turns, "точный itemId", {
    projectRoots: ["C:\\Projects\\Main"],
  });
  assert.equal(byAnswer.length, 1);
  assert.equal(byAnswer[0].threadId, "thread-a");
  assert.equal(byAnswer[0].matches[0].field, "Ответ");
  assert.match(byAnswer[0].matches[0].snippet, /itemId/u);

  assert.equal(searchWorkLogRecords(turns, "hub-client.js")[0].matches[0].field, "Файлы");
  assert.equal(searchWorkLogRecords(turns, "30.07.2026")[0].matches[0].field, "Дата");
});

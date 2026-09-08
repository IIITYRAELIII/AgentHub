import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TurnEndDeliveryService } from "../../../src/application/turn-end-delivery-service.mjs";
import { TerminalTurnCommitService } from "../../../src/application/terminal-turn-commit-service.mjs";
import {
  createCodexTerminalAuditScheduler,
} from "../../../src/composition/provider-runtime-wiring-composition.mjs";
import { ProviderTurnTerminalStore } from "../../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { MessageCommandLedgerStore } from "../../../src/infrastructure/persistence/message-command-ledger-store.mjs";
import { CodexTerminalAudit } from "../../../src/providers/codex/codex-terminal-audit.mjs";
import { CodexTerminalReconciliationService } from "../../../src/providers/codex/codex-terminal-reconciliation-service.mjs";
import {
  readCodexTurnUsage,
  scanCodexHistoricalRollout,
} from "../../../src/providers/codex/codex-turn-usage.mjs";

function completion(overrides = {}) {
  return {
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAnswer: "Final answer",
    usage: { inputTokens: 3, outputTokens: 5 },
    usageReported: true,
    completedAt: "2026-08-25T12:00:00.000Z",
    ...overrides,
  };
}

test("terminal store strips oversized client identity before serializing payload", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-bounded-id-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new ProviderTurnTerminalStore({ dataDir });
  const oversized = "x".repeat(201);

  const result = await store.commit({
    provider: "codex",
    threadId: "thread-bounded",
    turnId: "turn-bounded",
    status: "completed",
    finalAnswer: "Done",
    usageIdentity: "usage",
    payload: {
      completion: { clientUserMessageId: oversized },
      history: {
        clientUserMessageId: oversized,
        userMessages: [{ role: "user", text: "Body", clientUserMessageId: oversized }],
      },
    },
  });

  assert.equal(result.terminal.payload.completion.clientUserMessageId, undefined);
  assert.equal(result.terminal.payload.history.clientUserMessageId, undefined);
  assert.equal(result.terminal.payload.history.userMessages[0].clientUserMessageId, undefined);
  assert.equal(result.outbox.channels.command.clientUserMessageId, null);
});

test("terminal store strips conflicting top-level and root identity", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-conflicting-id-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const store = new ProviderTurnTerminalStore({ dataDir });
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-1",
    streamName: "Architect",
    provider: "codex",
    sourceThreadId: "thread-source",
    requestId: "request-a",
  };

  const result = await store.commit({
    provider: "codex",
    threadId: "thread-conflict",
    turnId: "turn-conflict",
    status: "completed",
    finalAnswer: "Done",
    usageIdentity: "usage",
    payload: {
      completion: {
        clientUserMessageId: "mcp:request-a",
        messageOrigin: origin,
        userMessages: [{
          role: "user",
          text: "raw",
          clientUserMessageId: "mcp:request-b",
          origin: { ...origin, requestId: "request-b" },
        }],
      },
      history: {},
    },
  });

  assert.equal(result.terminal.payload.completion.clientUserMessageId, undefined);
  assert.equal(result.terminal.payload.completion.messageOrigin, undefined);
  assert.equal(result.terminal.payload.completion.userMessages[0].clientUserMessageId, undefined);
  assert.equal(result.terminal.payload.completion.userMessages[0].origin, undefined);
  assert.equal(result.outbox.channels.command.clientUserMessageId, null);
});

test("terminal commit is idempotent and revisions supersede pending projections", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });

  const first = await terminal.commit(completion());
  const duplicate = await terminal.commit(completion());
  assert.equal(first.created, true);
  assert.equal(first.terminal.terminalRevision, 1);
  assert.equal(first.outbox.state, "pending");
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.terminal.terminalRevision, 1);
  const replayedAfterRestart = await terminal.commit(completion({
    completedAt: "2026-08-25T12:00:01.000Z",
  }));
  assert.equal(replayedAfterRestart.terminal.terminalRevision, 1);

  const claimed = await terminal.claim(first.outbox);
  assert.equal(claimed.state, "projecting");
  assert.equal(claimed.attempts, 1);
  assert.equal(await terminal.recoverProjecting(), 1);
  assert.equal((await terminal.pending())[0].terminalRevision, 1);

  const lateActive = await terminal.commit(completion({
    status: "inProgress",
    finalAnswer: "late progress",
  }));
  assert.equal(lateActive.absorbed, true);
  assert.equal(lateActive.terminal.terminalRevision, 1);

  const revised = await terminal.commit(completion({ finalAnswer: "Corrected final answer" }));
  assert.equal(revised.terminal.terminalRevision, 2);
  assert.deepEqual((await terminal.pending()).map((item) => item.terminalRevision), [2]);
});

test("terminal owner waits asynchronously for a transient runtime database writer", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-contention-"));
  const store = new ProviderTurnTerminalStore({ dataDir, mutationTimeoutMs: 1_000 });
  await store.get({ provider: "codex", threadId: "thread-lock", turnId: "turn-lock" });
  const blocker = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  context.after(async () => {
    blocker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  blocker.exec("BEGIN IMMEDIATE;");

  const committed = store.commit({
    provider: "codex",
    threadId: "thread-lock",
    turnId: "turn-lock",
    status: "completed",
    finalAnswer: "Done after contention",
    usageIdentity: "usage-lock",
    payload: { completion: {}, history: {} },
  });
  setTimeout(() => blocker.exec("COMMIT;"), 75);

  const result = await committed;
  assert.equal(result.created, true);
  assert.equal(result.terminal.finalAnswer, "Done after contention");
  assert.equal(result.outbox.state, "pending");
});

test("terminal outbox mutations survive contention without duplicating effects", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-outbox-contention-"));
  const store = new ProviderTurnTerminalStore({ dataDir, mutationTimeoutMs: 1_000 });
  const committed = await store.commit({
    ...completion(),
    payload: { completion: { clientUserMessageId: "command-1" } },
    channels: { telegram: { requested: true } },
  });
  const blocker = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
  context.after(async () => {
    blocker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const contended = async (operation) => {
    blocker.exec("BEGIN IMMEDIATE;");
    const release = setTimeout(() => blocker.exec("COMMIT;"), 50);
    try {
      return await operation();
    } finally {
      clearTimeout(release);
      if (blocker.isTransaction) blocker.exec("ROLLBACK;");
    }
  };

  const claimed = await contended(() => store.claim(committed.outbox));
  assert.equal(claimed.state, "projecting");
  assert.equal(claimed.attempts, 1);
  assert.equal(await store.claim(committed.outbox), null);
  assert.equal((await contended(() => store.retry(claimed, new Error("projection failed")))).state, "pending");
  await store.claim(committed.outbox);
  assert.equal(await contended(() => store.recoverProjecting()), 1);
  const recovered = await store.claim(committed.outbox);
  assert.equal(recovered.attempts, 3);
  assert.equal((await contended(() => store.acknowledge(recovered))).state, "delivered");
  assert.equal((await contended(() => store.acknowledgeCommand(recovered))).channels.command.state, "acked");
  const delivered = await contended(() => store.updateChannel(recovered, "telegram", "acked", {
    deliveryId: "delivery-1",
  }));
  assert.equal(delivered.channels.telegram.state, "acked");
  assert.equal(delivered.channels.telegram.deliveryId, "delivery-1");
  assert.equal((await store.get(committed.terminal)).terminalRevision, 1);
  assert.deepEqual(await store.pending(), []);
});

test("terminal owner migrates bounded payload metadata and provides indexed recovery order", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-metadata-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const databaseFile = path.join(dataDir, "runtime.sqlite");
  let database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE provider_turn_terminals (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      terminal_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      final_answer TEXT NOT NULL,
      usage_identity TEXT NOT NULL,
      last_message_json TEXT,
      payload_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      committed_at TEXT NOT NULL,
      PRIMARY KEY (provider, thread_id, turn_id)
    ) WITHOUT ROWID
  `);
  const insert = database.prepare(`
    INSERT INTO provider_turn_terminals (
      provider, thread_id, turn_id, terminal_revision, status, final_answer,
      usage_identity, payload_json, content_hash, committed_at
    ) VALUES ('codex', ?, ?, 1, 'completed', '', '', ?, ?, ?)
  `);
  database.exec("BEGIN");
  for (let index = 0; index < 205; index += 1) {
    const payloadJson = JSON.stringify({ index, marker: "я".repeat(index % 5) });
    insert.run(
      `legacy-thread-${index}`,
      `legacy-turn-${index}`,
      payloadJson,
      `hash-${index}`,
      new Date(Date.UTC(2026, 8, 5, 0, 0, index)).toISOString(),
    );
  }
  database.exec("COMMIT");
  database.close();

  const store = new ProviderTurnTerminalStore({ dataDir });
  assert.ok(await store.get({
    provider: "codex",
    threadId: "legacy-thread-204",
    turnId: "legacy-turn-204",
  }));

  database = new DatabaseSync(databaseFile);
  const columns = database.prepare("PRAGMA table_info(provider_turn_terminals)").all();
  assert.ok(columns.some((column) => column.name === "payload_bytes"));
  assert.equal(database.prepare(`
    SELECT count(*) AS count FROM provider_turn_terminals WHERE payload_bytes > 0
  `).get().count, 200);
  const plan = database.prepare(`
    EXPLAIN QUERY PLAN
    SELECT provider, thread_id, turn_id, committed_at, payload_bytes
    FROM provider_turn_terminals INDEXED BY provider_turn_terminals_recovery_idx
    ORDER BY committed_at DESC, provider, thread_id, turn_id
    LIMIT ?
  `).all(200).map((row) => String(row.detail));
  assert.ok(plan.some((detail) => /provider_turn_terminals_recovery_idx/u.test(detail)), plan.join("\n"));
  assert.ok(plan.every((detail) => !/USE TEMP B-TREE/u.test(detail)), plan.join("\n"));
  database.close();

  await store.commit(completion({
    threadId: "new-thread",
    turnId: "new-turn",
    payload: { marker: "кириллица" },
  }));
  database = new DatabaseSync(databaseFile);
  const created = database.prepare(`
    SELECT payload_json, payload_bytes FROM provider_turn_terminals
    WHERE provider = 'codex' AND thread_id = 'new-thread' AND turn_id = 'new-turn'
  `).get();
  assert.equal(created.payload_bytes, Buffer.byteLength(created.payload_json, "utf8"));
  database.close();
});

test("terminal attachment changes create a new durable revision", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-images-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });

  const first = await terminal.commit(completion({
    responseAttachments: [{ id: "codex-generated-one.png", type: "image/png" }],
  }));
  const revised = await terminal.commit(completion({
    responseAttachments: [
      { id: "codex-generated-one.png", type: "image/png" },
      { id: "codex-generated-two.png", type: "image/png" },
    ],
  }));

  assert.equal(first.terminal.terminalRevision, 1);
  assert.equal(revised.terminal.terminalRevision, 2);
  assert.deepEqual(revised.terminal.payload.completion.responseAttachments.map((item) => item.id), [
    "codex-generated-one.png",
    "codex-generated-two.png",
  ]);
});

test("delivered terminal repairs generated outputs durably after restart without duplicate replay", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-image-repair-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const firstTerminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const first = await firstTerminal.commit(completion({
    imageGenerationCount: 3,
    responseAttachments: [],
  }), {
    run: {
      id: "run-image",
      streamId: "stream-image",
      clientUserMessageId: "message-image",
      responseItemId: "response-image",
      userMessages: [{ role: "user", text: "Три варианта" }],
      activities: [{ id: "imagegen-1", status: "completed" }],
    },
  });
  const projected = [];
  const deliveryDependencies = {
    notifications: { values: () => [], markDelivered() {} },
    taskRuns: { forEvent: () => null },
    persistHistory: async (history) => { projected.push(structuredClone(history)); },
    projectTurn: async () => null,
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    logger: { error() {} },
  };
  const firstDelivery = new TurnEndDeliveryService({
    ...deliveryDependencies,
    terminalCommits: firstTerminal,
  });
  await firstDelivery.deliverOutbox(first.outbox);

  const restartedTerminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const restartedDelivery = new TurnEndDeliveryService({
    ...deliveryDependencies,
    terminalCommits: restartedTerminal,
  });
  const attachments = [
    { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
    { id: "codex-generated-two.png", name: "Изображение", type: "image/png" },
    { id: "codex-generated-three.png", name: "Изображение", type: "image/png", missing: true },
  ];
  let resolutions = 0;
  const repair = () => restartedDelivery.reconcileResponseAttachments(completion(), {
    expectedCount: 3,
    resolveAttachments: async () => {
      resolutions += 1;
      return attachments;
    },
  });

  const repaired = await repair();
  const replay = await repair();
  const reopened = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const durable = await reopened.get(completion());

  assert.equal(repaired.enriched, true);
  assert.equal(repaired.delivered, true);
  assert.equal(repaired.terminal.terminalRevision, 2);
  assert.equal(replay.enriched, false);
  assert.equal(resolutions, 1);
  assert.equal(projected.length, 2);
  assert.deepEqual(projected[1].responseAttachments, attachments);
  assert.equal(projected[1].id, "run-image");
  assert.equal(projected[1].clientUserMessageId, "message-image");
  assert.deepEqual(projected[1].userMessages, [{ role: "user", text: "Три варианта" }]);
  assert.deepEqual(projected[1].activities, [{ id: "imagegen-1", status: "completed" }]);
  assert.deepEqual(durable.payload.completion.responseAttachments, attachments);
  assert.deepEqual(durable.payload.history.responseAttachments, attachments);
  assert.equal(durable.terminalRevision, 2);
  assert.deepEqual(
    (await reopened.pending()).filter((item) => item.channels.projection.state === "pending"),
    [],
  );
});

test("current-shape delayed output repairs one exact count-less terminal after reopen", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-current-image-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const rollout = path.join(dataDir, "rollout.jsonl");
  const origin = completion({ threadId: "thread-origin", turnId: "turn-origin" });
  const unrelated = completion({ threadId: origin.threadId, turnId: "turn-intervening" });
  const initial = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  await initial.commit(origin);
  await initial.commit(unrelated);
  assert.equal(Object.hasOwn(origin, "imageGenerationCount"), false);

  const generatedPaths = ["C:/generated/one.png", "C:/generated/two.png", "C:/generated/three.png"];
  await writeFile(rollout, [
    {
      timestamp: "2026-08-25T12:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: origin.turnId },
    },
    {
      timestamp: "2026-08-25T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-image-current",
        input: "await tools.image_gen__imagegen({prompt: 'three variants'})",
        internal_chat_message_metadata_passthrough: { turn_id: origin.turnId },
      },
    },
    {
      timestamp: "2026-08-25T12:00:02.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: origin.turnId, last_agent_message: "Готово" },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n"), "utf8");

  const thread = {
    id: origin.threadId,
    cwd: "C:/workspace",
    path: rollout,
    updatedAt: "2026-08-25T12:00:00.000Z",
  };
  const auditOptions = (reconcile) => ({
    now: () => Date.parse("2026-08-25T12:05:00.000Z"),
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [thread],
    readThread: async () => null,
    resolveProject: async () => ({ path: "C:/workspace" }),
    reconcile,
    liveScanBytes: 1024 * 1024,
    auditBytesPerRun: 1024 * 1024,
    auditTimeMs: 10_000,
  });
  const beforeOutput = [];
  const initialAudit = new CodexTerminalAudit(auditOptions(async (_thread, _project, terminal) => {
    beforeOutput.push(terminal);
    return true;
  }));
  await initialAudit.run();
  const checkpointBeforeOutput = initialAudit.snapshot();
  assert.equal(beforeOutput.length, 1);
  assert.equal(beforeOutput[0].turnId, origin.turnId);
  assert.equal(beforeOutput[0].attachmentRepairOnly, undefined);
  assert.deepEqual(checkpointBeforeOutput.positions[0][1].resumeState.imageGenerationCalls, [
    ["call-image-current", origin.turnId],
  ]);

  await appendFile(rollout, `\n${[
    { type: "compacted", payload: { replacement_history: [] } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-intervening" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Поздний ответ" }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-intervening" },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-image-current",
        output: [
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          ...generatedPaths.map((savedPath) => ({
            type: "input_text",
            text: `Generated images are saved to C:/generated as ${savedPath} by default.`,
          })),
        ],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "image_generation_end",
        status: "completed",
        saved_path: "C:/generated/unkeyed-must-not-migrate.png",
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n")}`, "utf8");

  const scan = await scanCodexHistoricalRollout(rollout);
  const originUsage = scan.turns.find((turn) => turn.turnId === origin.turnId);
  const laterUsage = scan.turns.find((turn) => turn.turnId === unrelated.turnId);
  const candidate = scan.attachmentCandidates.find((item) => item.turnId === origin.turnId);
  assert.equal(originUsage.imageGenerationCount, 0);
  assert.equal(laterUsage.imageGenerationCount, 0);
  assert.deepEqual(candidate.generatedImageSources.map((source) => source.value), generatedPaths);
  assert.equal(scan.attachmentCandidates.some((item) => item.turnId === unrelated.turnId), false);
  assert.equal(scan.attachmentCandidates.some((item) => (
    item.generatedImageSources.some((source) => source.value.includes("unkeyed-must-not-migrate"))
  )), false);

  const reopened = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  let imports = 0;
  const reconciliation = new CodexTerminalReconciliationService({
    notifications: { hasDelivered: () => true, get: () => null },
    turnStarts: new Map(),
    workLogStore: {},
    accountingThread: async () => ({}),
    subagentParentTurnId: async () => "",
    readTurnUsage: async () => { throw new Error("repair-only provenance must not reread usage"); },
    taskGitDiff: async () => "",
    dataDir,
    projectTurn: async () => null,
    taskTitle: async () => "",
    defaultChatId: () => 0,
    fallbackMessage: () => "",
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    deliverNotification: async () => {},
    repairTerminalAttachments: (identity, options) => reopened.enrichResponseAttachments(identity, options),
    resolveTerminalAttachments: async ({ generatedImageSources }) => {
      imports += 1;
      return generatedImageSources.map((source) => ({
        id: `codex-generated-${path.basename(source.value)}`,
        name: "Изображение",
        type: "image/png",
      }));
    },
  });
  const observedCandidates = [];
  const reopenedAudit = new CodexTerminalAudit(auditOptions(async (...args) => {
    const terminal = args[2];
    observedCandidates.push(terminal);
    return await reconciliation.reconcile(...args);
  }));
  reopenedAudit.restore(checkpointBeforeOutput);
  await reopenedAudit.run();
  const afterRepair = reopenedAudit.snapshot();
  const replayedAudit = new CodexTerminalAudit(auditOptions((...args) => reconciliation.reconcile(...args)));
  replayedAudit.restore(afterRepair);
  await replayedAudit.run();

  const finalStore = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const repaired = await finalStore.get(origin);
  const untouched = await finalStore.get(unrelated);
  assert.equal(imports, 1);
  assert.equal(observedCandidates.length, 1);
  assert.equal(observedCandidates[0].turnId, origin.turnId);
  assert.equal(observedCandidates[0].attachmentRepairOnly, true);
  assert.equal(Object.hasOwn(observedCandidates[0], "expectedCount"), false);
  assert.equal(repaired.terminalRevision, 2);
  assert.deepEqual(repaired.payload.completion.responseAttachments.map((item) => item.id), [
    "codex-generated-one.png",
    "codex-generated-two.png",
    "codex-generated-three.png",
  ]);
  assert.deepEqual(repaired.payload.history.responseAttachments, repaired.payload.completion.responseAttachments);
  assert.equal(untouched.terminalRevision, 1);
  assert.deepEqual(untouched.payload.completion.responseAttachments ?? [], []);
});

test("current exec ImageGen result repairs exact empty terminal and survives reopen", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-current-imagegen-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const rollout = path.join(dataDir, "rollout-current-imagegen.jsonl");
  const identity = {
    provider: "codex",
    threadId: "thread-current-imagegen",
    turnId: "turn-current-imagegen",
  };
  const generatedPath = "C:/generated/dragon.png";
  const exact = (payload) => ({
    ...payload,
    internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
  });
  await writeFile(rollout, `${[
    { type: "event_msg", payload: { type: "task_started", turn_id: identity.turnId } },
    {
      type: "response_item",
      payload: exact({
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-current-imagegen",
        input: "const output = await tools.image_gen__imagegen({prompt: 'dragon'}); generatedImage(output);",
      }),
    },
    {
      type: "response_item",
      payload: exact({
        type: "custom_tool_call_output",
        call_id: "call-current-imagegen",
        output: [
          { type: "input_text", text: "Script completed" },
          { type: "input_image", image_url: "data:image/png;base64,b3V0cHV0" },
          {
            type: "input_text",
            text: `Generated images are saved to C:/generated as ${generatedPath} by default.`,
          },
        ],
      }),
    },
    {
      type: "response_item",
      payload: exact({
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Вот дракон." }],
      }),
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: identity.turnId,
        last_agent_message: "Вот дракон.",
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");

  const emptyTerminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  await emptyTerminal.commit(completion({
    ...identity,
    finalAnswer: "Вот дракон.",
    imageGenerationCount: null,
    responseAttachments: [],
  }), {
    run: { id: "run-current-imagegen", userMessages: [{ role: "user", text: "нарисуй дракона" }] },
  });

  const usageResult = await readCodexTurnUsage(rollout, identity.turnId, { attempts: 1 });
  assert.equal(usageResult.imageGenerationCount, 0);
  assert.deepEqual(usageResult.generatedImageSources, [
    { type: "generated-path", value: generatedPath },
  ]);

  const repairOwner = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  let imports = 0;
  const reconciliation = new CodexTerminalReconciliationService({
    notifications: {
      hasDelivered: () => true,
      get: () => null,
      takePendingMessage: () => null,
    },
    turnStarts: new Map(),
    workLogStore: { getTurn: async () => null },
    accountingThread: async (thread) => ({
      threadId: thread.id,
      parentThreadId: "",
      thread,
      isSubagent: false,
    }),
    subagentParentTurnId: async () => "",
    readTurnUsage: async () => usageResult,
    taskGitDiff: async () => "",
    dataDir,
    changedFilesForRun: () => [],
    projectTurn: async () => null,
    taskTitle: async () => "",
    defaultChatId: () => 0,
    fallbackMessage: () => "",
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    deliverNotification: async () => {},
    repairTerminalAttachments: (target, options) => (
      repairOwner.enrichResponseAttachments(target, options)
    ),
    resolveTerminalAttachments: async ({ generatedImageSources }) => {
      imports += 1;
      return generatedImageSources.map((source) => ({
        id: `codex-generated-${path.basename(source.value)}`,
        name: "Изображение",
        type: "image/png",
      }));
    },
  });
  assert.equal(await reconciliation.reconcile(
    { id: identity.threadId, path: rollout },
    { path: "C:/workspace" },
    {
      turnId: identity.turnId,
      status: "completed",
      completedAt: "2026-08-25T12:00:00.000Z",
      authoritative: true,
      usageResult,
    },
  ), true);

  const reopened = await new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  }).get(identity);
  assert.equal(imports, 1);
  assert.equal(reopened.terminalRevision, 2);
  assert.deepEqual(reopened.payload.completion.responseAttachments, [{
    id: "codex-generated-dragon.png",
    name: "Изображение",
    type: "image/png",
  }]);
  assert.deepEqual(
    reopened.payload.history.responseAttachments,
    reopened.payload.completion.responseAttachments,
  );
});

test("v15 EOF audit migrates once and repairs delivered current ImageGen output", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-v15-image-migration-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const rollout = path.join(dataDir, "rollout-v15.jsonl");
  const origin = completion({ threadId: "thread-v15", turnId: "turn-v15" });
  const generatedPath = "C:/generated/v15-output.png";
  const rolloutText = [
    {
      timestamp: "2026-08-25T12:00:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: origin.turnId },
    },
    {
      timestamp: "2026-08-25T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-image-v15",
        input: "await tools.image_gen__imagegen({prompt: 'one output'})",
        internal_chat_message_metadata_passthrough: { turn_id: origin.turnId },
      },
    },
    {
      timestamp: "2026-08-25T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "call-image-v15",
        output: [
          { type: "input_image", image_url: "data:image/png;base64,aW5wdXQ=" },
          {
            type: "input_text",
            text: `Generated images are saved to C:/generated as ${generatedPath} by default.`,
          },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: origin.turnId },
      },
    },
    {
      timestamp: "2026-08-25T12:00:03.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: origin.turnId, last_agent_message: "Готово" },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  await writeFile(rollout, rolloutText, "utf8");

  const initialTerminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const initialCommit = await initialTerminal.commit(origin, {
    run: {
      id: "run-v15",
      streamId: "stream-v15",
      clientUserMessageId: "message-v15",
      responseItemId: "response-v15",
      userMessages: [{ role: "user", text: "Нарисуй изображение" }],
    },
  });
  const historyProjections = [];
  const deliveryDependencies = {
    notifications: { values: () => [], markDelivered() {} },
    taskRuns: { forEvent: () => null },
    persistHistory: async (history) => { historyProjections.push(structuredClone(history)); },
    projectTurn: async () => null,
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    logger: { error() {} },
  };
  const initialDelivery = new TurnEndDeliveryService({
    ...deliveryDependencies,
    terminalCommits: initialTerminal,
  });
  await initialDelivery.deliverOutbox(initialCommit.outbox);

  const reopenedTerminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const reopenedDelivery = new TurnEndDeliveryService({
    ...deliveryDependencies,
    terminalCommits: reopenedTerminal,
  });
  let imports = 0;
  let historicalScans = 0;
  let historicalUsage = null;
  const reconciliation = new CodexTerminalReconciliationService({
    notifications: { hasDelivered: () => true, get: () => null },
    turnStarts: new Map(),
    workLogStore: {
      getTurn: async () => historicalUsage && ({
        provisional: false,
        usageReported: historicalUsage.reported === true,
        usage: historicalUsage.usage,
        estimatedCredits: historicalUsage.estimatedCredits,
        estimateKind: historicalUsage.estimateKind,
        imageGenerationCount: historicalUsage.imageGenerationCount,
        model: historicalUsage.model,
        serviceTier: historicalUsage.serviceTier,
        contextProbe: false,
      }),
    },
    accountingThread: async () => ({}),
    subagentParentTurnId: async () => "",
    readTurnUsage: async () => { throw new Error("v15 migration must use scanned exact-turn usage"); },
    taskGitDiff: async () => "",
    dataDir,
    projectTurn: async () => null,
    taskTitle: async () => "",
    defaultChatId: () => 0,
    fallbackMessage: () => "",
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    deliverNotification: async () => {},
    repairTerminalAttachments: (identity, options) => (
      reopenedDelivery.reconcileResponseAttachments(identity, options)
    ),
    resolveTerminalAttachments: async ({ generatedImageSources }) => {
      imports += 1;
      assert.deepEqual(generatedImageSources, [
        { type: "generated-path", value: generatedPath },
      ]);
      return [{
        id: "codex-generated-v15-output.png",
        name: "Изображение",
        type: "image/png",
      }];
    },
    logger: { log() {}, error() {} },
  });
  const discoveredThread = {
    id: origin.threadId,
    cwd: "C:/workspace",
    path: rollout,
    updatedAt: "2026-08-25T12:00:03.000Z",
  };
  const auditOptions = {
    now: () => Date.parse("2026-08-25T12:05:00.000Z"),
    listPage: async () => ({ data: [], nextCursor: null }),
    discoverHistoricalThreads: async () => [discoveredThread],
    resolveProject: async () => ({ path: "C:/workspace" }),
    reconcile: (...args) => reconciliation.reconcile(...args),
    scanHistoricalFile: async (thread) => {
      historicalScans += 1;
      const scan = await scanCodexHistoricalRollout(thread.path);
      historicalUsage = scan.turns.find((turn) => turn.turnId === origin.turnId) ?? null;
      return scan;
    },
    shouldRunAudit: () => true,
    shouldRunHistoricalBackfill: () => true,
    prepareHistoricalBackfill: async () => ({ backupFile: "v15-migration.sqlite" }),
    flushHistoricalProjection: async () => {},
    liveScanBytes: 16 * 1024,
    auditBytesPerRun: 16 * 1024,
    auditTimeMs: 10_000,
  };
  const eofOffset = Buffer.byteLength(rolloutText, "utf8");
  const preFixV15Snapshot = {
    version: 15,
    completedThrough: "2026-08-25T12:04:00.000Z",
    positions: [[origin.threadId, {
      path: rollout,
      offset: eofOffset,
      resumeState: { turns: [], activeTurnIds: [], imageGenerationCalls: [] },
    }]],
    pendingTurns: [],
    historicalSubagentBackfill: {
      pending: false,
      initialized: true,
      prepared: true,
      backupFile: "pre-fix-v15.sqlite",
      totalFiles: 1,
      completedFiles: 1,
      processedTurns: 1,
      projectionPending: false,
      queue: [],
      processedTurnIdentities: [`${origin.threadId}\0${origin.turnId}`],
    },
  };

  const migratedAudit = new CodexTerminalAudit(auditOptions);
  migratedAudit.restore(preFixV15Snapshot);
  assert.equal(migratedAudit.snapshot().historicalSubagentBackfill.pending, true);
  const persistedAuditSnapshots = [];
  const scheduler = createCodexTerminalAuditScheduler({
    codexTerminalAudit: migratedAudit,
    codexTransport: { running: false },
    saveState: async () => persistedAuditSnapshots.push(migratedAudit.snapshot()),
    isStopping: () => false,
    runtimeTimers: { schedule: () => true },
  });
  await scheduler.auditNow();
  const migratedSnapshot = migratedAudit.snapshot();

  assert.equal(migratedSnapshot.version, 17);
  assert.equal(migratedSnapshot.historicalSubagentBackfill.pending, false);
  assert.equal(migratedSnapshot.historicalSubagentBackfill.completedFiles, 1);
  assert.equal(historicalScans, 1);
  assert.equal(historicalUsage.imageGenerationCount, 0);
  assert.equal(imports, 1);
  assert.equal(historyProjections.length, 2);
  assert.equal(persistedAuditSnapshots.length, 1);
  assert.equal(persistedAuditSnapshots[0].version, 17);
  assert.equal(persistedAuditSnapshots[0].historicalSubagentBackfill.pending, false);
  assert.deepEqual(historyProjections[1].responseAttachments.map((item) => item.id), [
    "codex-generated-v15-output.png",
  ]);

  const rebornAudit = new CodexTerminalAudit(auditOptions);
  rebornAudit.restore(migratedSnapshot);
  await rebornAudit.run();
  await rebornAudit.run();
  assert.equal(historicalScans, 1);
  assert.equal(imports, 1);
  assert.equal(historyProjections.length, 2);

  const hydrated = await new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  }).get(origin);
  assert.equal(hydrated.terminalRevision, 2);
  assert.deepEqual(hydrated.payload.completion.responseAttachments.map((item) => item.id), [
    "codex-generated-v15-output.png",
  ]);
  assert.deepEqual(
    hydrated.payload.history.responseAttachments,
    hydrated.payload.completion.responseAttachments,
  );
});

test("attachment repair retries CAS and preserves a newer terminal completion", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-image-race-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const racingTerminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  await terminal.commit(completion({ responseAttachments: [] }), {
    run: { id: "run-before", userMessages: [{ role: "user", text: "До гонки" }] },
  });
  let releaseResolver;
  let resolverStarted;
  const started = new Promise((resolve) => { resolverStarted = resolve; });
  const gate = new Promise((resolve) => { releaseResolver = resolve; });
  const repairing = terminal.enrichResponseAttachments(completion(), {
    expectedCount: 1,
    resolveAttachments: async () => {
      resolverStarted();
      await gate;
      return [{ id: "codex-generated-late.png", type: "image/png" }];
    },
  });
  await started;
  await racingTerminal.commit(completion({ finalAnswer: "Newer final answer" }), {
    run: { id: "run-after", userMessages: [{ role: "user", text: "После гонки" }] },
  });
  releaseResolver();

  const result = await repairing;
  const durable = await terminal.get(completion());
  assert.equal(result.enriched, true);
  assert.equal(durable.terminalRevision, 3);
  assert.equal(durable.payload.completion.finalAnswer, "Newer final answer");
  assert.equal(durable.payload.history.id, "run-after");
  assert.deepEqual(durable.payload.history.userMessages, [{ role: "user", text: "После гонки" }]);
  assert.deepEqual(durable.payload.history.responseAttachments, [
    { id: "codex-generated-late.png", type: "image/png" },
  ]);
});

test("late attachment repair revises only the exact originating terminal", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-image-owner-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const origin = completion({
    turnId: "turn-origin",
    finalAnswer: "Original final",
    imageGenerationCount: 2,
    responseAttachments: [],
  });
  const intervening = completion({
    turnId: "turn-intervening",
    finalAnswer: "Intervening final",
    responseAttachments: [],
  });
  await terminal.commit(origin, {
    run: { id: "run-origin", userMessages: [{ role: "user", text: "Generate" }] },
  });
  await terminal.commit(intervening, {
    run: { id: "run-intervening", userMessages: [{ role: "user", text: "Next" }] },
  });
  const generated = [
    { id: "codex-generated-origin-one.png", type: "image/png" },
    { id: "codex-generated-origin-two.png", type: "image/png" },
  ];

  const repaired = await terminal.enrichResponseAttachments(origin, {
    expectedCount: 2,
    resolveAttachments: async () => generated,
  });
  const reopened = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const durableOrigin = await reopened.get(origin);
  const durableIntervening = await reopened.get(intervening);

  assert.equal(repaired.enriched, true);
  assert.equal(durableOrigin.terminalRevision, 2);
  assert.deepEqual(durableOrigin.payload.completion.responseAttachments, generated);
  assert.deepEqual(durableOrigin.payload.history.responseAttachments, generated);
  assert.equal(durableIntervening.terminalRevision, 1);
  assert.equal(durableIntervening.finalAnswer, "Intervening final");
  assert.deepEqual(durableIntervening.payload.completion.responseAttachments, []);
  assert.deepEqual(durableIntervening.payload.history.responseAttachments, []);
});

test("authoritative output repair replaces input and view image descriptors", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-image-scope-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  await terminal.commit(completion({
    imageGenerationCount: 2,
    responseAttachments: [
      { id: "codex-viewed-reference.png", type: "image/png" },
      { id: "codex-displayed-input.png", type: "image/png" },
    ],
  }));

  await terminal.enrichResponseAttachments(completion(), {
    expectedCount: 2,
    resolveAttachments: async () => [
      { id: "codex-generated-one.png", type: "image/png" },
      { id: "codex-generated-two.png", type: "image/png" },
    ],
  });

  const durable = await terminal.get(completion());
  assert.deepEqual(durable.payload.completion.responseAttachments.map((item) => item.id), [
    "codex-generated-one.png",
    "codex-generated-two.png",
  ]);
});

test("missing projection ACK repeats one revision without repeating provider effect", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-outbox-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  let providerEffects = 0;
  let projections = 0;
  const providerCompletion = async () => {
    providerEffects += 1;
    return terminal.commit(completion());
  };
  const committed = await providerCompletion();

  const dependencies = {
    notifications: { values: () => [], markDelivered() {} },
    terminalCommits: terminal,
    taskRuns: { forEvent: () => null },
    persistHistory: async (_run, options) => {
      assert.equal(options.terminalRevision, 1);
    },
    projectTurn: async (value) => {
      projections += 1;
      assert.equal(value.terminalRevision, 1);
    },
    rememberLastMessage() {},
    rememberSeenTurn() {},
    logger: { error() {} },
  };
  const interrupted = new TurnEndDeliveryService({
    ...dependencies,
    saveState: async () => { throw new Error("crash before ACK"); },
  });
  await assert.rejects(interrupted.deliverOutbox(committed.outbox), /crash before ACK/u);
  assert.equal((await terminal.pending())[0].attempts, 1);

  const restarted = new TurnEndDeliveryService({
    ...dependencies,
    saveState: async () => {},
  });
  await restarted.retryPending();

  assert.equal(providerEffects, 1);
  assert.equal(projections, 2);
  assert.deepEqual(await terminal.pending(), []);
});

test("startup pending reconciliation repairs a command left started after terminal commit", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-command-"));
  const ledger = new MessageCommandLedgerStore({ dataDir });
  context.after(async () => {
    ledger.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  ledger.accept({
    item: { clientUserMessageId: "message-1", createdAt: "2026-08-25T12:00:00.000Z" },
    destination: "queued",
    receipt: { clientUserMessageId: "message-1", fingerprint: "fingerprint-1" },
  });
  ledger.transition({ clientUserMessageId: "message-1", state: "started" });
  let transitionUnavailable = true;
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
    messageCommands: {
      transitionMessageCommand: (value) => {
        if (transitionUnavailable) throw new Error("simulated cross-database crash");
        return ledger.transition(value);
      },
    },
    logger: { error() {} },
  });

  const committed = await terminal.commit(completion(), {
    run: { id: "run-1", clientUserMessageId: "message-1" },
  });
  assert.equal(committed.commandReconciled, false);
  assert.equal(ledger.get("message-1").state, "started");

  transitionUnavailable = false;
  await terminal.pending();
  assert.equal(ledger.get("message-1").state, "completed");
  assert.equal(ledger.get("message-1").result.terminalRevision, 1);
});

test("Telegram channel intent survives projection ACK and records uncertain then acked", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-terminal-channel-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const terminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir }),
  });
  const committed = await terminal.commit(completion(), {
    channelIntents: {
      telegram: {
        requested: true,
        run: { provider: "codex", threadId: "thread-1", turnId: "turn-1", chatId: 7 },
        message: "Final answer",
      },
    },
  });
  assert.equal(committed.outbox.channels.telegram.state, "intent");

  const projection = await terminal.claim(committed.outbox);
  await terminal.acknowledge(projection);
  assert.equal((await terminal.pending())[0].channels.projection.state, "delivered");
  assert.equal((await terminal.pending())[0].channels.telegram.state, "intent");

  const materialized = [];
  const restarted = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} },
    terminalCommits: terminal,
    taskRuns: { forEvent: () => null },
    persistHistory: async () => assert.fail("delivered projection must not repeat"),
    projectTurn: async () => assert.fail("delivered projection must not repeat"),
    finalizeRunDelivery: async (run, options) => materialized.push({ run, options }),
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    logger: { error() {} },
  });
  await restarted.retryPending();
  assert.equal(materialized.length, 1);
  assert.equal(materialized[0].options.terminalIntent.terminalRevision, 1);

  const uncertain = await terminal.markChannelUncertain(committed.outbox, { deliveryId: "delivery-1" });
  assert.equal(uncertain.channels.telegram.state, "uncertain");
  const acked = await terminal.acknowledgeChannel(committed.outbox, { deliveryId: "delivery-1" });
  assert.equal(acked.channels.telegram.state, "acked");
  assert.deepEqual(await terminal.pending(), []);
});

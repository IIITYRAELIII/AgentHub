import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TurnEndDeliveryService } from "../../../src/application/turn-end-delivery-service.mjs";
import { TerminalTurnCommitService } from "../../../src/application/terminal-turn-commit-service.mjs";
import { ProviderTurnTerminalStore } from "../../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { MessageCommandLedgerStore } from "../../../src/infrastructure/persistence/message-command-ledger-store.mjs";
import { CodexTerminalAudit } from "../../../src/providers/codex/codex-terminal-audit.mjs";
import { CodexTerminalReconciliationService } from "../../../src/providers/codex/codex-terminal-reconciliation-service.mjs";
import { scanCodexHistoricalRollout } from "../../../src/providers/codex/codex-turn-usage.mjs";

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

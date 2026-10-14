import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDesktopMessageController } from "../../../src/interfaces/desktop/desktop-message-controller.mjs";
import { MessageReceiptRegistry } from "../../../src/infrastructure/persistence/message-receipts.mjs";
import { RunCoordinator } from "../../../src/application/run-coordinator.mjs";
import {
  createInterstreamMessage,
  interstreamMessageDetails,
} from "../../../src/domain/interstream-message.mjs";
import { DeferredComposerTransferRegistry } from "../../../src/application/deferred-composer-transfer-registry.mjs";

test("same-id transport retry preserves the accepted attachment through receipt reload and steering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-retry-owned-attachment-"));
  const file = path.join(directory, "48c5435f-a6e6-4559-a3c6-0ab0f09c8d07--aW1hZ2UucG5n.png");
  const bytes = Buffer.from("exact uploaded image bytes");
  await writeFile(file, bytes);
  try {
    for (const withTransfer of [false, true]) {
      const receipts = new MessageReceiptRegistry();
      const submitted = [];
      const steered = [];
      let rejectClaim = false;
      const runCoordinator = {
        submitClientInput: async (input) => { submitted.push(input); return { accepted: true, deferred: true, queued: true, id: "queue-1" }; },
        steer: async (input) => { steered.push(input); return { accepted: true, steered: true }; },
      };
      const options = {
        receipts, runCoordinator,
        attachmentPaths: async (files) => { for (const name of files) await stat(name); return files; },
        describeAttachments: (files) => files.map((name) => ({ id: path.basename(name), name: "image.png", type: "image/png" })),
        discardPreparedAttachments: async (files) => { await Promise.all(files.map((name) => unlink(name))); },
        ...(withTransfer ? { composerTransfers: {
          resolve: (value) => value, claim: async (value) => {
            if (rejectClaim) throw new Error("claim rejected");
            return value;
          }, consume: async () => true,
        } } : {}),
      };
      const request = { text: "Оформление этой страницы", clientUserMessageId: "image-message", attachments: [file],
        ...(withTransfer ? { composerTransfer: { id: "draft-1", token: "token-1" } } : {}) };
      const first = controller(options);
      const result = await first.sendMessage(request, { source: "direct-http" });
      await first.sendMessage(request, { source: "vscode-ipc" });
      assert.deepEqual(await readFile(file), bytes);
      const restored = new MessageReceiptRegistry();
      restored.restore([...receipts.receipts.values()]);
      const afterReload = controller({ ...options, receipts: restored });
      const repeated = await afterReload.sendMessage(request, { source: "vscode-ipc" });
      assert.equal(repeated.id, result.id);
      assert.deepEqual(repeated.attachments, result.attachments);
      await assert.rejects(afterReload.sendMessage({ ...request, text: "Changed retry" }),
        (error) => error.code === "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH");
      assert.deepEqual(await readFile(file), bytes);
      if (withTransfer) {
        rejectClaim = true;
        await assert.rejects(afterReload.sendMessage(request), /claim rejected/u);
        assert.deepEqual(await readFile(file), bytes);
        rejectClaim = false;
      }
      assert.equal(submitted.length, 1);
      await afterReload.steerActiveInput({ input: submitted[0].input, target: submitted[0].target,
        clientUserMessageId: request.clientUserMessageId });
      assert.equal(steered.length, 1);
      assert.deepEqual(await readFile(file), bytes);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const EXISTING_IMAGE = fileURLToPath(
  new URL("../../../assets/web-app/themes/blackhole/blackhole-blue.jpg", import.meta.url),
);

const ANNOTATION_SOURCE = {
  version: 1,
  provider: "codex",
  threadId: "thread-1",
  turnId: "turn-source",
  itemId: "agent-source",
  role: "agent",
  messageKey: "provider\u001fcodex\u001fthread-1\u001fturn-source\u001fagent-source\u001fagent",
  surfaceKind: "message-body",
  surfaceIndex: 0,
  start: 4,
  end: 10,
  contentHash: `sha256:${"a".repeat(64)}`,
  surfaceHash: `sha256:${"b".repeat(64)}`,
  selectionHash: `sha256:${"c".repeat(64)}`,
};
const USER_ANNOTATION_SOURCE = {
  ...ANNOTATION_SOURCE,
  itemId: "user-source",
  role: "user",
  messageKey: "provider\u001fcodex\u001fthread-1\u001fturn-source\u001fuser-source\u001fuser",
};

function controller(overrides = {}) {
  const target = {
    provider: "codex",
    projectRoot: "C:\\Project",
    threadId: "thread-1",
    streamId: "stream-1",
    taskTitle: "Task",
    chatId: 84,
  };
  const taskRuns = overrides.taskRuns ?? { forTask: () => null };
  const readCodexThread = overrides.readCodexThread ?? (async () => ({ thread: { turns: [] } }));
  const sendRpc = overrides.sendRpc ?? (async () => ({}));
  const describeAttachments = overrides.describeAttachments
    ?? ((files) => files.map((file) => ({ id: String(file) })));
  const runCoordinator = overrides.runCoordinator ?? new RunCoordinator({
    taskRuns,
    providers: {
      call: async (provider, operation, { run, target: runTarget, input, clientUserMessageId }) => {
        if (operation !== "steerTurn") throw new Error(`unexpected provider operation: ${operation}`);
        if (provider !== "codex") throw new Error("Отправка в текущий ход недоступна для выбранного агента");
        let turnId = String(run?.turnId ?? "").trim();
        if (!turnId) {
          const result = await readCodexThread(runTarget.threadId, { fresh: true });
          const active = (result.thread?.turns ?? []).filter((turn) => (
            ["inProgress", "in_progress", "running"].includes(String(turn?.status ?? ""))
          ));
          if (active.length !== 1) throw new Error("Текущий ход уже нельзя изменить");
          turnId = String(active[0].id);
        }
        const result = await sendRpc("turn/steer", {
          threadId: runTarget.threadId,
          expectedTurnId: turnId,
          input: typeof input === "string" ? [{ type: "text", text: input }] : input,
          clientUserMessageId,
        });
        return { turnId: String(result?.turnId ?? turnId) };
      },
    },
    externalActivity: overrides.taskExternalActivity
      ?? (async () => ({ state: "inactive", executionOwner: null })),
    repositoryConflict: overrides.activeRepositoryConflict ?? (async () => null),
    deferInput: overrides.deferConflictingInput
      ?? (async () => ({ id: "deferred-1", item: { id: "deferred-1" } })),
    scheduleDeferred: overrides.scheduleQueuedInput ?? (() => {}),
    hasDeferredBacklog: overrides.hasDeferredBacklog ?? (() => false),
    setProgressStage: overrides.setProgressStage ?? (() => {}),
    noteRunActivity: overrides.noteRunActivity ?? (() => {}),
    scheduleProgressUpdate: overrides.scheduleProgressUpdate ?? (() => {}),
    describeAttachments,
    beginRun: overrides.beginRun ?? (async () => ({
      id: "run-1",
      threadId: target.threadId,
      turnId: "turn-1",
    })),
    rollbackAdmission: async () => {},
    launchTurn: overrides.launchTurn ?? (async () => {}),
  });
  return createDesktopMessageController({
    attachmentPaths: overrides.attachmentPaths ?? (async () => []),
    describeAttachments,
    resolveTaskReferences: overrides.resolveTaskReferences ?? (async () => []),
    resolveTarget: overrides.resolveTarget ?? (async () => target),
    receipts: overrides.receipts ?? new MessageReceiptRegistry(),
    persistReceipts: overrides.persistReceipts ?? (async () => {}),
    runCoordinator,
    durableIntake: overrides.durableIntake ?? false,
    composerTransfers: overrides.composerTransfers ?? null,
    discardPreparedAttachments: overrides.discardPreparedAttachments ?? (async () => {}),
  });
}

test("desktop message consumes an exact deferred composer grant and preserves its origin", async () => {
  const messageOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1", workspaceName: "Agent HUB", streamId: "source-stream",
    streamName: "Release Manager", provider: "codex", model: "GPT-5.6-Sol",
    sourceThreadId: "source-thread", requestId: "source-request",
  };
  let launchedInput = null;
  let launchCount = 0;
  let consumed = null;
  const composerTransfers = {
    resolve: (value, target) => value.id === "deferred-1" && value.token === "transfer-1"
      && target.threadId === "thread-1"
      ? { ...value, messageOrigin }
      : null,
    claim: async (value, target) => composerTransfers.resolve(value, target),
    consume: async (value) => { consumed = value; return true; },
  };
  const messages = controller({
    composerTransfers,
    launchTurn: async (_run, input) => { launchedInput = input; launchCount += 1; },
  });

  const request = {
    text: "Изменённый текст",
    clientUserMessageId: "message-returned",
    composerTransfer: { id: "deferred-1", token: "transfer-1" },
  };
  await messages.sendMessage(request);
  await messages.sendMessage(request);

  assert.equal(interstreamMessageDetails(launchedInput).text, "Изменённый текст");
  assert.deepEqual(interstreamMessageDetails(launchedInput).origin, messageOrigin);
  assert.deepEqual(consumed, {
    id: "deferred-1", token: "transfer-1", messageOrigin,
  });
  assert.equal(launchCount, 1);

  await assert.rejects(messages.sendMessage({
    text: "Не должен уйти",
    clientUserMessageId: "message-stale-return",
    composerTransfer: { id: "deferred-1", token: "wrong" },
  }), /устарел/u);
});

test("desktop message reconciles a durable composer grant after process restart without duplicate send or file leak", async () => {
  const item = {
    id: "deferred-restart",
    provider: "codex",
    threadId: "thread-1",
    streamId: "stream-1",
    temporaryFiles: ["original-upload.png"],
  };
  const beforeRestart = new DeferredComposerTransferRegistry();
  await beforeRestart.remember(item, "transfer-restart");
  const durableGrant = beforeRestart.snapshot();
  const cleanup = [];
  const persisted = [];
  const afterRestart = new DeferredComposerTransferRegistry();
  await afterRestart.restore(durableGrant);
  afterRestart.configure({
    cleanup: async (value) => cleanup.push(...value.temporaryFiles),
    persist: async () => persisted.push(afterRestart.snapshot()),
  });
  const receipts = new MessageReceiptRegistry();
  let launchCount = 0;
  let uploadCount = 0;
  const discarded = [];
  const messagesBeforeSecondRestart = controller({
    composerTransfers: afterRestart,
    receipts,
    attachmentPaths: async () => [`retry-upload-${++uploadCount}.png`],
    describeAttachments: () => [{ name: "screen.png", type: "image/png", size: 10, sha256: "same" }],
    discardPreparedAttachments: async (files) => discarded.push(...files),
    launchTurn: async () => { launchCount += 1; },
  });
  const request = {
    text: "Изменённый текст",
    attachments: [{ name: "screen.png" }],
    clientUserMessageId: "message-after-restart",
    composerTransfer: { id: item.id, token: "transfer-restart" },
  };

  const first = await messagesBeforeSecondRestart.sendMessage(request);
  const consumedGrant = afterRestart.snapshot();
  assert.equal(consumedGrant[0].claimedBy, request.clientUserMessageId);
  assert.equal(consumedGrant[0].effectAccepted, true);
  const reconciledAfterRestart = new DeferredComposerTransferRegistry();
  await reconciledAfterRestart.restore(consumedGrant, {
    cleanup: async (value) => cleanup.push(...value.temporaryFiles),
  });
  reconciledAfterRestart.configure({
    cleanup: async (value) => cleanup.push(...value.temporaryFiles),
    persist: async () => persisted.push(reconciledAfterRestart.snapshot()),
  });
  const messagesAfterSecondRestart = controller({
    composerTransfers: reconciledAfterRestart,
    receipts,
    attachmentPaths: async () => [`retry-upload-${++uploadCount}.png`],
    describeAttachments: () => [{ name: "screen.png", type: "image/png", size: 10, sha256: "same" }],
    discardPreparedAttachments: async (files) => discarded.push(...files),
    launchTurn: async () => { launchCount += 1; },
  });
  const repeated = await messagesAfterSecondRestart.sendMessage(request);

  assert.equal(first.runId, repeated.runId);
  assert.equal(launchCount, 1);
  assert.deepEqual(cleanup, ["original-upload.png"]);
  assert.deepEqual(discarded, ["retry-upload-2.png"]);
  assert.equal(persisted.length, 3);
  assert.deepEqual(persisted.map(([grant]) => ({
    claimedBy: grant.claimedBy,
    effectAccepted: grant.effectAccepted,
    cleanupCompleted: grant.cleanupCompleted,
  })), [{
    claimedBy: request.clientUserMessageId,
    effectAccepted: false,
    cleanupCompleted: false,
  }, {
    claimedBy: request.clientUserMessageId,
    effectAccepted: true,
    cleanupCompleted: false,
  }, {
    claimedBy: request.clientUserMessageId,
    effectAccepted: true,
    cleanupCompleted: true,
  }]);
  assert.equal(reconciledAfterRestart.resolve(request.composerTransfer, {
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
  }, { clientUserMessageId: "different-message" }), null);
});

test("desktop message durably claims one transfer before concurrent different-client admission", async () => {
  let releaseClaim;
  let claimStarted;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const claimObserved = new Promise((resolve) => { claimStarted = resolve; });
  const composerTransfers = new DeferredComposerTransferRegistry();
  await composerTransfers.remember({
    id: "deferred-race", provider: "codex", threadId: "thread-1", streamId: "stream-1",
    temporaryFiles: [],
  }, "transfer-race");
  composerTransfers.configure({
    persist: async () => {
      claimStarted();
      await claimGate;
    },
  });
  let launchCount = 0;
  const messages = controller({
    composerTransfers,
    launchTurn: async () => { launchCount += 1; },
  });
  const exactRequest = {
    text: "Один перенос",
    clientUserMessageId: "client-a",
    composerTransfer: { id: "deferred-race", token: "transfer-race" },
  };
  const first = messages.sendMessage(exactRequest);
  await claimObserved;
  const sameIdentityRetry = messages.sendMessage(exactRequest);

  await assert.rejects(messages.sendMessage({
    text: "Один перенос",
    clientUserMessageId: "client-b",
    composerTransfer: { id: "deferred-race", token: "transfer-race" },
  }), /закреплён/u);
  assert.equal(launchCount, 0);

  releaseClaim();
  const [accepted, coalesced] = await Promise.all([first, sameIdentityRetry]);
  assert.equal(accepted.runId, coalesced.runId);
  assert.equal(launchCount, 1);
});

test("desktop message never reaches provider when durable transfer claim persistence fails", async () => {
  const composerTransfers = new DeferredComposerTransferRegistry();
  await composerTransfers.remember({
    id: "deferred-persist", provider: "codex", threadId: "thread-1", streamId: "stream-1",
    temporaryFiles: [],
  }, "transfer-persist");
  composerTransfers.configure({ persist: async () => { throw new Error("disk full"); } });
  let launchCount = 0;
  const messages = controller({
    composerTransfers,
    launchTurn: async () => { launchCount += 1; },
  });

  await assert.rejects(messages.sendMessage({
    text: "Не отправлять без durable claim",
    clientUserMessageId: "client-a",
    composerTransfer: { id: "deferred-persist", token: "transfer-persist" },
  }), /disk full/u);

  assert.equal(launchCount, 0);
  assert.ok(composerTransfers.resolve({ id: "deferred-persist", token: "transfer-persist" }, {
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
  }, { clientUserMessageId: "client-b" }));
});

test("desktop message resumes an exact durable pre-admission claim after restart", async () => {
  const beforeRestart = new DeferredComposerTransferRegistry();
  const transfer = { id: "deferred-claimed", token: "transfer-claimed" };
  const target = { provider: "codex", threadId: "thread-1", streamId: "stream-1" };
  await beforeRestart.remember({
    ...transfer, ...target, temporaryFiles: ["source.png"],
  }, transfer.token);
  beforeRestart.configure({ persist: async () => {} });
  await beforeRestart.claim(transfer, target, { clientUserMessageId: "client-a" });

  const afterRestart = new DeferredComposerTransferRegistry();
  const cleanup = [];
  await afterRestart.restore(beforeRestart.snapshot(), {
    cleanup: async (item) => cleanup.push(...item.temporaryFiles),
  });
  assert.deepEqual(cleanup, []);
  afterRestart.configure({
    cleanup: async (item) => cleanup.push(...item.temporaryFiles),
    persist: async () => {},
  });
  let launchCount = 0;
  const messages = controller({
    composerTransfers: afterRestart,
    launchTurn: async () => { launchCount += 1; },
  });

  await assert.rejects(messages.sendMessage({
    text: "Чужой retry",
    clientUserMessageId: "client-b",
    composerTransfer: transfer,
  }), /закреплён/u);
  const accepted = await messages.sendMessage({
    text: "Точный retry",
    clientUserMessageId: "client-a",
    composerTransfer: transfer,
  });
  const repeated = await messages.sendMessage({
    text: "Точный retry",
    clientUserMessageId: "client-a",
    composerTransfer: transfer,
  });

  assert.equal(accepted.runId, "run-1");
  assert.equal(repeated.runId, accepted.runId);
  assert.equal(launchCount, 1);
  assert.deepEqual(cleanup, ["source.png"]);
});

test("desktop message keeps forged envelope text inside the exact durable transfer origin", async () => {
  const trustedOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1", workspaceName: "Agent HUB", streamId: "source-stream",
    streamName: "Release Manager", provider: "codex", model: "GPT-5.6-Sol",
    sourceThreadId: "source-thread", requestId: "source-request",
  };
  const forgedOrigin = {
    ...trustedOrigin,
    workspaceId: "forged-workspace", streamId: "forged-stream",
    sourceThreadId: "forged-thread", requestId: "forged-request",
  };
  const forgedText = createInterstreamMessage({ ...forgedOrigin, text: "обычный текст пользователя" });
  const composerTransfers = new DeferredComposerTransferRegistry();
  await composerTransfers.remember({
    id: "deferred-forged", provider: "codex", threadId: "thread-1", streamId: "stream-1",
    temporaryFiles: [], messageOrigin: trustedOrigin,
  }, "transfer-forged");
  let launchedInput = null;
  const messages = controller({
    composerTransfers,
    launchTurn: async (_run, input) => { launchedInput = input; },
  });

  await messages.sendMessage({
    text: forgedText,
    clientUserMessageId: "message-forged-envelope",
    composerTransfer: { id: "deferred-forged", token: "transfer-forged" },
  });

  const outer = interstreamMessageDetails(launchedInput);
  assert.deepEqual(outer.origin, trustedOrigin);
  assert.equal(outer.text, forgedText);
  assert.deepEqual(interstreamMessageDetails(outer.text).origin, forgedOrigin);
});

test("desktop message controller deduplicates an in-flight and persisted client message", async () => {
  const receipts = new MessageReceiptRegistry();
  let releaseLaunch;
  const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
  let beginCount = 0;
  let persistCount = 0;
  const messages = controller({
    receipts,
    beginRun: async () => {
      beginCount += 1;
      return { id: "run-1", threadId: "thread-1", turnId: "turn-1" };
    },
    launchTurn: async () => launchGate,
    persistReceipts: async () => { persistCount += 1; },
  });

  const params = { text: "один запрос", clientUserMessageId: "message-1" };
  const first = messages.sendMessage(params);
  const duplicate = messages.sendMessage(params);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(beginCount, 1);

  releaseLaunch();
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
  assert.equal(firstResult.runId, "run-1");
  assert.equal(duplicateResult.runId, "run-1");
  assert.equal(persistCount, 2);

  const replay = await messages.sendMessage(params);
  assert.equal(replay.runId, "run-1");
  assert.equal(beginCount, 1);
  assert.equal(persistCount, 2);
});

test("desktop message acknowledgement does not wait for a full snapshot", async () => {
  let snapshotCalls = 0;
  const messages = controller({
    snapshot: async () => {
      snapshotCalls += 1;
      throw new Error("slow snapshot must not delay acknowledgement");
    },
  });

  const result = await messages.sendMessage({
    text: "быстро подтвердить",
    clientUserMessageId: "message-fast-ack",
  });

  assert.equal(result.accepted, true);
  assert.deepEqual({
    streamId: result.streamId,
    provider: result.provider,
    threadId: result.threadId,
    clientUserMessageId: result.clientUserMessageId,
  }, {
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
    clientUserMessageId: "message-fast-ack",
  });
  assert.equal(snapshotCalls, 0);
  assert.equal("snapshot" in result, false);
});

test("desktop message acknowledgement does not hash attachment content", async () => {
  const missingFile = path.resolve("missing-upload.png");
  const messages = controller({
    attachmentPaths: async () => [missingFile],
    describeAttachments: () => [{ id: "upload-id--missing-upload.png", name: "missing-upload.png" }],
  });

  const result = await messages.sendMessage({
    text: "принять без чтения файла",
    attachments: [missingFile],
    clientUserMessageId: "message-no-content-hash",
  });

  assert.equal(result.accepted, true);
});

test("durable desktop intake reuses the queue persistence boundary", async () => {
  const receipts = new MessageReceiptRegistry();
  let controllerPersistenceCalls = 0;
  let receiptCapturedByQueue = null;
  let acceptedRequest = null;
  const messages = controller({
    durableIntake: true,
    receipts,
    persistReceipts: async () => { controllerPersistenceCalls += 1; },
    runCoordinator: {
      submitClientInput: async () => assert.fail("durable intake must use acceptClientInput"),
      steer: async () => ({}),
      acceptClientInput: async (request) => {
        acceptedRequest = request;
        receiptCapturedByQueue = receipts.get({ clientUserMessageId: "message-one-boundary" });
        return {
          accepted: true,
          queued: true,
          threadId: "thread-1",
          clientUserMessageId: "message-one-boundary",
        };
      },
    },
  });

  const result = await messages.sendMessage({
    text: "не ждать три записи",
    clientUserMessageId: "message-one-boundary",
    clientProjectionIntent: "conversation",
  });

  assert.equal(receiptCapturedByQueue.result.pending, true);
  assert.equal(receiptCapturedByQueue.result.clientProjectionIntent, "conversation");
  assert.equal(acceptedRequest.clientProjectionIntent, "conversation");
  assert.equal(controllerPersistenceCalls, 0);
  assert.equal(result.accepted, true);
  assert.equal(receipts.get({ clientUserMessageId: "message-one-boundary" }).result.pending, false);
  assert.equal(
    receipts.get({ clientUserMessageId: "message-one-boundary" }).result.clientProjectionIntent,
    "conversation",
  );
  await assert.rejects(messages.sendMessage({
    text: "неизвестная поверхность",
    clientUserMessageId: "message-invalid-projection",
    clientProjectionIntent: "sidebar",
  }), /Неизвестная проекция/u);
});

test("desktop message receipt preserves the interstream source author", async () => {
  const receipts = new MessageReceiptRegistry();
  const messageOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "gpt-5.6-sol",
    sourceThreadId: "thread-themes",
    requestId: "request-receipt",
  };
  const messages = controller({
    receipts,
    resolveTarget: async () => ({
      provider: "codex",
      projectRoot: "C:\\Project",
      threadId: "thread-1",
      taskTitle: "Task",
      messageOrigin,
    }),
  });

  await messages.sendMessage({
    text: "проверить receipt",
    clientUserMessageId: "message-origin-receipt",
  });

  const receipt = receipts.get({ clientUserMessageId: "message-origin-receipt" });
  assert.equal(receipt.result.author, "Agent HUB - Themes (Sol)");
  assert.deepEqual(receipt.result.origin, messageOrigin);
});

test("desktop message keeps an active follow-up pending for a manual action", async () => {
  const scheduled = [];
  let deferredOptions = null;
  const messages = controller({
    durableIntake: true,
    taskRuns: { forTask: () => ({ id: "run-active", executionOwner: "hub" }) },
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return {
        id: "durable-pending",
        item: { id: "durable-pending", destination: options.destination },
      };
    },
    scheduleQueuedInput: (item, delayMs) => scheduled.push({ item, delayMs }),
  });

  const result = await messages.sendMessage({
    text: "сохранить для ручного действия",
    clientUserMessageId: "message-durable-intake",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.deferred, true);
  assert.equal(result.queued, undefined);
  assert.equal(result.reason, "task-running");
  assert.equal(deferredOptions.destination, undefined);
  assert.equal(deferredOptions.conflictKind, "task-running");
  assert.deepEqual(scheduled, [{
    item: { id: "durable-pending", destination: undefined },
    delayMs: undefined,
  }]);
});

test("desktop message controller forwards the complete long user message", async () => {
  const text = "длинное сообщение ".repeat(2_000);
  let launchedInput;
  const messages = controller({
    launchTurn: async (_run, input) => { launchedInput = input; },
  });

  await messages.sendMessage({ text, clientUserMessageId: "message-long" });

  assert.equal(launchedInput, text.trim());
  assert.equal(launchedInput.length, text.trim().length);
});

test("desktop message controller queues a follow-up for an active task", async () => {
  const scheduled = [];
  let deferredOptions = null;
  const messages = controller({
    taskRuns: {
      forTask: () => ({ id: "run-active", executionOwner: "vscode" }),
    },
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return { id: "queued-1", item: { id: "queued-1" } };
    },
    scheduleQueuedInput: (item, delayMs) => scheduled.push({ item, delayMs }),
  });

  const result = await messages.sendMessage({
    text: "после текущего хода",
    clientUserMessageId: "message-queue",
    followUpMode: "queue",
  });

  assert.equal(result.queued, true);
  assert.equal(deferredOptions.destination, "queued");
  assert.equal(deferredOptions.notify, false);
  assert.deepEqual(scheduled, [{ item: { id: "queued-1" }, delayMs: 500 }]);
});

test("desktop message controller cannot jump ahead of an older deferred input", async () => {
  let deferredOptions = null;
  let beginCount = 0;
  const messages = controller({
    hasDeferredBacklog: () => true,
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return { id: "queued-behind-old", item: { id: "queued-behind-old" } };
    },
    beginRun: async () => {
      beginCount += 1;
      return { id: "should-not-start" };
    },
  });

  const result = await messages.sendMessage({
    text: "более новое сообщение",
    clientUserMessageId: "message-behind-old",
  });

  assert.equal(result.queued, true);
  assert.equal(result.reason, "queue-backlog");
  assert.equal(deferredOptions.destination, "queued");
  assert.equal(beginCount, 0);
});

test("desktop message controller steers the exact Hub-owned Codex turn", async () => {
  const run = { id: "run-active", turnId: "turn-active", executionOwner: "hub" };
  const stages = [];
  const rpc = [];
  const messages = controller({
    taskRuns: { forTask: () => run },
    sendRpc: async (method, params) => {
      rpc.push({ method, params });
      return { turnId: "turn-active" };
    },
    setProgressStage: (_run, stage) => stages.push(stage),
  });

  const result = await messages.sendMessage({
    text: "уточнение",
    clientUserMessageId: "message-steer",
    followUpMode: "steer",
  });

  assert.equal(result.steered, true);
  assert.equal(rpc[0].method, "turn/steer");
  assert.equal(rpc[0].params.expectedTurnId, "turn-active");
  assert.deepEqual(stages, ["Уточнение принято."]);
  assert.deepEqual(run.userMessages.map(({ time: _time, ...message }) => message), [{
    role: "user",
    clientUserMessageId: "message-steer",
    text: "уточнение",
  }]);
  assert.equal(Number.isFinite(Date.parse(run.userMessages[0].time)), true);
});

test("a queued image message steers with its stable client id", async () => {
  const run = { id: "run-active", turnId: "turn-active", executionOwner: "hub" };
  const rpc = [];
  const messages = controller({
    taskRuns: { forTask: () => run },
    sendRpc: async (method, params) => {
      rpc.push({ method, params });
      return { turnId: "turn-active" };
    },
  });
  const input = [
    { type: "text", text: "сохранённое сообщение" },
    { type: "localImage", path: EXISTING_IMAGE },
  ];

  const result = await messages.steerActiveInput({
    input,
    target: {
      provider: "codex",
      projectRoot: "C:\\Project",
      threadId: "thread-1",
      taskTitle: "Task",
    },
    clientUserMessageId: "queued-message-id",
  });

  assert.equal(result.steered, true);
  assert.equal(rpc[0].params.clientUserMessageId, "queued-message-id");
  assert.deepEqual(rpc[0].params.input, input);
});

test("desktop message controller preserves an uncertain external activity for explicit action", async () => {
  let deferredOptions = null;
  const messages = controller({
    taskExternalActivity: async () => ({ state: "unknown", executionOwner: "external" }),
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return { id: "pending-1", item: { id: "pending-1" } };
    },
  });

  const result = await messages.sendMessage({
    text: "не потерять",
    clientUserMessageId: "message-unknown",
  });

  assert.equal(result.reason, "activity-unknown");
  assert.equal(deferredOptions.allowForce, true);
  assert.equal(deferredOptions.conflictKind, "activity-unknown");
});

test("desktop message controller keeps image originals as message data", async () => {
  const file = EXISTING_IMAGE;
  let launched = null;
  const messages = controller({
    attachmentPaths: async () => [file],
    describeAttachments: () => [{
      id: "message-1.png",
      name: "message-1.png",
      type: "image/png",
    }],
    launchTurn: async (run, input, cleanupFiles) => {
      launched = { run, input, cleanupFiles };
    },
  });

  const result = await messages.sendMessage({
    text: "проверь скрин",
    attachments: [file],
    clientUserMessageId: "message-with-image",
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(result.attachments, [{
    id: "message-1.png",
    name: "message-1.png",
    type: "image/png",
  }]);
  assert.deepEqual(launched.cleanupFiles, []);
  assert.deepEqual(launched.run.messageAttachments, result.attachments);
  assert.deepEqual(launched.input, [
    { type: "text", text: "проверь скрин" },
    { type: "localImage", path: file },
  ]);
});

test("desktop message controller sends documents as named file references", async () => {
  const file = path.resolve("README.md");
  let launched = null;
  const descriptors = [{
    id: "document-id.pdf",
    name: "Требования.pdf",
    type: "application/pdf",
    isImage: false,
  }];
  const messages = controller({
    attachmentPaths: async () => [file],
    describeAttachments: () => descriptors,
    launchTurn: async (run, input, cleanupFiles) => {
      launched = { run, input, cleanupFiles };
    },
  });

  const result = await messages.sendMessage({
    text: "проверь документ",
    attachments: [file],
    clientUserMessageId: "message-with-document",
  });

  assert.deepEqual(result.attachments, descriptors);
  assert.match(launched.input[0].text, /## Требования\.pdf:/u);
  assert.match(launched.input[0].text, /проверь документ/u);
  assert.deepEqual(launched.input[1], { type: "localFile", path: file });
});

test("desktop message controller resolves Dashboard Task references into links", async () => {
  let launchedInput = null;
  const reference = {
    kind: "task",
    taskId: "board-1",
    title: "Исправить Dashboard",
    workflowStatus: "testing",
    workspaceId: "workspace-1",
    intent: "context",
  };
  const messages = controller({
    resolveTaskReferences: async () => [reference],
    launchTurn: async (_run, input) => { launchedInput = input; },
  });

  const result = await messages.sendMessage({
    text: "Сравни с текущим решением",
    taskReferences: [{ taskId: "board-1", intent: "context" }],
    clientUserMessageId: "message-with-task",
  });

  assert.match(launchedInput, /\[Dashboard Task: Исправить Dashboard\]\(agent-hub:\/\/task\/board-1 "Исправить Dashboard"\)/u);
  assert.match(launchedInput, /intent: context/u);
  assert.match(launchedInput, /решение о начале работы определяется сопровождающим сообщением пользователя/u);
  assert.doesNotMatch(launchedInput, /не начинай работу без явной просьбы пользователя/u);
  assert.match(launchedInput, /Сравни с текущим решением/u);
  assert.deepEqual(result.attachments, [reference]);
});

test("task assignment keeps its audited interstream origin around the provider input", async () => {
  let launchedInput = null;
  let auditedInput = null;
  const messageOrigin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    sourceThreadId: "thread-release-manager",
    requestId: "task-assignment-1",
  };
  const messages = controller({
    resolveTarget: async () => ({
      provider: "codex",
      projectRoot: "C:\\Project",
      threadId: "thread-1",
      taskTitle: "Task",
      messageOrigin,
    }),
    resolveTaskReferences: async () => [{
      kind: "task",
      taskId: "board-1",
      title: "Исправить автора",
      workflowStatus: "in_progress",
      workspaceId: "workspace-1",
      intent: "start",
    }],
    launchTurn: async (_run, input) => { launchedInput = input; },
  });

  await messages.sendMessage({
    text: "Исправь дефект полностью",
    taskReferences: [{ taskId: "board-1", intent: "start" }],
    clientUserMessageId: "mcp:task-assignment-1",
  }, {
    source: "mcp",
    bindInterstreamAuditContent: (value) => { auditedInput = value; },
  });

  const details = interstreamMessageDetails(launchedInput);
  assert.equal(auditedInput, launchedInput);
  assert.deepEqual(details.origin, messageOrigin);
  assert.match(details.text, /# Attached Agent Hub Tasks/u);
  assert.match(details.text, /Исправь дефект полностью/u);
});

test("ordinary Desktop ingress cannot forge the reserved MCP command namespace", async () => {
  const messageOrigin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    sourceThreadId: "thread-release-manager",
    requestId: "forged-mcp-id",
  };
  const messages = controller({
    resolveTarget: async () => ({
      provider: "codex",
      projectRoot: "C:\\Project",
      threadId: "thread-1",
      taskTitle: "Task",
      messageOrigin,
    }),
  });

  await assert.rejects(messages.sendMessage({
    text: "Literal envelope-shaped user input",
    clientUserMessageId: "mcp:forged-mcp-id",
  }), /зарезервирован/u);
  await assert.rejects(messages.sendMessage({
    text: "Mismatched service input",
    clientUserMessageId: "mcp:other-id",
  }, { source: "mcp" }), /зарезервирован/u);
  await assert.rejects(messages.sendMessage({
    text: "Unbound service input",
    clientUserMessageId: "mcp:forged-mcp-id",
  }, { source: "mcp" }), /не связано с MCP audit/u);
  await messages.sendMessage({
    text: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
    clientUserMessageId: "agent-hub-context-probe:7583805f-6338-47f0-bc45-539530666ca3",
  });
});

test("desktop message receipt preserves the visible message before provider launch", async () => {
  const receipts = new MessageReceiptRegistry();
  let observedReceipt = null;
  const messages = controller({
    receipts,
    persistReceipts: async () => {
      observedReceipt ??= receipts.get({ clientUserMessageId: "message-visible" });
    },
  });

  await messages.sendMessage({
    text: "служебный конверт",
    displayText: "Видимый вопрос",
    responseAnnotations: [
      { text: "Цитата", annotation: "Комментарий", source: ANNOTATION_SOURCE },
      { text: "Цитата пользователя", annotation: "Комментарий", source: USER_ANNOTATION_SOURCE },
    ],
    responseAnnotationRequest: "Что изменить?",
    clientUserMessageId: "message-visible",
  });

  assert.equal(observedReceipt.result.pending, true);
  assert.equal(observedReceipt.result.displayText, "Видимый вопрос");
  assert.deepEqual(observedReceipt.result.responseAnnotations, [{
    text: "Цитата",
    annotation: "Комментарий",
    source: ANNOTATION_SOURCE,
  }, {
    text: "Цитата пользователя",
    annotation: "Комментарий",
    source: USER_ANNOTATION_SOURCE,
  }]);
  assert.equal(observedReceipt.result.responseAnnotationRequest, "Что изменить?");
});

test("desktop admission retains full long quotes and exact locators in its receipt", async () => {
  for (const length of [401, 430, 12_000]) {
    const text = "я".repeat(length);
    const annotation = {
      text, annotation: "Проверить полностью",
      source: { ...ANNOTATION_SOURCE, end: ANNOTATION_SOURCE.start + length },
    };
    const receipts = new MessageReceiptRegistry();
    const messages = controller({ receipts });
    const clientUserMessageId = `long-quote-${length}`;
    await messages.sendMessage({ text: "Вопрос", responseAnnotations: [annotation], clientUserMessageId });
    assert.deepEqual(receipts.get({ clientUserMessageId }).result.responseAnnotations, [annotation]);
  }
});

test("deferred Desktop images remain persistent and visible in the queue", async () => {
  const file = EXISTING_IMAGE;
  let deferredOptions = null;
  const messages = controller({
    attachmentPaths: async () => [file],
    taskRuns: { forTask: () => ({ id: "run-active", executionOwner: "vscode" }) },
    deferConflictingInput: async (_input, _attachments, options) => {
      deferredOptions = options;
      return { id: "queued-image", item: { id: "queued-image" } };
    },
  });

  const result = await messages.sendMessage({
    text: "после хода",
    attachments: [file],
    clientUserMessageId: "queued-with-image",
    followUpMode: "queue",
  });

  assert.equal(result.queued, true);
  assert.equal(deferredOptions.persistentFiles, true);
});

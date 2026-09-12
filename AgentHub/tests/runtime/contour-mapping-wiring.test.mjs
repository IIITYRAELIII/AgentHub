import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RuntimeStateStore } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { MessageReceiptRegistry, messageRequestFingerprint } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { createContourCommandMapping } from "../../src/infrastructure/filesystem/test-contour-command-mapping.mjs";
import { RecordingContourProvider } from "../../src/providers/recording-contour-provider.mjs";
import { createDesktopMessageController } from "../../src/interfaces/desktop/desktop-message-controller.mjs";
import { createDesktopRouterComposition } from "../../src/composition/desktop-router-composition.mjs";
import { DeferredInputService } from "../../src/application/deferred-input-service.mjs";
import { DeferredInputStore, deferredInputTaskKey } from "../../src/application/deferred-input-store.mjs";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { TaskIdentityResolver } from "../../src/application/task-identity-resolver.mjs";
import { ClientTaskSelectionService } from "../../src/application/client-task-selection-service.mjs";
import { HubSessionState } from "../../src/runtime/hub-session-state.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "contour-wiring-"));
  const dataDir = path.join(root, "data"); const recording = path.join(root, "recording");
  await mkdir(dataDir); await mkdir(recording);
  const sourceRoot = path.join(root, "unopened-source-project");
  const sourceAttachments = path.join(root, "unopened-source-attachments");
  const marker = { schemaVersion: 1, kind: "literal-recording-provider", root: recording, externalEffects: "deny",
    sources: [{ source: sourceRoot, kind: "project" }, { source: sourceAttachments, kind: "attachment" }],
    threads: [{ provider: "codex", id: "thread-canonical", streamId: "stream-canonical", cwd: sourceRoot }] };
  await writeFile(path.join(recording, "recording-provider.json"), JSON.stringify(marker));
  return { root, dataDir, recording, sourceRoot, sourceAttachments };
}

test("canonical receipt -> real durable queue -> recording launch -> reload -> same-ID retry has one provider effect", async () => {
  const f = await fixture();
  let store; let provider; let providerEffects = 0;
  try {
    const id = "original-user-message";
    const target = { provider: "codex", streamId: "stream-canonical", threadId: "thread-canonical", projectRoot: f.sourceRoot, telegramDeliveryRequested: false, clientSource: "desktop-control" };
    const originalText = `[child:] [tool:] буквальный текст ${"Цитата ".repeat(8000)}`.trim();
    const descriptor = { id: "attachment-canonical.txt", name: "document.txt", type: "text/plain" };
    const receiptFile = path.join(f.dataDir, "outer-receipts.json");
    const outerContext = { source: "desktop-control", commandId: id };
    let operationalFile; let operationalRoot;
    async function open() {
      store = new RuntimeStateStore({ dataDir: f.dataDir });
      const loaded = (await store.load()).value ?? {};
      const receipts = new MessageReceiptRegistry(); receipts.restore(loaded.desktopMessageReceipts ?? []);
      const queue = new DeferredInputStore();
      for (const item of loaded.pendingInputs ?? []) queue.put(item);
      for (const item of loaded.queuedInputs ?? []) queue.put(item, "queued");
      const host = new HubSessionState(); host.restore(loaded);
      const mapping = createContourCommandMapping({ root: f.recording, readCommand: (commandId) => store.messageCommand(commandId) });
      operationalRoot = mapping.paths.map(f.sourceRoot, "project");
      operationalFile = mapping.paths.map(path.join(f.sourceAttachments, descriptor.id), "attachment");
      await mkdir(path.dirname(operationalFile), { recursive: true });
      await mkdir(operationalRoot, { recursive: true });
      await writeFile(operationalFile, "synthetic attachment bytes");
      provider = new RecordingContourProvider({ root: f.recording, provider: "codex" });
      const save = () => store.save({ clientTaskSelections: host.clientTaskSelectionsSnapshot(),
        pendingInputs: [...queue.pending.values()], queuedInputs: [...queue.queued.values()],
        desktopMessageReceipts: receipts.snapshot(), activeRuns: [] });
      const identity = new TaskIdentityResolver({ canonicalProjectRoot: mapping.canonicalPath,
        projects: [{ name: "Captured", path: operationalRoot }], selectionStore: { activeProjectRoot: operationalRoot },
        findContainingProject: (projects, root) => projects.find((project) => project.path === root) });
      const selection = new ClientTaskSelectionService({ sessionState: host,
        fallbackSelection: () => target, fallbackTitle: () => "Original Thread",
        findProject: (root) => identity.findProject(root),
        catalogEntries: () => [mapping.target({ ...target, projectRoot: operationalRoot })],
        catalogEntryIsSelected: (entry, selected) => entry.threadId === selected.threadId && entry.projectRoot === selected.projectRoot,
        preferences: { current: () => ({}) }, samePath: (a, b) => a === b, save });
      const defer = new DeferredInputService({ store: queue, persist: save, removeFiles: async () => { throw new Error("unexpected cleanup"); }, notify: async () => { throw new Error("unexpected delivery"); },
        persistIntake: (item, destination) => store.saveDeferredIntake({ item, destination, receipt: receipts.get(item) }) });
      const coordinator = new RunCoordinator({ taskRuns: { forTask: () => null }, providers: { call: async () => { throw new Error("unexpected provider route"); } },
        externalActivity: async () => ({ state: "inactive" }), repositoryConflict: async () => null,
        deferInput: (...args) => defer.defer(...args), beginRun: async (_, binding) => ({ ...binding, id: "isolated-run", status: "running" }),
        rollbackAdmission: async () => {},
        launchTurn: async (run, input) => {
          const committed = store.messageCommand(run.clientUserMessageId);
          assert.ok(committed?.fingerprint, "canonical ledger commit precedes provider effect");
          assert.equal(run.projectRoot, f.sourceRoot);
          const started = provider.start({ threadId: run.threadId, clientUserMessageId: run.clientUserMessageId, input });
          if (!started.duplicate) providerEffects++;
          run.turnId = started.turn.id;
        } });
      const controller = createDesktopMessageController({ commandMapping: mapping,
        attachmentPaths: async () => [operationalFile], describeAttachments: () => [descriptor],
        resolveTarget: async () => ({ ...target, projectRoot: operationalRoot }), receipts, persistReceipts: save,
        runCoordinator: coordinator, durableIntake: true });
      const handlers = new Proxy({ sendMessage: controller.sendMessage, snapshot: async () => ({ selected: target }) }, {
        get: (object, name) => object[name] ?? (async () => { throw new Error(`unexpected handler ${String(name)}`); }),
      });
      const router = createDesktopRouterComposition({ handlers, receiptFile, canonicalizeRequest: mapping.request,
        commands: { settingTarget: () => null, dispatch: async (type, params) => {
          assert.equal(type, "task.select"); return selection.select(params, { clientId: "desktop-test" });
        } } });
      return { receipts, queue, host, mapping, selection, coordinator, controller, router, save };
    }
    let runtime = await open();
    await runtime.router.handleDesktopControl({ action: "select-task", params: { ...target, projectRoot: operationalRoot }, context: { ...outerContext, commandId: "selection-original" } });
    assert.equal(runtime.host.clientTaskSelection("desktop-test").projectRoot, f.sourceRoot);
    const params = { ...target, text: originalText, attachments: [descriptor.id], clientUserMessageId: id };
    const accepted = await runtime.router.handleDesktopControl({ action: "send-message", params, context: outerContext });
    assert.equal(accepted.accepted, true); assert.equal(accepted.queued, true); assert.equal(providerEffects, 0);
    const committed = store.messageCommand(id);
    const fingerprint = await messageRequestFingerprint({ text: originalText, attachmentIdentities: [descriptor] });
    assert.equal(committed.fingerprint, fingerprint);
    assert.equal(committed.item.projectRoot, f.sourceRoot);
    assert.equal(committed.item.input[1].path, path.join(f.sourceAttachments, descriptor.id));
    assert.ok(committed.item.input[0].text.includes(originalText));
    assert.equal(committed.item.input[0].text.includes(operationalFile), false, "generated document header uses canonical path");
    assert.equal(deferredInputTaskKey(committed.item), deferredInputTaskKey(target));
    const started = await runtime.coordinator.startDeferred(runtime.queue.get(committed.item.id));
    assert.equal(providerEffects, 1);
    const recorded = provider.command(id);
    assert.deepEqual(recorded.canonical.input, committed.item.input);
    assert.equal(recorded.execution.projectRoot, operationalRoot);
    assert.equal(recorded.execution.input[1].path, operationalFile);
    assert.equal(await readFile(recorded.execution.input[1].path, "utf8"), "synthetic attachment bytes");
    await store.transitionMessageCommand({ clientUserMessageId: id, state: "started", expectedStates: ["queued"], result: { accepted: true, providerAccepted: true, runId: started.id, turnId: started.turnId, threadId: target.threadId } });
    runtime.queue.delete(committed.item.id); await runtime.save();
    const outerBefore = await readFile(receiptFile, "utf8");
    await store.close(); store = null; provider.close(); provider = null;
    runtime = await open();
    assert.equal(store.messageCommand(id).fingerprint, fingerprint);
    assert.equal(runtime.host.clientTaskSelection("desktop-test").projectRoot, f.sourceRoot);
    assert.equal(runtime.queue.size, 0, "started command does not return to dispatch queue on reload");
    const retry = await runtime.router.handleDesktopControl({ action: "send-message", params: { ...params, projectRoot: operationalRoot }, context: outerContext });
    assert.deepEqual(retry, accepted);
    assert.equal(await readFile(receiptFile, "utf8"), outerBefore, "outer receipt fingerprint/bytes unchanged after mapped retry");
    const innerRetry = await runtime.controller.sendMessage({ ...params, projectRoot: operationalRoot }, outerContext);
    assert.equal(innerRetry.providerAccepted, true);
    assert.equal(providerEffects, 1);
    const replay = provider.start({ threadId: target.threadId, clientUserMessageId: id, input: store.messageCommand(id).item.input });
    assert.equal(replay.duplicate, true); assert.equal(replay.turn.id, started.turnId);
    assert.equal(provider.thread(target.threadId).turns.length, 1);
    await assert.rejects(runtime.controller.sendMessage({ ...params, text: "same ID, altered prompt" }, outerContext), { code: "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH" });
    assert.equal(provider.thread(target.threadId).turns.length, 1);
  } finally {
    await store?.close(); provider?.close(); await rm(f.root, { recursive: true, force: true });
  }
});

test("same-ID typed alias recovery preserves full annotations and exact canonical path spelling", async () => {
  const f = await fixture();
  try {
    const initial = createContourCommandMapping({ root: f.recording });
    const original = [{ type: "text", text: "[child:] do not execute", annotations: [{ text: "ц".repeat(80000), source: { contentHash: "sha256:exact", threadId: "thread-canonical" } }] },
      { type: "localImage", path: path.join(f.sourceAttachments, "image.png") }];
    const lookup = (id) => id === "same-id" ? { clientUserMessageId: id, item: { clientUserMessageId: id, input: original } } : null;
    const mapping = createContourCommandMapping({ root: f.recording, readCommand: lookup });
    const operational = initial.paths.input(original);
    assert.deepEqual(mapping.input(operational, "same-id"), original);
    assert.deepEqual(initial.paths.input(mapping.input(operational, "same-id")), operational);
    assert.throws(() => mapping.target({ provider: "codex", threadId: "thread-canonical", streamId: "foreign", projectRoot: f.sourceRoot }), /Stream differs/);
    assert.throws(() => mapping.canonicalPath(path.join(f.root, "unmapped")), /Unmapped/);
    const changed = structuredClone(operational); changed[0].annotations[0].text += "edited";
    assert.throws(() => mapping.input(changed, "same-id"), { code: "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

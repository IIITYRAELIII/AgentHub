import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importCompositionWithPorts } from "../helpers/composition-ports.fixture.mjs";
import { createAgentHubDeferredPorts } from "../../src/composition/agent-hub-deferred-ports.mjs";
import { DesktopAttachmentService } from "../../src/interfaces/desktop/desktop-attachment-service.mjs";
import { createCodexAssistantAttachmentImporter } from "../../src/providers/codex/codex-assistant-attachments.mjs";
import { createCodexTerminalAttachmentResolver } from "../../src/providers/codex/codex-terminal-attachments.mjs";
import { readCodexRolloutActivityOnCurrentThread } from "../../src/providers/codex/codex-rollout-activity.mjs";
import { CodexRunFinalizer } from "../../src/providers/codex/codex-run-finalizer.mjs";
import { TurnEndNotificationRegistry } from "../../src/application/turn-end-notifications.mjs";
import { TerminalTurnCommitService } from "../../src/application/terminal-turn-commit-service.mjs";
import { TurnEndDeliveryService } from "../../src/application/turn-end-delivery-service.mjs";
import { ManagedRunHistoryService } from "../../src/application/managed-run-history-service.mjs";
import { mergeActiveTaskHistory } from "../../src/application/task-history.mjs";
import { ProviderTurnTerminalStore } from "../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { LocalTaskSyncStore } from "../../src/infrastructure/persistence/task-sync-store.mjs";

// Evaluate the unchanged production root up to its provider factory boundary.
// Direct startup dependencies are inert ports: no configuration, listener,
// provider, production database or source-text extraction is used by this test.
async function rootProviderInputs(root, importAttachments) {
  const deferred = createAgentHubDeferredPorts();
  deferred.ports.providerRuntime.bind(Object.fromEntries(
    Object.keys(deferred.ports.providerRuntime.api).map(name => [name,
      name === "importCodexAssistantAttachments" ? importAttachments : () => {}]),
  ));
  const reachedProvider = new Error("reached isolated provider boundary");
  let captured;
  await assert.rejects(importCompositionWithPorts(
    new URL("../../src/composition/agent-hub-composition.mjs", import.meta.url), {
      "../infrastructure/filesystem/config.mjs": {
        AGENT_HUB_ROOT: root, canonicalizeProjectRoots() {},
        loadConfig: () => ({ provider: "codex", miniApp: { enabled: false }, configPath: path.join(root, "config.json") }),
      },
      "./agent-hub-deferred-ports.mjs": { createAgentHubDeferredPorts: () => deferred },
      "./hub-static-settings.mjs": { createHubStaticSettings: () => ({}) },
      "./infrastructure-composition.mjs": { createHubInfrastructure: () => ({}) },
      "./command-trace-composition.mjs": {
        measureStartupBeforeTrace: async (_stage, action) => ({ value: await action(), record() {} }),
      },
      "./state-composition.mjs": { createStateComposition: () => ({}) },
      "../application/provider-model-catalog-service.mjs": { ProviderModelCatalogService: class {} },
      "./provider-application-composition.mjs": {
        createProviderApplicationComposition: (inputs) => { captured = inputs; throw reachedProvider; },
      },
    }), error => error === reachedProvider);
  return captured;
}

test("production root carries generated images through completion, history and reopen", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-generated-root-"));
  const codexHome = path.join(root, "codex");
  const generatedRoot = path.join(codexHome, "generated_images");
  await mkdir(generatedRoot, { recursive: true });
  let history;
  t.after(async () => {
    await history?.close();
    await rm(root, { recursive: true, force: true });
  });
  const identity = { provider: "codex", threadId: "thread-generated", turnId: "turn-generated" };
  // Owned, small synthetic bytes; never generate or display incident images.
  const bytes = [1, 2, 3].map(index => Buffer.from(`synthetic-image-${index}`));
  const files = bytes.map((_value, index) => path.join(generatedRoot, `exec-${index}.png`));
  await Promise.all(files.map((file, index) => writeFile(file, bytes[index])));
  const rollout = path.join(root, "rollout.jsonl");
  const rows = files.map((savedPath, index) => ({
    type: "event_msg", payload: { type: "item_completed", turn_id: identity.turnId,
      item: { type: "Extension", kind: "image_gen.generation", id: `exec-${index}`,
        status: "completed", failure: null, savedPath } },
  }));
  rows.push({ type: "event_msg", payload: { type: "task_complete", turn_id: identity.turnId,
    last_agent_message: "Three concepts" } });
  await writeFile(rollout, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const attachments = new DesktopAttachmentService({ runtimeCommandRoot: root, projectRoot: root,
    codexHome, assistantAttachmentImporterFactory: createCodexAssistantAttachmentImporter });
  t.after(() => attachments.close());
  const inputs = await rootProviderInputs(root, values => attachments.importCodex(values));
  const resolveTerminalAttachments = createCodexTerminalAttachmentResolver({
    knownRolloutPath: () => rollout,
    readRolloutActivity: readCodexRolloutActivityOnCurrentThread,
    importAttachments: inputs.api.importCodexAssistantAttachments,
    retryDelaysMs: [0],
  });
  history = new LocalTaskSyncStore({ filePath: path.join(root, "task-sync.json"),
    databaseFile: path.join(root, "journal.sqlite") });
  await history.load();
  const terminals = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir: root }) });
  const managedHistory = new ManagedRunHistoryService({ taskSyncStore: history,
    mergeActiveHistory: mergeActiveTaskHistory, hubExecutionOwner: "hub", terminalCommits: terminals,
    nowIso: () => new Date().toISOString(), nowMs: Date.now });
  const run = { ...identity, id: "run-generated", streamId: "stream-generated", projectRoot: root,
    status: "running", executionOwner: "hub", startedAt: new Date().toISOString(),
    promptPreview: "Three concepts", responseText: "Live prefix", responseAttachments: [],
    rolloutChangeTrackingKnown: true, telegramDeliveryRequested: false };
  await managedHistory.persist(run);
  const notifications = new TurnEndNotificationRegistry();
  const delivery = new TurnEndDeliveryService({ notifications, terminalCommits: terminals,
    taskRuns: { forEvent: () => null }, persistHistory: (...args) => managedHistory.persist(...args),
    projectTurn: async () => null, rememberLastMessage() {}, rememberSeenTurn() {}, saveState: async () => {} });
  const finalizer = new CodexRunFinalizer({ notifications, turnStarts: new Map(),
    discardContextCompaction: async () => false, refreshTaskDiff: async () => {},
    runTitle: () => "Generated concepts", currentChatId: () => null, defaultNotificationChatId: () => null,
    resolveTerminalAttachments, commitTerminal: (...args) => delivery.commit(...args),
    deliverTerminal: (...args) => delivery.deliverOutbox(...args),
    markRunCompleted: async () => { run.status = "completed"; }, completeRun: async () => {}, saveState: async () => {} });
  await finalizer.finalize(run, { answer: "Three concepts", deliver: false });
  const durable = await terminals.get(identity);
  assert.equal(durable.payload.completion.responseAttachments.length, 3,
    "root provider wiring must not silently discard recognized generated paths");
  assert.deepEqual(durable.payload.history.responseAttachments, durable.payload.completion.responseAttachments);
  assert.equal(run.responseAttachments.length, 3);
  await history.close();
  history = new LocalTaskSyncStore({ filePath: path.join(root, "task-sync.json"), databaseFile: path.join(root, "journal.sqlite") });
  await history.load();
  const final = history.history(run).find(turn => turn.id === identity.turnId);
  const message = final.messages.find(item => item.role === "agent" && item.attachments?.length);
  assert.deepEqual(message.attachments, durable.payload.completion.responseAttachments);
  const reopened = await new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir: root }) }).get(identity);
  assert.deepEqual(reopened.payload.completion.responseAttachments, message.attachments);
  const digest = value => createHash("sha256").update(value).digest("hex");
  assert.deepEqual(await Promise.all(message.attachments.map(async item => digest(
    await readFile(await attachments.pathById(item.id))))), bytes.map(digest));
  assert.deepEqual(await resolveTerminalAttachments(run, "foreign-turn"), [], "exact turn provenance is retained");
  assert.equal((await terminals.get({ ...identity, turnId: "foreign-turn" })), null);
});

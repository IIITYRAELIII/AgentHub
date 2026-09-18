import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import { TerminalTurnCommitService } from "../../../src/application/terminal-turn-commit-service.mjs";
import { TurnEndDeliveryService } from "../../../src/application/turn-end-delivery-service.mjs";
import { ProviderTurnTerminalStore } from "../../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { createCodexAssistantAttachmentImporter } from "../../../src/providers/codex/codex-assistant-attachments.mjs";
import {
  CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES,
  codexTerminalAttachmentSources,
  createCodexTerminalAttachmentResolver,
} from "../../../src/providers/codex/codex-terminal-attachments.mjs";
import {
  parseCodexRolloutActivity,
  readCodexRolloutActivityOnCurrentThread,
} from "../../../src/providers/codex/codex-rollout-activity.mjs";
import { CodexLifecycleController } from "../../../src/providers/codex/codex-lifecycle-controller.mjs";
import { handleCodexStopHook } from "../../../src/providers/codex/codex-stop-hook.mjs";
import { readCodexTurnUsage } from "../../../src/providers/codex/codex-turn-usage.mjs";

test("terminal resolver imports all ideate outputs from a production-shaped rollout", async () => {
  const imported = [];
  const resolver = createCodexTerminalAttachmentResolver({
    knownRolloutPath: async () => "C:/rollout.jsonl",
    readRolloutActivity: async (_rolloutPath, options) => {
      assert.equal(options.freshnessMs, Number.POSITIVE_INFINITY);
      assert.equal(options.tailBytes, CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES);
      assert.equal(options.reparseTail, true);
      const output = (savedPath) => ({
        type: "response_item",
        payload: {
          type: "function_call_output",
          output: [
            { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
            {
              type: "input_text",
              text: `Generated images are saved to C:/generated as ${savedPath} by default.`,
            },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-ideate" },
        },
      });
      return parseCodexRolloutActivity([
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-ideate" } },
        output("C:/generated/one.png"),
        { type: "compacted", payload: { turn_id: "internal-compaction" } },
        output("C:/generated/two.png"),
        output("C:/generated/three.png"),
        { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-ideate", last_agent_message: "Три концепта Rain" } },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
    },
    importAttachments: async (sources) => {
      imported.push(...sources);
      return sources.map((source) => ({
        id: `codex-generated-${source.value.split("/").at(-1)}`,
        name: "Изображение",
        type: "image/png",
      }));
    },
  });

  const attachments = await resolver({ threadId: "thread-1" }, "turn-ideate");

  assert.deepEqual(imported.map((source) => source.value), [
    "C:/generated/one.png",
    "C:/generated/two.png",
    "C:/generated/three.png",
  ]);
  assert.deepEqual(attachments.map((attachment) => attachment.id), [
    "codex-generated-one.png",
    "codex-generated-two.png",
    "codex-generated-three.png",
  ]);
});

test("terminal repair recovers six outputs across the cold tail and preserves them after reopen", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-terminal-six-images-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const generatedRoot = path.join(root, "generated_images");
  const attachmentRoot = path.join(root, "attachments");
  const rollout = path.join(root, "rollout.jsonl");
  const threadId = "thread-six-images";
  const turnId = "turn-six-images";
  await mkdir(generatedRoot, { recursive: true });
  const imagePaths = Array.from({ length: 6 }, (_, index) => (
    path.join(generatedRoot, `exec-${index + 1}.png`)
  ));
  const expectedIds = imagePaths.map((source) => (
    `codex-generated-${createHash("sha256").update(path.resolve(source)).digest("hex")}.png`
  ));
  await Promise.all(imagePaths.map((file, index) => writeFile(file, `image-${index + 1}`)));
  const imageEvent = (savedPath, index) => ({
    timestamp: `2026-09-11T22:3${index}:00Z`,
    type: "event_msg",
    payload: {
      type: "item_completed",
      thread_id: threadId,
      turn_id: turnId,
      item: {
        type: "Extension",
        kind: "image_gen.generation",
        id: `exec-${index + 1}`,
        status: "completed",
        failure: null,
        savedPath,
      },
    },
  });
  const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await writeFile(rollout, jsonl([
    ...imagePaths.slice(0, 3).map(imageEvent),
    { type: "response_item", payload: { type: "reasoning", summary: "x".repeat(
      CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES + 1024,
    ) } },
    ...imagePaths.slice(3).map((savedPath, index) => imageEvent(savedPath, index + 3)),
    { timestamp: "2026-09-11T22:38:04Z", type: "event_msg",
      payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Шесть" } },
  ]));

  const importAttachments = createCodexAssistantAttachmentImporter({
    attachmentRoot,
    temporaryRoot: root,
    generatedImageRoot: generatedRoot,
  });
  const partial = await importAttachments(imagePaths.slice(3).map((value) => ({
    type: "generated-path",
    value,
  })));
  const completion = {
    provider: "codex",
    threadId,
    turnId,
    status: "completed",
    finalAnswer: "Шесть",
    completedAt: "2026-09-11T22:38:04Z",
    imageGenerationCount: 6,
    responseAttachments: partial,
  };
  const firstTerminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir: root }),
  });
  const first = await firstTerminal.commit(completion, {
    run: {
      id: "run-six-images",
      streamId: "stream-six-images",
      userMessages: [{ role: "user", text: "Шесть концептов" }],
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
  await new TurnEndDeliveryService({
    ...deliveryDependencies,
    terminalCommits: firstTerminal,
  }).deliverOutbox(first.outbox);

  const restartedTerminal = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir: root }),
  });
  const restartedDelivery = new TurnEndDeliveryService({
    ...deliveryDependencies,
    terminalCommits: restartedTerminal,
  });
  const resolver = createCodexTerminalAttachmentResolver({
    readRolloutActivity: readCodexRolloutActivityOnCurrentThread,
    importAttachments,
    retryDelaysMs: [0],
  });
  let resolutions = 0;
  let resolvedAttachments = [];
  const repair = () => restartedDelivery.reconcileResponseAttachments(completion, {
    expectedCount: 6,
    resolveAttachments: async () => {
      resolutions += 1;
      resolvedAttachments = await resolver({
        threadId,
        rolloutPath: rollout,
        historicalRecovery: true,
      }, turnId);
      return resolvedAttachments;
    },
  });
  const repaired = await repair();
  const replay = await repair();
  const reopened = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir: root }),
  });
  const durable = await reopened.get(completion);

  assert.equal(partial.length, 3);
  assert.equal(repaired.enriched, true);
  assert.equal(replay.enriched, false);
  assert.equal(resolutions, 1);
  assert.deepEqual(resolvedAttachments.map((item) => item.id), expectedIds);
  assert.deepEqual(projected.at(-1).responseAttachments.map((item) => item.id), expectedIds);
  assert.deepEqual(durable.payload.completion.responseAttachments.map((item) => item.id), expectedIds);
  assert.deepEqual(durable.payload.history.responseAttachments.map((item) => item.id), expectedIds);
  assert.equal((await readdir(attachmentRoot)).length, 6);
});

test("late verified nested exec outputs enrich the exact delivered terminal and survive replay", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-terminal-late-exec-images-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const generatedRoot = path.join(root, "generated_images");
  const attachmentRoot = path.join(root, "attachments");
  const rollout = path.join(root, "rollout.jsonl");
  const identity = {
    provider: "codex",
    threadId: "thread-late-exec-images",
    turnId: "turn-late-exec-images",
  };
  await mkdir(projectRoot, { recursive: true });
  await mkdir(generatedRoot, { recursive: true });
  const imageBytes = [1, 2, 3].map((index) => Buffer.from(`png-output-${index}`));
  const imagePaths = imageBytes.map((_bytes, index) => (
    path.join(generatedRoot, `exec-${index + 1}.png`)
  ));
  await Promise.all(imagePaths.map((file, index) => writeFile(file, imageBytes[index])));
  const exact = (payload) => ({
    ...payload,
    internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
  });
  const outputBlocks = [{ type: "input_text", text: "Script completed" }];
  for (const [index, generatedPath] of imagePaths.entries()) {
    outputBlocks.push(
      { type: "input_text", text: `Variant ${index + 1}` },
      { type: "input_image", image_url: `data:image/png;base64,${imageBytes[index].toString("base64")}` },
      {
        type: "input_text",
        text: `Generated images are saved to ${generatedRoot} as ${generatedPath} by default.`,
      },
    );
  }
  const rows = [
    {
      timestamp: "2026-09-13T20:10:20.455Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: identity.turnId },
    },
    {
      timestamp: "2026-09-13T20:10:51.817Z",
      type: "response_item",
      payload: exact({
        type: "custom_tool_call",
        name: "exec",
        call_id: "call-late-exec-images",
        input: "const result = await tools.image_gen__imagegen({prompt: 'three'}); generatedImage(result);",
      }),
    },
    ...imagePaths.map((savedPath, index) => ({
      timestamp: `2026-09-13T20:11:${String(11 + index).padStart(2, "0")}.000Z`,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: identity.threadId,
        turn_id: identity.turnId,
        item: {
          type: "Extension",
          kind: "image_gen.generation",
          id: `exec-${index + 1}`,
          status: "completed",
          result: outputBlocks[index * 3 + 2].image_url,
          failure: null,
          savedPath,
        },
      },
    })),
    {
      timestamp: "2026-09-13T20:11:57.861Z",
      type: "response_item",
      payload: exact({
        type: "custom_tool_call_output",
        call_id: "call-late-exec-images",
        output: outputBlocks,
      }),
    },
    {
      timestamp: "2026-09-13T20:12:07.561Z",
      type: "response_item",
      payload: exact({
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Три фона для Котла" }],
      }),
    },
    {
      timestamp: "2026-09-13T20:12:07.731Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: identity.turnId,
        last_agent_message: "Три фона для Котла",
      },
    },
  ];
  await writeFile(rollout, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const terminalCommits = new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir: root }),
  });
  const initial = await terminalCommits.commit({
    ...identity,
    projectRoot,
    status: "completed",
    finalAnswer: "Три фона для Котла",
    completedAt: "2026-09-13T20:12:07.731Z",
    responseAttachments: [],
  }, {
    run: {
      id: "run-late-exec-images",
      streamId: "stream-late-exec-images",
      userMessages: [{ role: "user", text: "Сделай три фона" }],
    },
  });
  const historyProjections = [];
  const delivery = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} },
    taskRuns: { forEvent: () => null },
    terminalCommits,
    persistHistory: async (history) => { historyProjections.push(structuredClone(history)); },
    projectTurn: async () => null,
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    logger: { error() {} },
  });
  await delivery.deliverOutbox(initial.outbox);

  const importAttachments = createCodexAssistantAttachmentImporter({
    attachmentRoot,
    temporaryRoot: root,
    generatedImageRoot: generatedRoot,
  });
  const resolveTerminalAttachments = createCodexTerminalAttachmentResolver({
    readRolloutActivity: readCodexRolloutActivityOnCurrentThread,
    importAttachments,
    retryDelaysMs: [0],
  });
  const managedRun = { status: "completed" };
  const controller = new CodexLifecycleController({
    config: { projects: [{ path: projectRoot }], dataDir: root },
    findProject: (value) => path.resolve(value) === path.resolve(projectRoot)
      ? { path: projectRoot }
      : null,
    codexTurnStarts: new Map(),
    setBoundedMapValue: (map, key, value) => map.set(key, value),
    setHookReceipt() {},
    taskRuns: { forEvent: () => managedRun, reindex() {} },
    saveState: async () => {},
    taskTitle: async () => "Images",
    taskGitDiff: async () => "",
    turnEndNotifications: {
      hasDelivered: () => true,
      recordCompletion: () => null,
    },
    resolveTerminalAttachments,
    repairTurnEndAttachments: (target, options) => (
      delivery.reconcileResponseAttachments(target, options)
    ),
    defaultNotificationChatId: () => null,
    projectTurnUsageToWorkLog: async () => null,
    rememberLastTaskMessage() {},
    lastSeenTaskTurnIds: new Map(),
    deliverTurnEndNotification: async () => {},
  });
  const forward = (command, args, options) => controller.handle({
    command,
    args,
    cwd: options.cwd,
    environment: options.environment,
  });
  const hookInput = {
    hook_event_name: "Stop",
    session_id: identity.threadId,
    turn_id: identity.turnId,
    cwd: projectRoot,
    transcript_path: rollout,
  };

  const firstHook = await handleCodexStopHook(hookInput, {
    readUsage: readCodexTurnUsage,
    forward,
  });
  const afterFirst = await new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir: root }),
  }).get(identity);
  const secondHook = await handleCodexStopHook(hookInput, {
    readUsage: readCodexTurnUsage,
    forward,
  });
  const afterReplay = await new TerminalTurnCommitService({
    store: new ProviderTurnTerminalStore({ dataDir: root }),
  }).get(identity);
  const durableAttachments = afterFirst.payload.completion.responseAttachments;

  assert.equal(firstHook.payload.imageGenerationCount, 0);
  assert.equal(firstHook.payload.generatedImageSources.length, 3);
  assert.equal(JSON.stringify(firstHook.payload).includes("base64"), false);
  assert.deepEqual(secondHook.payload.generatedImageSources, firstHook.payload.generatedImageSources);
  assert.equal(afterFirst.terminalRevision, 2);
  assert.equal(afterReplay.terminalRevision, 2);
  assert.deepEqual(afterFirst.payload.history.responseAttachments, durableAttachments);
  assert.deepEqual(afterReplay.payload.completion.responseAttachments, durableAttachments);
  assert.equal(durableAttachments.length, 3);
  assert.equal(historyProjections.length, 2);
  assert.deepEqual(historyProjections[1].responseAttachments, durableAttachments);
  assert.deepEqual(await Promise.all(durableAttachments.map(async (attachment) => (
    createHash("sha256").update(await readFile(path.join(attachmentRoot, attachment.id))).digest("hex")
  ))), imageBytes.map((bytes) => createHash("sha256").update(bytes).digest("hex")));
});

test("terminal sources exclude reference, input and view_image materializations", () => {
  assert.deepEqual(codexTerminalAttachmentSources({
    generatedImageSources: {
      "turn-output": [
        { type: "path", value: "C:/input/reference.png" },
        { type: "view-path", value: "C:/input/viewed.png" },
        { type: "display-path", value: "C:/input/displayed.png" },
        { type: "generated-path", value: "C:/generated/one.png" },
        { type: "generated-path", value: "C:/generated/two.png" },
      ],
    },
  }, "turn-output"), [
    { type: "generated-path", value: "C:/generated/one.png" },
    { type: "generated-path", value: "C:/generated/two.png" },
  ]);
});

test("known ImageGen recovery imports exact parser provenance without rereading the rollout", async () => {
  let reads = 0;
  const imported = [];
  const resolver = createCodexTerminalAttachmentResolver({
    knownRolloutPath: async () => "C:/rollout.jsonl",
    readRolloutActivity: async () => { reads += 1; return {}; },
    importAttachments: async (sources) => {
      imported.push(...sources);
      return [{ id: "codex-generated-before-rebirth.png" }];
    },
  });

  const result = await resolver({
    threadId: "thread-reborn",
    generatedImageSources: [{
      type: "generated-path",
      value: "C:/generated/before-rebirth.png",
    }],
  }, "turn-before-rebirth");

  assert.deepEqual(result, [{ id: "codex-generated-before-rebirth.png" }]);
  assert.equal(reads, 0);
  assert.deepEqual(imported, [{
    type: "generated-path",
    value: "C:/generated/before-rebirth.png",
  }]);
});

test("terminal resolver retries until the exact rollout final is visible", async () => {
  const savedPath = "C:/generated/direct.png";
  const completeActivity = parseCodexRolloutActivity([
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: [
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          {
            type: "input_text",
            text: `Generated images are saved to C:/generated as ${savedPath} by default.`,
          },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-direct" },
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-direct", last_agent_message: "Done" } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  let reads = 0;
  const waits = [];
  const resolver = createCodexTerminalAttachmentResolver({
    knownRolloutPath: async () => "C:/rollout.jsonl",
    readRolloutActivity: async () => {
      reads += 1;
      return reads === 1 ? {
        finalMessages: { "turn-direct": "Done" },
        generatedImageSources: {},
        activityGroups: {
          "turn-direct": [{
            activities: [{
              type: "tool",
              detail: "image_gen__imagegen",
              status: "completed",
            }],
          }],
        },
      } : completeActivity;
    },
    importAttachments: async (sources) => sources.map(() => ({
      id: "codex-generated-direct.png",
      name: "Изображение",
      type: "image/png",
    })),
    retryDelaysMs: [0, 100],
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });

  const attachments = await resolver({ threadId: "thread-1" }, "turn-direct");

  assert.equal(reads, 2);
  assert.deepEqual(waits, [100]);
  assert.deepEqual(attachments.map((attachment) => attachment.id), ["codex-generated-direct.png"]);
});

test("terminal resolver does not delay an exact final without generated images", async () => {
  let reads = 0;
  const resolver = createCodexTerminalAttachmentResolver({
    knownRolloutPath: async () => "C:/rollout.jsonl",
    readRolloutActivity: async () => {
      reads += 1;
      return { finalMessages: { "turn-text": "Обычный ответ" }, generatedImageSources: {} };
    },
    importAttachments: async () => [],
    retryDelaysMs: [0, 100, 300],
    wait: async () => { throw new Error("ordinary terminal must not wait"); },
  });

  assert.deepEqual(await resolver({ threadId: "thread-1" }, "turn-text"), []);
  assert.equal(reads, 1);
});

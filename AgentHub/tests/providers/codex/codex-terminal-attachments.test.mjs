import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";

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

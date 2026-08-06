import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  analyzeCodexRolloutContext,
  CodexRolloutContextSanitizer,
  sanitizeCodexRolloutContext,
  windowsRolloutIdleState,
} from "../../../src/providers/codex/codex-rollout-context.mjs";

function image(index) {
  return {
    type: "input_image",
    image_url: `data:image/png;base64,synthetic-${index}-${"x".repeat(256)}`,
    detail: "high",
  };
}

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function rawMessage(id, content) {
  return {
    timestamp: `2026-07-29T00:00:${String(id).padStart(2, "0")}.000Z`,
    type: "response_item",
    payload: {
      type: "message",
      id: `message-${id}`,
      role: "user",
      content,
    },
  };
}

function compacted(images) {
  return {
    timestamp: "2026-07-29T00:01:00.000Z",
    type: "compacted",
    payload: {
      window_number: 1,
      window_id: "window-1",
      replacement_history: [
        {
          type: "message",
          id: "replacement",
          role: "user",
          content: [
            { type: "input_text", text: "screenshots" },
            ...images,
          ],
        },
        { type: "compaction", encrypted_content: "summary" },
      ],
    },
  };
}

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rollout-context-"));
  const rollout = path.join(directory, "rollout.jsonl");
  const images = Array.from({ length: 6 }, (_, index) => image(index));
  await writeFile(rollout, [
    ...images.map((value, index) => line(rawMessage(index, [
      { type: "input_text", text: `image ${index}` },
      value,
    ]))),
    line(compacted(images)),
    line({
      timestamp: "2026-07-29T00:02:00.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1" },
    }),
  ].join(""), "utf8");
  return { directory, rollout };
}

test("rollout context analysis removes only duplicated old compaction images", async (context) => {
  const { directory, rollout } = await fixture();
  context.after(() => rm(directory, { recursive: true, force: true }));

  const result = await analyzeCodexRolloutContext(rollout, { keepRecentImages: 2 });

  assert.equal(result.stable, true);
  assert.equal(result.rawImageCount, 6);
  assert.equal(result.rawUniqueImageCount, 6);
  assert.equal(result.compactionCount, 1);
  assert.equal(result.compactionImageCount, 6);
  assert.equal(result.duplicateImageCount, 6);
  assert.equal(result.removedImageCount, 4);
  assert.ok(result.reclaimedBytes > 0);
});

test("rollout context sanitation preserves raw history and recent compaction images", async (context) => {
  const { directory, rollout } = await fixture();
  context.after(() => rm(directory, { recursive: true, force: true }));

  const result = await sanitizeCodexRolloutContext(rollout, {
    keepRecentImages: 2,
    minReclaimBytes: 0,
    idleState: async () => ({ idle: true, reason: "test" }),
  });

  assert.equal(result.applied, true);
  assert.equal(result.removedImageCount, 4);
  const entries = (await readFile(rollout, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((value) => JSON.parse(value));
  const rawImages = entries
    .filter((entry) => entry.type === "response_item")
    .flatMap((entry) => entry.payload.content)
    .filter((content) => content.type === "input_image");
  assert.equal(rawImages.length, 6);
  const replacement = entries.find((entry) => entry.type === "compacted")
    .payload.replacement_history[0].content;
  assert.equal(replacement.filter((content) => content.type === "input_image").length, 2);
  assert.equal(replacement.filter((content) => (
    content.type === "input_text" && content.text.startsWith("[Older image omitted")
  )).length, 4);
  const markers = replacement.filter((content) => (
    content.type === "input_text" && content.text.startsWith("[Older image omitted")
  ));
  assert.ok(markers.every((content) => content.text.includes(
    "do not reload unless the user explicitly requests it or the task cannot be completed without it",
  )));
});

test("rollout context sanitation keeps an image without a raw-history duplicate", async (context) => {
  const { directory, rollout } = await fixture();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const entries = (await readFile(rollout, "utf8")).trim().split(/\r?\n/);
  const entry = JSON.parse(entries.at(-2));
  entry.payload.replacement_history[0].content.unshift(image(99));
  entries[entries.length - 2] = JSON.stringify(entry);
  await writeFile(rollout, `${entries.join("\n")}\n`, "utf8");

  const result = await sanitizeCodexRolloutContext(rollout, {
    keepRecentImages: 0,
    minReclaimBytes: 0,
    idleState: async () => ({ idle: true, reason: "test" }),
  });

  assert.equal(result.applied, true);
  const sanitized = (await readFile(rollout, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((value) => JSON.parse(value))
    .find((value) => value.type === "compacted");
  const remaining = sanitized.payload.replacement_history[0].content
    .filter((content) => content.type === "input_image");
  assert.equal(remaining.length, 1);
  assert.match(remaining[0].image_url, /synthetic-99/);
});

test("rollout context sanitation refuses a rollout held by a live client", async (context) => {
  const { directory, rollout } = await fixture();
  context.after(() => rm(directory, { recursive: true, force: true }));
  const before = await readFile(rollout, "utf8");

  const result = await sanitizeCodexRolloutContext(rollout, {
    keepRecentImages: 0,
    minReclaimBytes: 0,
    idleState: async () => ({ idle: false, reason: "rollout-open", processIds: [42] }),
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "rollout-open");
  assert.equal(await readFile(rollout, "utf8"), before);
});

test("rollout idle check includes Agent Hub's own App Server process", async () => {
  let observedAgentHubPid = null;
  const result = await windowsRolloutIdleState("rollout.jsonl", {
    platform: "win32",
    readActivity: async () => ({ running: false, activeTurnIds: [] }),
    processProbe: async (_rolloutPath, options) => {
      observedAgentHubPid = options.agentHubPid;
      return { rootProcessIds: [42] };
    },
  });

  assert.equal(observedAgentHubPid, 0);
  assert.equal(result.idle, false);
  assert.equal(result.reason, "rollout-open");
  assert.deepEqual(result.processIds, [42]);
});

test("automatic sanitizer processes only eligible rollout files", async () => {
  const calls = [];
  const sanitizer = new CodexRolloutContextSanitizer({
    codexHome: "codex-home",
    minReclaimBytes: 100,
    discover: async () => [
      { rolloutPath: "large.jsonl", info: { size: 1_000, mtimeMs: 2 } },
      { rolloutPath: "small.jsonl", info: { size: 10, mtimeMs: 1 } },
    ],
    analyze: async (rolloutPath) => ({
      rolloutPath,
      stable: true,
      reclaimedBytes: 500,
      removedImageCount: 3,
    }),
    sanitize: async (rolloutPath, options) => {
      calls.push({ rolloutPath, options });
      return {
        ...options.analysis,
        applied: true,
        reclaimedBytes: 500,
        removedImageCount: 3,
      };
    },
    idleState: async () => ({ idle: true, reason: "test" }),
    logger: { log() {}, warn() {} },
  });

  const result = await sanitizer.runOnce();

  assert.equal(result.applied, 1);
  assert.equal(result.reclaimedBytes, 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rolloutPath, "large.jsonl");
});

test("targeted sanitizer processes only the rollout selected by a completed compaction", async () => {
  const calls = [];
  const sanitizer = new CodexRolloutContextSanitizer({
    minReclaimBytes: 0,
    analyze: async (rolloutPath) => ({
      rolloutPath,
      stable: true,
      reclaimedBytes: 500,
      removedImageCount: 2,
    }),
    sanitize: async (rolloutPath, options) => {
      calls.push(rolloutPath);
      return { ...options.analysis, applied: true };
    },
    idleState: async () => ({ idle: true, reason: "test" }),
    logger: { log() {}, warn() {} },
  });

  const result = await sanitizer.runForRollout("thread-selected.jsonl");

  assert.equal(result.applied, true);
  assert.deepEqual(calls, ["thread-selected.jsonl"]);
});

test("targeted sanitizer defers while a periodic pass owns the cleanup lock", async () => {
  const sanitizer = new CodexRolloutContextSanitizer({ logger: { log() {}, warn() {} } });
  sanitizer.running = true;

  const result = await sanitizer.runForRollout("thread-selected.jsonl");

  assert.equal(result.applied, false);
  assert.equal(result.reason, "sanitizer-busy");
});

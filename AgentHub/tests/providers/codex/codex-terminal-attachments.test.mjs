import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES,
  createCodexTerminalAttachmentResolver,
} from "../../../src/providers/codex/codex-terminal-attachments.mjs";
import { parseCodexRolloutActivity } from "../../../src/providers/codex/codex-rollout-activity.mjs";

test("terminal resolver imports all ideate outputs from a production-shaped rollout", async () => {
  const imported = [];
  const resolver = createCodexTerminalAttachmentResolver({
    knownRolloutPath: async () => "C:/rollout.jsonl",
    readRolloutActivity: async (_rolloutPath, options) => {
      assert.equal(options.freshnessMs, Number.POSITIVE_INFINITY);
      assert.equal(options.tailBytes, CODEX_TERMINAL_ATTACHMENT_TAIL_BYTES);
      return parseCodexRolloutActivity([
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-ideate" } },
        { type: "event_msg", payload: { type: "image_generation_end", call_id: "exec-1", status: "completed", saved_path: "C:/generated/one.png" } },
        { type: "event_msg", payload: { type: "image_generation_end", call_id: "exec-2", status: "completed", saved_path: "C:/generated/two.png" } },
        { type: "event_msg", payload: { type: "image_generation_end", call_id: "exec-3", status: "completed", saved_path: "C:/generated/three.png" } },
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

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
      const output = (savedPath) => ({
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
          internal_chat_message_metadata_passthrough: { turn_id: "turn-ideate" },
        },
      });
      return parseCodexRolloutActivity([
        { type: "event_msg", payload: { type: "task_started", turn_id: "turn-ideate" } },
        output("C:/generated/one.png"),
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

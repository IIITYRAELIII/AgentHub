import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateCodexContextBreakdown,
  presentContextUsageBreakdown,
} from "../../src/domain/context-usage-breakdown.mjs";

test("context breakdown keeps messages, images and files separate", () => {
  const breakdown = estimateCodexContextBreakdown({
    developerInstructions: "<workspace_instructions>Workspace rules</workspace_instructions>",
    input: [
      { type: "text", text: "Read these attachments" },
      { type: "localImage", path: "screen.png" },
      { type: "localFile", path: "report.txt" },
    ],
    skills: ["openai-docs"],
  });

  assert.deepEqual(breakdown.categories.map((entry) => entry.id), [
    "workspace",
    "messages",
    "images",
    "files",
    "skills",
  ]);
  assert.equal(breakdown.categories.find((entry) => entry.id === "messages").count, 1);
  assert.equal(breakdown.categories.find((entry) => entry.id === "images").count, 1);
  assert.equal(breakdown.categories.find((entry) => entry.id === "files").count, 1);
});

test("context presentation preserves exact total and free space", () => {
  const result = presentContextUsageBreakdown({
    breakdown: {
      categories: [
        { id: "messages", label: "Сообщения", estimatedTokens: 25 },
        { id: "images", label: "Изображения", estimatedTokens: null, count: 2, tokenEstimateAvailable: false },
      ],
    },
    usedTokens: 100,
    modelContextWindow: 1_000,
  });

  assert.deepEqual(result.categories.map((entry) => [entry.id, entry.tokens]), [
    ["messages", 25],
    ["images", null],
    ["provider-remainder", 75],
    ["free", 900],
  ]);
});

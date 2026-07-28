import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateMissingCodexUsage,
  IMAGE_GENERATION_ESTIMATE_UNITS,
  looksLikeImageGenerationPrompt,
} from "./codex-usage-estimate.mjs";

test("image generation estimate recognizes direct Russian and English requests", () => {
  assert.equal(looksLikeImageGenerationPrompt("Нарисуй чёрную дыру — это будет фон журнала"), true);
  assert.equal(looksLikeImageGenerationPrompt("Generate a blue background image"), true);
  assert.equal(looksLikeImageGenerationPrompt("Сделай фон страницы темнее через CSS"), false);
});

test("missing completed image generation usage gets a fixed rough estimate", () => {
  assert.deepEqual(estimateMissingCodexUsage({
    status: "completed",
    usageReported: false,
    prompt: "Нарисуй такую чёрную дыру, это будет фон журнала",
  }), {
    estimatedUnits: IMAGE_GENERATION_ESTIMATE_UNITS,
    estimateKind: "imagegen-default",
  });
  assert.equal(estimateMissingCodexUsage({
    status: "interrupted",
    usageReported: false,
    prompt: "Нарисуй фон",
  }), null);
  assert.equal(estimateMissingCodexUsage({
    status: "completed",
    usageReported: true,
    prompt: "Нарисуй фон",
  }), null);
});

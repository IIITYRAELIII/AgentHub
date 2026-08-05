import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateMissingCodexUsage,
  IMAGE_GENERATION_ESTIMATE_CREDITS,
  looksLikeImageGenerationPrompt,
} from "./src/domain/codex-usage-estimate.mjs";

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
    estimatedCredits: IMAGE_GENERATION_ESTIMATE_CREDITS,
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

test("exact completed image generation calls are estimated in addition to reported Codex usage", () => {
  assert.deepEqual(estimateMissingCodexUsage({
    status: "completed",
    usageReported: true,
    prompt: "Обнови тему",
    imageGenerationCount: 2,
  }), {
    estimatedCredits: IMAGE_GENERATION_ESTIMATE_CREDITS * 2,
    estimateKind: "imagegen-default",
  });
  assert.deepEqual(estimateMissingCodexUsage({
    status: "aborted",
    usageReported: true,
    imageGenerationCount: 1,
  }), {
    estimatedCredits: IMAGE_GENERATION_ESTIMATE_CREDITS,
    estimateKind: "imagegen-default",
  });
});

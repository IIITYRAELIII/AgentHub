import assert from "node:assert/strict";
import test from "node:test";

import {
  isTestContourModelSettingResponse,
  selectTestContourModel,
} from "../../../src/infrastructure/browser/test-contour-ui-smoke.mjs";

function smokePage({ availableModels = ["gpt-5.3-codex-spark"], selectedModel = "" } = {}) {
  const events = [];
  let currentModel = selectedModel;
  const locators = {
    "[data-dialog-settings-toggle]": {
      async waitFor(options) { events.push(["toggle.waitFor", options]); },
      async click() { events.push(["toggle.click"]); },
    },
    'select[data-dialog-options="model"]': {
      async waitFor(options) { events.push(["model.waitFor", options]); },
      locator(selector) {
        assert.equal(selector, "option");
        return {
          async evaluateAll(callback) {
            return callback(availableModels.map((value) => ({ value })));
          },
        };
      },
      async selectOption(value, options) {
        events.push(["model.selectOption", value, options]);
        currentModel = value;
      },
      async inputValue() { return currentModel; },
    },
    "[data-dialog-settings-close]": {
      async click() { events.push(["close.click"]); },
    },
  };
  return {
    events,
    page: {
      locator(selector) {
        assert.ok(locators[selector], `Unexpected selector: ${selector}`);
        return locators[selector];
      },
      async waitForResponse(predicate, options) {
        const response = {
          ok: () => true,
          status: () => 200,
          url: () => "http://localhost:8877/api/control",
          request: () => ({
            method: () => "POST",
            postData: () => JSON.stringify({
              action: "update-setting",
              params: { name: "model", value: currentModel },
            }),
          }),
        };
        events.push(["page.waitForResponse", options]);
        return new Promise((resolve) => {
          queueMicrotask(() => {
            assert.equal(predicate(response), true);
            resolve(response);
          });
        });
      },
    },
  };
}

test("Test Contour smoke selects the requested model before creating a thread", async () => {
  const fixture = smokePage({
    availableModels: ["gpt-5.3-codex-spark", "gpt-5.6-terra", "fake-codex"],
    selectedModel: "fake-codex",
  });

  await selectTestContourModel(fixture.page, "gpt-5.6-terra", 5_000);

  assert.deepEqual(fixture.events, [
    ["toggle.waitFor", { state: "visible", timeout: 5_000 }],
    ["toggle.click"],
    ["model.waitFor", { state: "attached", timeout: 5_000 }],
    ["page.waitForResponse", { timeout: 5_000 }],
    ["model.selectOption", "gpt-5.6-terra", { force: true }],
    ["close.click"],
  ]);
});

test("Test Contour smoke recognizes only the exact model-setting ACK", () => {
  const response = (payload) => ({
    url: () => "http://localhost:8877/api/control",
    request: () => ({ method: () => "POST", postData: () => JSON.stringify(payload) }),
  });

  assert.equal(isTestContourModelSettingResponse(response({
    action: "update-setting",
    params: { name: "model", value: "gpt-5.6-terra" },
  }), "gpt-5.6-terra"), true);
  assert.equal(isTestContourModelSettingResponse(response({
    action: "update-setting",
    params: { name: "reasoning", value: "gpt-5.6-terra" },
  }), "gpt-5.6-terra"), false);
});

test("Test Contour smoke rejects an unavailable requested model", async () => {
  const fixture = smokePage({ availableModels: ["fake-codex"], selectedModel: "fake-codex" });

  await assert.rejects(
    selectTestContourModel(fixture.page, "gpt-5.6-terra", 5_000),
    /model is not selectable: gpt-5\.6-terra/u,
  );
  assert.equal(fixture.events.some(([event]) => event === "model.selectOption"), false);
});

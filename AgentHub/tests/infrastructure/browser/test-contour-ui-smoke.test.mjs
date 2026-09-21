import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  exactTestContourResponsePattern,
  isTestContourModelSettingResponse,
  selectTestContourCodexStream,
  selectTestContourModel,
} from "../../../src/infrastructure/browser/test-contour-ui-smoke.mjs";

const smokeSource = fs.readFileSync(
  new URL("../../../src/infrastructure/browser/test-contour-ui-smoke.mjs", import.meta.url),
  "utf8",
);

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
        if (selector.startsWith('option[value="')) {
          const value = selector.match(/^option\[value="(.+)"\]$/u)?.[1] ?? "";
          return {
            async waitFor(options) {
              events.push(["model.option.waitFor", value, options]);
              if (!availableModels.includes(value)) throw new Error("option unavailable");
            },
          };
        }
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
    availableModels: ["gpt-5.3-codex-spark", "gpt-5.6-luna", "fake-codex"],
    selectedModel: "fake-codex",
  });

  await selectTestContourModel(fixture.page, "gpt-5.6-luna", 5_000);

  assert.deepEqual(fixture.events, [
    ["toggle.waitFor", { state: "visible", timeout: 5_000 }],
    ["toggle.click"],
    ["model.waitFor", { state: "attached", timeout: 5_000 }],
    ["model.option.waitFor", "gpt-5.6-luna", { state: "attached", timeout: 5_000 }],
    ["page.waitForResponse", { timeout: 5_000 }],
    ["model.selectOption", "gpt-5.6-luna", { force: true }],
    ["close.click"],
  ]);
});

test("Test Contour smoke accepts an already selected model without waiting for a no-op request", async () => {
  const fixture = smokePage({ availableModels: ["fake-codex"], selectedModel: "fake-codex" });

  await selectTestContourModel(fixture.page, "fake-codex", 5_000);

  assert.equal(fixture.events.some(([event]) => event === "page.waitForResponse"), false);
  assert.equal(fixture.events.some(([event]) => event === "model.selectOption"), false);
  assert.deepEqual(fixture.events.at(-1), ["close.click"]);
});

test("Test Contour smoke skips empty Workspaces and selects a named Codex Stream", async () => {
  const events = [];
  let activeWorkspace = -1;
  const namedCodexByWorkspace = [false, true];
  const stream = {
    async waitFor(options) {
      events.push(["stream.waitFor", activeWorkspace, options]);
      if (!namedCodexByWorkspace[activeWorkspace]) throw new Error("stream unavailable");
    },
    async click() { events.push(["stream.click", activeWorkspace]); },
  };
  const workspaces = {
    first() {
      return { async waitFor(options) { events.push(["workspaces.waitFor", options]); } };
    },
    async count() { return namedCodexByWorkspace.length; },
    nth(index) {
      return {
        async getAttribute(name) {
          assert.equal(name, "data-workspace-id");
          return `workspace-${index}`;
        },
        async click() { activeWorkspace = index; events.push(["workspace.click", index]); },
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === "[data-workspace-select]:visible") return workspaces;
      assert.match(selector, /data-stream-provider="codex"/u);
      assert.match(selector, /data-stream-name/u);
      assert.match(selector, new RegExp(`data-workspace-id="workspace-${activeWorkspace}"`, "u"));
      return { first: () => stream };
    },
  };

  assert.equal(await selectTestContourCodexStream(page, 5_000), stream);
  assert.deepEqual(events, [
    ["workspaces.waitFor", { state: "visible", timeout: 5_000 }],
    ["workspace.click", 0],
    ["stream.waitFor", 0, { state: "visible", timeout: 2_000 }],
    ["workspace.click", 1],
    ["stream.waitFor", 1, { state: "visible", timeout: 2_000 }],
    ["stream.click", 1],
  ]);
});

test("Test Contour smoke probes the selected Codex Stream without rotating its Thread", () => {
  assert.match(smokeSource, /await selectTestContourCodexStream\(page, timeoutMs\)/u);
  assert.match(smokeSource, /await selectTestContourModel\(page, model, timeoutMs\)/u);
  assert.doesNotMatch(smokeSource, /\[data-stream-menu-action="replace-thread"\]/u);
  assert.doesNotMatch(
    smokeSource,
    /\[data-stream-menu-action="continue-provider"\]\[data-provider="codex"\]/u,
  );
});

test("Test Contour smoke recognizes only the exact model-setting ACK", () => {
  const response = (payload) => ({
    url: () => "http://localhost:8877/api/control",
    request: () => ({ method: () => "POST", postData: () => JSON.stringify(payload) }),
  });

  assert.equal(isTestContourModelSettingResponse(response({
    action: "update-setting",
    params: { name: "model", value: "gpt-5.6-luna" },
  }), "gpt-5.6-luna"), true);
  assert.equal(isTestContourModelSettingResponse(response({
    action: "update-setting",
    params: { name: "reasoning", value: "gpt-5.6-luna" },
  }), "gpt-5.6-luna"), false);
});

test("Test Contour smoke ignores old messages containing the expected response", () => {
  const pattern = exactTestContourResponsePattern("Принято");

  assert.equal(pattern.test("Принято"), true);
  assert.equal(pattern.test("  Принято\n"), true);
  assert.equal(pattern.test("Старый ответ: принято и ожидает релиза"), false);
});

test("Test Contour smoke rejects an unavailable requested model", async () => {
  const fixture = smokePage({ availableModels: ["fake-codex"], selectedModel: "fake-codex" });

  await assert.rejects(
    selectTestContourModel(fixture.page, "gpt-5.6-luna", 5_000),
    /model is not selectable: gpt-5\.6-luna/u,
  );
  assert.equal(fixture.events.some(([event]) => event === "model.selectOption"), false);
});

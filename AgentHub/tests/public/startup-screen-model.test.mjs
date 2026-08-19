import assert from "node:assert/strict";
import test from "node:test";
import {
  createStartupReconnectModel,
  createStartupScreenModel,
  formatStartupElapsed,
  shouldShowStartupReconnect,
  shouldShowStartupScreen,
} from "../../assets/web-app/startup-screen-model.js";

test("startup screen projects one active operation and ordered surrounding stages", () => {
  const model = createStartupScreenModel({
    ready: false,
    status: "starting",
    startup: {
      startedAtMs: 1_000,
      operations: [
        { id: "release", label: "Release", state: "completed" },
        { id: "provider", label: "Provider", state: "running" },
        { id: "ready", label: "Ready", state: "pending" },
      ],
    },
  }, 28_000);
  assert.equal(model.available, true);
  assert.equal(model.title, "Provider");
  assert.equal(model.elapsed, "00:00:27");
  assert.equal(model.stageNumber, 2);
  assert.deepEqual(model.completedOperations.map(({ id }) => id), ["release"]);
  assert.deepEqual(model.queueOperations.map(({ id }) => id), ["provider", "ready"]);
});

test("startup screen keeps failures visible and formats long elapsed time", () => {
  const model = createStartupScreenModel({
    ready: false,
    status: "unready",
    startup: {
      startedAtMs: 0,
      completedAtMs: 3_661_000,
      operations: [
        { id: "provider", label: "Provider", state: "failed" },
      ],
    },
  }, 3_661_000);
  assert.equal(model.failed, true);
  assert.equal(model.title, "Запуск завершён с ошибкой");
  assert.deepEqual(model.completedOperations.map(({ state }) => state), ["failed"]);
  assert.equal(formatStartupElapsed(0, 3_661_000), "01:01:01");
});

test("startup screen shows a meaningful reconnect stage before health returns", () => {
  const model = createStartupReconnectModel(10_000, 14_000);
  assert.equal(model.available, true);
  assert.equal(model.ready, false);
  assert.equal(model.status, "reconnecting");
  assert.equal(model.title, "Ожидание запуска Agent Hub");
  assert.equal(model.elapsed, "00:00:04");
  assert.deepEqual(model.queueOperations.map(({ id }) => id), ["connection"]);
});

test("startup screen renders each completed startup once", () => {
  const model = createStartupScreenModel({
    ready: true,
    status: "ready",
    startup: {
      startedAtMs: 10_000,
      operations: [{ id: "ready", label: "Ready", state: "completed" }],
    },
  }, 12_000);

  assert.equal(shouldShowStartupScreen(model), true);
  assert.equal(shouldShowStartupScreen(model, { visible: true, lastStartedAtMs: 10_000 }), true);
  assert.equal(shouldShowStartupScreen(model, { visible: false, lastStartedAtMs: 10_000 }), false);
  assert.equal(shouldShowStartupScreen({ available: false, ready: false }), false);
});

test("VS Code shows reconnect immediately while Web waits for confirmed health", () => {
  assert.equal(shouldShowStartupReconnect({ surface: "vscode", consecutiveFailures: 1 }), true);
  assert.equal(shouldShowStartupReconnect({ surface: "web", consecutiveFailures: 1 }), false);
  assert.equal(shouldShowStartupReconnect({
    surface: "web",
    observedHealth: true,
    consecutiveFailures: 2,
  }), true);
});

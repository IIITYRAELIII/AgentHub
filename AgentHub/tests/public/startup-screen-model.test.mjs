import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createVisibilityBoundAnimation,
  createStartupDisconnectedModel,
  createStartupScreenModel,
  formatStartupElapsed,
  shouldShowStartupScreen,
} from "../../assets/web-app/startup-screen-model.js";

const startupScreenSource = readFileSync(
  new URL("../../assets/web-app/startup-screen.js", import.meta.url),
  "utf8",
);

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

test("startup screen stops attributing a lost connection to the last operation", () => {
  const active = createStartupScreenModel({
    ready: false,
    status: "starting",
    startup: {
      startedAtMs: 1_000,
      operations: [
        { id: "runs", label: "Восстановление активных ходов", state: "running" },
        { id: "notifications", label: "Повтор уведомлений", state: "pending" },
      ],
    },
  }, 121_000);
  const disconnected = createStartupDisconnectedModel(active);

  assert.equal(disconnected.connectionLost, true);
  assert.equal(disconnected.title, "Ожидание нового процесса");
  assert.equal(disconnected.elapsed, "—");
  assert.equal(disconnected.stageLabel, "Соединение временно недоступно");
  assert.deepEqual(disconnected.queueOperations, active.queueOperations);
});

test("startup screen can reopen for a runtime replacement after initial startup", () => {
  const disconnected = createStartupDisconnectedModel(null);

  assert.equal(disconnected.available, true);
  assert.equal(disconnected.title, "Ожидание нового процесса");
  assert.match(startupScreenSource, /agenthub:connection-state/u);
  assert.match(startupScreenSource, /showDisconnectedState\(\{ force: true \}\)/u);
});

test("startup screen uses factual health stages and a webview-safe mark URL", () => {
  assert.match(startupScreenSource, /new URL\("\.\/agent-hub-mark\.png", import\.meta\.url\)\.href/u);
  assert.doesNotMatch(startupScreenSource, /<img src="\/agent-hub-mark\.png"/u);
});

test("startup animation runs only while its screen is visible", () => {
  let visible = false;
  let nextFrameId = 1;
  const frames = new Map();
  const cancelled = [];
  const draws = [];
  const animation = createVisibilityBoundAnimation({
    requestFrame: (callback) => {
      const frameId = nextFrameId++;
      frames.set(frameId, callback);
      return frameId;
    },
    cancelFrame: (frameId) => {
      cancelled.push(frameId);
      frames.delete(frameId);
    },
    isVisible: () => visible,
    draw: (now) => draws.push(now),
  });

  animation.start();
  assert.equal(frames.size, 0);

  visible = true;
  animation.start();
  animation.start();
  assert.equal(frames.size, 1);
  const [firstFrameId, firstFrame] = frames.entries().next().value;
  frames.delete(firstFrameId);
  firstFrame(16);
  assert.deepEqual(draws, [16]);
  assert.equal(frames.size, 1);

  visible = false;
  animation.stop();
  assert.deepEqual(cancelled, [2]);
  assert.equal(frames.size, 0);

  visible = true;
  animation.start();
  animation.destroy();
  assert.deepEqual(cancelled, [2, 3]);
  animation.start();
  assert.equal(frames.size, 0);
});

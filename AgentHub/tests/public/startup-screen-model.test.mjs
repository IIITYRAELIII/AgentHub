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

test("startup shows the current backend provider error without rewriting completed startup history", () => {
  for (const state of ["completed", "failed"]) {
    const snapshot = { ready: false, status: "unready", capabilities: [
      { name: "provider", critical: true, state: "failed", error: "Required Codex code-mode host is missing" },
    ], startup: { startedAtMs: 1000, operations: [{ id: "provider", label: "Provider", state, error: "" }] } };
    const original = structuredClone(snapshot);
    const model = createStartupScreenModel(snapshot);
    assert.equal(model.operations[0].state, state);
    assert.equal(model.failedOperations.length, 1);
    assert.equal(model.failedOperations[0].error, snapshot.capabilities[0].error);
    assert.equal(model.failed, true);
    assert.deepEqual(snapshot, original);
    assert.equal(shouldShowStartupScreen(model), true);
  }
});

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
        { id: "provider", label: "Provider", state: "failed", error: "Signature verification timed out" },
      ],
    },
  }, 3_661_000);
  assert.equal(model.failed, true);
  assert.equal(model.title, "Запуск завершён с ошибкой");
  assert.equal(model.failedOperations[0].error, "Signature verification timed out");
  assert.deepEqual(model.completedOperations.map(({ state }) => state), ["failed"]);
  assert.equal(formatStartupElapsed(0, 3_661_000), "01:01:01");
});

test("a retried stage does not put completed later stages back in the queue", () => {
  const model = createStartupScreenModel({
    ready: false,
    startup: {
      startedAtMs: 1000,
      operations: [
        { id: "web", label: "Web", state: "completed" },
        { id: "provider", label: "Provider", state: "running" },
        { id: "runs", label: "Runs", state: "completed" },
      ],
    },
  });
  assert.deepEqual(model.queueOperations.map((operation) => operation.id), ["provider"]);
  assert.deepEqual(model.completedOperations.map((operation) => operation.id), ["web", "runs"]);
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

  assert.equal(shouldShowStartupScreen(model), false);
  assert.equal(shouldShowStartupScreen(model, { visible: true, lastStartedAtMs: 10_000 }), false);
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
  assert.equal(disconnected.title, "Ожидание соединения");
  assert.equal(disconnected.status, "unknown");
  assert.equal(disconnected.elapsed, "—");
  assert.equal(disconnected.stageLabel, "Соединение временно недоступно");
  assert.deepEqual(disconnected.queueOperations, []);
  assert.deepEqual(disconnected.operations, []);
});

test("startup screen can reopen for a runtime replacement after initial startup", () => {
  const disconnected = createStartupDisconnectedModel(null, { restarting: true });

  assert.equal(disconnected.available, true);
  assert.equal(disconnected.title, "Ожидание нового процесса");
  assert.match(startupScreenSource, /agenthub:connection-state/u);
  assert.match(startupScreenSource, /showDisconnectedState\(\{ force: true \}\)/u);
});

test("restart waiting never inherits completed stages or readiness from the previous process", () => {
  const ready = createStartupScreenModel({
    ready: true, status: "ready",
    startup: {
      startedAtMs: 1000,
      operations: Array.from({ length: 17 }, (_, index) => ({ id: `stage-${index}`, state: "completed" })),
    },
  });
  const disconnected = createStartupDisconnectedModel(ready, { restarting: true });
  assert.equal(disconnected.ready, false);
  assert.equal(disconnected.finished, false);
  assert.equal(disconnected.status, "restarting");
  assert.equal(disconnected.stageTotal, 0);
  assert.deepEqual(disconnected.completedOperations, []);
  assert.deepEqual(disconnected.operations, []);
  assert.equal(ready.completedOperations.length, 17);
});

test("connection loss retains known startup errors without inventing a restart", () => {
  const failed = createStartupScreenModel({
    ready: false, status: "unready",
    startup: { startedAtMs: 1000, operations: [{ id: "provider", state: "failed", error: "Provider unavailable" }] },
  });
  const disconnected = createStartupDisconnectedModel(failed);
  assert.equal(disconnected.title, "Ожидание соединения");
  assert.deepEqual(disconnected.failedOperations, failed.failedOperations);
  assert.equal(disconnected.startedAtMs, 1000);
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

// Optional work that the server marks as background runs outside the startup
// barrier. Its state must never return a ready interface to the blocking
// screen, and it must never hide a real mandatory failure.
const readyWith = (operations) => ({
  ready: true,
  status: "ready",
  startup: { startedAtMs: 1_000, completedAtMs: 9_000, operations },
});

test("background work never blocks a ready interface and keeps its error visible", () => {
  const failedBackground = createStartupScreenModel(readyWith([
    { id: "web", label: "Web", state: "completed" },
    { id: "runs", label: "Восстановление ходов", state: "completed" },
    {
      id: "provider-metadata",
      label: "Восстановление метаданных провайдера",
      state: "failed",
      background: true,
      error: "Captured Codex rollouts are excluded from recording execution",
    },
  ]), 10_000);
  assert.equal(failedBackground.failed, false, "фоновый отказ выдан за общий отказ запуска");
  assert.equal(failedBackground.finished, true);
  // Authoritative readiness closes the overlay for first and returning visitors.
  assert.equal(shouldShowStartupScreen(failedBackground, { visible: false, lastStartedAtMs: 0 }), false,
    "готовность немедленно открывает интерфейс");
  assert.equal(shouldShowStartupScreen(failedBackground, { visible: true, lastStartedAtMs: 0 }), false,
    "готовность закрывает уже показанный экран");
  assert.equal(shouldShowStartupScreen(failedBackground, { visible: false, lastStartedAtMs: 1_000 }), false,
    "уже виденный запуск снова закрыл готовый интерфейс");

  // The failure itself stays in diagnostics: the stage list and a separate set.
  const diagnosed = failedBackground.operations.find((item) => item.id === "provider-metadata");
  assert.equal(diagnosed.state, "failed");
  assert.match(diagnosed.error, /recording execution/u);
  assert.deepEqual(failedBackground.backgroundFailedOperations.map((item) => item.id), ["provider-metadata"]);
  assert.deepEqual(failedBackground.failedOperations, []);

  for (const state of ["pending", "running"]) {
    const busyBackground = createStartupScreenModel(readyWith([
      { id: "web", label: "Web", state: "completed" },
      { id: "provider-metadata", label: "Фоновый ремонт", state, background: true },
    ]), 10_000);
    assert.equal(busyBackground.failed, false, `${state}: фоновая работа выдана за отказ`);
    assert.equal(busyBackground.finished, true, `${state}: фоновая работа выдана за незавершённый запуск`);
    assert.equal(busyBackground.currentIndex, -1, `${state}: фоновая работа выдана за текущий этап`);
    assert.equal(shouldShowStartupScreen(busyBackground, { visible: false, lastStartedAtMs: 1_000 }), false,
      `${state}: уже виденный запуск снова закрыл готовый интерфейс`);
  }
});

test("a mandatory failure still blocks even next to background work", () => {
  const model = createStartupScreenModel(readyWith([
    { id: "web", label: "Web", state: "completed" },
    { id: "provider", label: "Инициализация провайдера", state: "failed", error: "Signature check timed out" },
    { id: "provider-metadata", label: "Фоновый ремонт", state: "failed", background: true, error: "recording" },
  ]), 10_000);
  assert.equal(model.failed, true, "обязательный отказ перестал блокировать запуск");
  assert.deepEqual(model.failedOperations.map((item) => item.id), ["provider"]);
  assert.deepEqual(model.backgroundFailedOperations.map((item) => item.id), ["provider-metadata"]);
  assert.equal(shouldShowStartupScreen(model, { visible: false, lastStartedAtMs: 1_000 }), false);
  assert.equal(shouldShowStartupScreen(model, { visible: true, lastStartedAtMs: 1_000 }), false);

  // An unfinished mandatory stage keeps the screen active as before.
  const starting = createStartupScreenModel({
    ready: false,
    status: "starting",
    startup: {
      startedAtMs: 1_000,
      operations: [
        { id: "web", label: "Web", state: "running" },
        { id: "provider-metadata", label: "Фоновый ремонт", state: "failed", background: true, error: "recording" },
      ],
    },
  }, 4_000);
  assert.equal(starting.finished, false);
  assert.equal(starting.currentIndex, 0, "текущим этапом стала не обязательная работа");
  assert.equal(shouldShowStartupScreen(starting, { visible: false, lastStartedAtMs: 0 }), true);
});

test("a lost connection reports only mandatory failures", () => {
  const model = createStartupScreenModel(readyWith([
    { id: "web", label: "Web", state: "completed" },
    { id: "provider-metadata", label: "Фоновый ремонт", state: "failed", background: true, error: "recording" },
  ]), 10_000);
  const disconnected = createStartupDisconnectedModel(model, { restarting: false });
  assert.equal(disconnected.connectionLost, true);
  assert.equal(disconnected.failed, false, "потеря связи показала фоновый отказ как отказ запуска");
  assert.deepEqual(disconnected.failedOperations, []);

  const withMandatory = createStartupScreenModel(readyWith([
    { id: "provider", label: "Инициализация провайдера", state: "failed", error: "Signature check timed out" },
    { id: "provider-metadata", label: "Фоновый ремонт", state: "failed", background: true, error: "recording" },
  ]), 10_000);
  const disconnectedMandatory = createStartupDisconnectedModel(withMandatory, { restarting: false });
  assert.equal(disconnectedMandatory.failed, true, "потеря связи скрыла обязательный отказ");
  assert.deepEqual(disconnectedMandatory.failedOperations.map((item) => item.id), ["provider"]);
  assert.deepEqual(createStartupDisconnectedModel(withMandatory, { restarting: true }).failedOperations, []);
});

test("replacement wait shows measured waiting time and proves only a responding process", () => {
  const lost = createStartupDisconnectedModel(null, { restarting: true, sinceMs: 10_000, nowMs: 75_000 });
  assert.equal(lost.elapsed, "00:01:05");
  assert.equal(lost.waitingSinceMs, 10_000);
  assert.equal(lost.stageLabel, "Соединение временно недоступно");

  const responding = createStartupDisconnectedModel(null, {
    restarting: true, responding: true, sinceMs: 10_000, nowMs: 12_000,
  });
  assert.equal(responding.stageLabel, "Прежний процесс ещё отвечает — ожидаю замену");
  assert.equal(responding.elapsed, "00:00:02");

  assert.equal(createStartupDisconnectedModel(null, { restarting: true }).elapsed, "—");
  assert.match(startupScreenSource, /waitingSinceMs/u);
});

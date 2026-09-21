import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function connectionBannerApi() {
  const source = await readFile(new URL("../../assets/web-app/connection-banner.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { Number, Object, window });
  return window.AgentHubConnectionBanner;
}

test("restart banner describes generic blocking work rather than active Tasks", async () => {
  const { restartWaitingMessage } = await connectionBannerApi();
  assert.equal(
    restartWaitingMessage(2),
    "Agent Hub ожидает завершения блокирующей работы: 2.",
  );
  assert.equal(restartWaitingMessage(0), "Agent Hub ожидает завершения блокирующей работы.");
});

test("restart connection state trusts current blockers over a stale request flag", async () => {
  const { snapshotConnectionState } = await connectionBannerApi();
  assert.deepEqual({ ...snapshotConnectionState({
    restartPending: true,
    restartWaiting: false,
    restartBlockingCount: 1,
  }) }, {
    status: "restart-waiting",
    blockingCount: 1,
  });
  assert.deepEqual({ ...snapshotConnectionState({
    restartPending: true,
    restartWaiting: false,
    restartBlockingCount: 0,
  }) }, {
    status: "restarting",
    blockingCount: 0,
  });
});

test("one transient failure keeps a healthy snapshot online through the grace period", async () => {
  const { transientFailureDecision } = await connectionBannerApi();
  assert.equal(transientFailureDecision({
    hasSnapshot: true,
    failureCount: 1,
    elapsedMs: 400,
  }), "hold");
  assert.equal(transientFailureDecision({
    hasSnapshot: false,
    failureCount: 1,
    elapsedMs: 400,
  }), "connecting");
  assert.equal(transientFailureDecision({
    hasSnapshot: true,
    failureCount: 3,
    elapsedMs: 1_000,
  }), "offline");
});

test("restart failure notice names the persisted reason for an exact operation", async () => {
  const { restartFailureNotice } = await connectionBannerApi();
  assert.equal(restartFailureNotice(null), null);
  assert.equal(restartFailureNotice({ error: "no identity" }), null);
  assert.deepEqual({ ...restartFailureNotice({
    operationId: "restart-1",
    error: "replacement bot 84 exited before becoming ready",
  }) }, {
    operationId: "restart-1",
    message: "Перезапуск Agent Hub не выполнен: replacement bot 84 exited before becoming ready.",
  });
  assert.equal(
    restartFailureNotice({ operationId: "restart-2", error: null }).message,
    "Перезапуск Agent Hub не выполнен: причина не сохранена.",
  );
});

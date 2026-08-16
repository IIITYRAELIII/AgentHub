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

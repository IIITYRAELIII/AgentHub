import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function runtimeReloadApi() {
  const source = await readFile(
    new URL("../../assets/mini-app/runtime-reload-controller.js", import.meta.url),
    "utf8",
  );
  const window = { setTimeout, clearTimeout };
  vm.runInNewContext(source, { window });
  return window.AgentHubRuntimeReload;
}

test("runtime reload waits for transient UI state and retries once it is safe", async () => {
  const { RuntimeReloadController } = await runtimeReloadApi();
  let blocked = true;
  let deferred = 0;
  let applied = 0;
  let scheduled = null;
  const controller = new RuntimeReloadController({
    prepare: () => !blocked,
    apply: () => { applied += 1; },
    onDeferred: () => { deferred += 1; },
    setTimer: (callback) => { scheduled = callback; return 1; },
    clearTimer: () => { scheduled = null; },
  });

  assert.equal(controller.request(), false);
  assert.equal(controller.request(), false);
  assert.equal(deferred, 1);
  assert.equal(applied, 0);
  blocked = false;
  scheduled();
  assert.equal(applied, 1);
  assert.equal(controller.pending, false);
});

test("runtime reload applies immediately when the UI is safe", async () => {
  const { RuntimeReloadController } = await runtimeReloadApi();
  let applied = 0;
  const controller = new RuntimeReloadController({
    prepare: () => true,
    apply: () => { applied += 1; },
  });

  assert.equal(controller.request(), true);
  assert.equal(applied, 1);
});

test("runtime reload blockers cover active drafts, attachments, requests and dialogs", async () => {
  const { runtimeReloadBlocked } = await runtimeReloadApi();
  assert.equal(runtimeReloadBlocked(), false);
  assert.equal(runtimeReloadBlocked({ currentDraft: { text: "Пишу" } }), true);
  assert.equal(runtimeReloadBlocked({ currentDraft: { annotations: [{ quote: "x" }] } }), true);
  assert.equal(runtimeReloadBlocked({ drafts: [{ attachments: [{ name: "screen.png" }] }] }), true);
  assert.equal(runtimeReloadBlocked({ modalOpen: true }), true);
  assert.equal(runtimeReloadBlocked({ requestPending: true }), true);
  assert.equal(runtimeReloadBlocked({ bugReportAttachments: [{ name: "screen.png" }] }), true);
  assert.equal(runtimeReloadBlocked({ bugReportSending: true }), true);
});

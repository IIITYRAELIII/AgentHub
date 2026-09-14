import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function runtimeReloadApi() {
  const source = await readFile(
    new URL("../../assets/web-app/runtime-reload-controller.js", import.meta.url),
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

test("runtime reload preserves stored text but blocks non-restorable state", async () => {
  const { runtimeReloadBlocked } = await runtimeReloadApi();
  assert.equal(runtimeReloadBlocked(), false);
  assert.equal(runtimeReloadBlocked({ drafts: [{ text: "Пишу" }] }), false);
  assert.equal(runtimeReloadBlocked({ drafts: [{ annotations: [{ quote: "x" }] }] }), false);
  assert.equal(runtimeReloadBlocked({ draftsPersisted: false }), true);
  assert.equal(runtimeReloadBlocked({ drafts: [{ text: "exact bytes only", recoveryNonDurable: true }] }), true);
  assert.equal(runtimeReloadBlocked({ drafts: [{ attachments: [{ name: "screen.png" }] }] }), true);
  assert.equal(runtimeReloadBlocked({
    drafts: [{
      attachments: [{ name: "screen.png", dataUrl: "data:image/png;base64,AQID" }],
      recoveryRequestId: "request-1",
      recoveryFingerprint: "fingerprint-1",
      recoveryDurable: true,
    }],
  }), false);
  assert.equal(runtimeReloadBlocked({ modalOpen: true }), true);
  assert.equal(runtimeReloadBlocked({ requestPending: true }), true);
  assert.equal(runtimeReloadBlocked({ bugReportAttachments: [{ name: "screen.png" }] }), true);
  assert.equal(runtimeReloadBlocked({ bugReportSending: true }), true);
});

test("runtime identity change reloads the client after an ordinary restart", async () => {
  const { runtimeIdentityTransition } = await runtimeReloadApi();

  assert.deepEqual(
    { ...runtimeIdentityTransition(
      { instanceId: "instance-1", releaseId: "release-1" },
      { instanceId: "instance-2", releaseId: "release-1" },
    ) },
    { instanceChanged: true, releaseChanged: false, reloadRequired: true },
  );
  assert.deepEqual(
    { ...runtimeIdentityTransition(
      { instanceId: "instance-1", releaseId: "release-1" },
      { instanceId: "instance-1", releaseId: "release-2" },
    ) },
    { instanceChanged: false, releaseChanged: true, reloadRequired: true },
  );
  assert.deepEqual(
    { ...runtimeIdentityTransition(
      { instanceId: "instance-1", releaseId: "release-1" },
      { instanceId: "instance-1", releaseId: "release-1" },
    ) },
    { instanceChanged: false, releaseChanged: false, reloadRequired: false },
  );
});

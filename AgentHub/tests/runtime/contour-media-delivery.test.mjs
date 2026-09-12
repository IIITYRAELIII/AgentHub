import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersistentBackgroundJobStore } from "../../src/infrastructure/persistence/background-job-store.mjs";
import { PersistentBackgroundJobController } from "../../src/runtime/background-job-controller.mjs";
import { createContourExternalEffects } from "../../src/infrastructure/filesystem/test-contour-external-effects.mjs";
import { MediaController } from "../../src/interfaces/telegram/media-controller.mjs";
import { createDeliveryOutboxComposition } from "../../src/composition/delivery-outbox-composition.mjs";
import { createRecordingContourDelivery } from "../../src/runtime/test-contour-recording-delivery.mjs";
import { PersistentDeliveryOutbox } from "../../src/infrastructure/persistence/delivery-outbox.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-contour-media-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "recording-provider.json"), JSON.stringify({
    schemaVersion: 1, kind: "literal-recording-provider", root, externalEffects: "deny",
  }));
  return root;
}

test("captured background jobs stay inert with their exact persisted attempts and payload", async (t) => {
  const root = await fixture(t);
  const directoryPath = path.join(root, "background-jobs");
  const store = new PersistentBackgroundJobStore({ directoryPath });
  const item = await store.enqueue({ kind: "speech", payload: { chatId: 7, text: "captured text" } });
  await store.recordFailure(item.id, { attempts: 1, nextAttemptAt: new Date(0).toISOString(), lastError: "old failure" });
  const file = path.join(directoryPath, (await readdir(directoryPath))[0]);
  const before = await readFile(file);
  let effects = 0;
  const effect = () => { effects += 1; };
  const jobs = new PersistentBackgroundJobController({
    store, maxMediaJobs: 2, maxSpeechJobs: 2,
    contourExternalEffects: createContourExternalEffects({ root }),
    sendMessage: async () => effect(), media: { processSpeechRequest: async () => effect() },
    forwardBundles: { pendingImageJobs: () => { effect(); return []; } },
    scheduleTimer: () => { effect(); return null; },
    logger: { log() {}, warn() {}, error() {} },
  });
  const result = await jobs.restore();
  await new Promise((resolve) => setImmediate(resolve));
  await store.waitForWrites();
  assert.equal(effects, 0);
  assert.equal(result.status, "excluded");
  assert.equal(result.total, 1);
  assert.equal(jobs.size, 1);
  assert.equal(jobs.activeSize, 0);
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(jobs.enqueue("speech", { chatId: 7, text: "new" }, 7), { code: "CONTOUR_MEDIA_EXCLUDED" });
  const reopened = new PersistentBackgroundJobStore({ directoryPath });
  await reopened.load();
  assert.deepEqual(reopened.values(), store.values());
});

test("direct media entry points reject before network, Python, timers or local media reads", async (t) => {
  const root = await fixture(t);
  let calls = 0;
  const poison = async () => { calls += 1; throw new Error("unexpected effect"); };
  const media = new MediaController({
    config: { dataDir: root, testContourRecording: { root }, voiceEnabled: false },
    token: "unused", agentHubRoot: root, telegram: poison, sendMessage: poison,
    startTurn: poison, activeProjectRoot: () => root, stopProcessTree: poison,
  });
  t.after(() => media.stop());
  for (const [method, args] of [
    ["download", ["id", path.join(root, "must-not-write")]],
    ["captureImage", [{ fileId: "id" }]],
    ["transcribeVoice", [{}, { chatId: 7 }]],
    ["analyzeImage", [{}, { chatId: 7 }]],
    ["synthesizeSpeech", ["text"]],
    ["sendVoiceFile", [7, path.join(root, "missing.ogg")]],
    ["processSpeechRequest", [7, "text"]],
  ]) await assert.rejects(media[method](...args), { code: "CONTOUR_MEDIA_EXCLUDED" });
  assert.throws(() => media.runTranscription("missing.ogg"), { code: "CONTOUR_MEDIA_EXCLUDED" });
  assert.equal(calls, 0);
  assert.equal(media.ttsWorker, null);
});

test("real outbox composition records metadata and recovers terminal ACK without external delivery", async (t) => {
  const root = await fixture(t);
  const directoryPath = path.join(root, "outbox");
  let external = 0;
  const composition = await createDeliveryOutboxComposition({
    directoryPath, recordingRoot: root, retryIntervalMs: 5000,
    runtimeTimers: { schedule() { throw new Error("test never starts timers"); } },
    isStopping: () => false, deliver: async () => { external++; },
    onDelivered: async () => { throw new Error("terminal ACK unavailable"); },
  });
  const item = await composition.deliveryOutbox.enqueue({ method: "sendMessage", body: { chat_id: 7, text: "private body" } });
  await assert.rejects(composition.deliveryOutbox.flush(), /terminal ACK unavailable/);
  const receipts = path.join(root, "delivery-receipts");
  const receiptFile = path.join(receipts, (await readdir(receipts))[0]);
  const before = await readFile(receiptFile, "utf8");
  const receipt = JSON.parse(before);
  assert.equal(receipt.deliveryId, item.id);
  assert.equal(receipt.idempotencyKey, item.id);
  assert.ok(receipt.firstAttemptId);
  assert.equal(before.includes("private body"), false);
  let acknowledged;
  const reopened = await createDeliveryOutboxComposition({
    directoryPath, recordingRoot: root, runtimeTimers: {}, isStopping: () => true,
    deliver: async () => { external++; }, onDelivered: async (value, result) => { acknowledged = { value, result }; },
  });
  await reopened.deliveryOutbox.flush();
  assert.equal(reopened.deliveryOutbox.size, 0);
  assert.equal(acknowledged.value.id, item.id);
  assert.deepEqual(acknowledged.result, receipt.result);
  assert.equal(await readFile(receiptFile, "utf8"), before);
  assert.equal(external, 0);
});

test("lost recording transport ACK reopens with same delivery identity and one receipt", async (t) => {
  const root = await fixture(t);
  const directoryPath = path.join(root, "outbox");
  const deliver = await createRecordingContourDelivery({ root });
  const first = new PersistentDeliveryOutbox({ directoryPath, retryDelay: () => 0,
    deliver: async (...args) => {
      await deliver(...args);
      throw Object.assign(new Error("lost transport ACK"), { retryable: true, uncertain: true });
    },
  });
  const item = await first.enqueue({ method: "sendPhotoFile", body: { chat_id: 8, photo_path: "missing-production-photo.png" } });
  await first.flush();
  assert.equal(first.size, 1);
  const receiptDirectory = path.join(root, "delivery-receipts");
  const receiptFile = path.join(receiptDirectory, (await readdir(receiptDirectory))[0]);
  const before = await readFile(receiptFile, "utf8");
  const reopened = new PersistentDeliveryOutbox({ directoryPath, deliver: await createRecordingContourDelivery({ root }) });
  await reopened.flush();
  assert.equal(reopened.size, 0);
  assert.equal(await readFile(receiptFile, "utf8"), before);
  assert.equal((await readdir(receiptDirectory)).length, 1);
  await assert.rejects(deliver("sendPhotoFile", { chat_id: 8, photo_path: "different" }, {
    deliveryId: item.id, idempotencyKey: item.id, attemptId: "another-attempt",
  }), /identity conflict/);
  await assert.rejects(deliver("sendMessage", { chat_id: 7 }), /requires durable outbox identity/);
});

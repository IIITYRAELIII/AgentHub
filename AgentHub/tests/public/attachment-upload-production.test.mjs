import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { launchBrowser, openFixture, bridgeCalls, persistedRecovery } from "./composer-production.fixture.mjs";

const draftKey = "agent-hub:composer-drafts:v1:vscode";
async function attach(page, size = 2 * 1024 * 1024 + 7) {
  await page.locator("[data-composer-input]").fill("Resume exact attachment");
  await page.locator("[data-file-input]").setInputFiles({ name: "archive.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(size, 7) });
  await page.waitForFunction(() => document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1);
}
async function persisted(page) { return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]"), draftKey); }

test("production Blob draft reload resumes explicit upload and retains the exact rejected message identity", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  try {
    const diagnostics = await openFixture(page, { chunkedUpload: true });
    await attach(page, 21 * 1024 * 1024 + 7);
    const before = (await persisted(page))[0];
    assert.ok(before.attachments[0].blobId);
    assert.equal(before.attachments[0].dataUrl, undefined);
    assert.ok(JSON.stringify(before).length < 6000);
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1);
    assert.equal((await persisted(page))[0].attachments[0].blobId, before.attachments[0].blobId);
    await page.evaluate(() => localStorage.setItem("fixture:upload-mode", "fail-once"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.locator("[data-upload-resume]").waitFor({ state: "visible" });
    assert.match(await page.title(), /Agent Hub/iu);
    assert.equal(new URL(page.url()).hostname, "agent-hub.test");
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "agent-hub-upload-desktop.png") });
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    await page.locator("[data-upload-resume]").click();
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Resume exact attachment");
    const first = (await bridgeCalls(page, "send-message"))[0];
    const restored = (await persisted(page))[0];
    assert.equal(restored.recoveryRequestId, first.params.clientUserMessageId);
    assert.equal(restored.attachments[0].uploadId, before.attachments[0].uploadId);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]").filter((entry) => entry.action === "send-message").length === 2);
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends[1].params.clientUserMessageId, first.params.clientUserMessageId);
    assert.equal(sends[1].params.attachments[0], first.params.attachments[0]);
    const uploads = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]"));
    assert.equal(uploads.filter((entry) => entry.method === "PUT").length, 22);
    assert.ok(uploads.filter((entry) => entry.method === "PUT").every((entry) => entry.size <= 1024 * 1024));
    assert.deepEqual(diagnostics.filter((message) => !message.includes("503")), []);
  } finally { await browser.close(); }
});

test("browser resumes an unreceived begin under one upload and message identity with visible stage evidence", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(6000);
  const batches = [];
  const firstTraceFailure = Promise.withResolvers();
  let failedTrace = false;
  try {
    await openFixture(page, { chunkedUpload: true });
    await page.route("**/api/command-trace/client-events", async (route) => {
      const events = route.request().postDataJSON().events;
      if (!failedTrace && events.some((event) => event.stage === "attachment-upload")) {
        failedTrace = true;
        await route.abort("failed");
        firstTraceFailure.resolve();
        return;
      }
      batches.push(...events);
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await attach(page, 3);
    const original = (await persisted(page))[0].attachments[0].uploadId;
    await page.evaluate(() => localStorage.setItem("fixture:upload-mode", "drop-begin-once"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.locator("[data-upload-resume]").waitFor({ state: "visible" });
    await firstTraceFailure.promise;
    assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem("agent-hub-upload-trace-v1") ?? "[]"))).length > 0,
      "failed telemetry remains in bounded browser storage");
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    await page.locator("[data-upload-resume]").click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
      .some((entry) => entry.action === "send-message"));
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends.length, 1);
    const uploads = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]"));
    assert.equal(uploads.filter((entry) => entry.method === "POST" && !entry.id).length, 1);
    assert.ok(uploads.every((entry) => !entry.id || entry.id === original));
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("agent-hub-upload-trace-v1") ?? "[]").length === 0);
    const spans = batches.filter((event) => event.stage === "attachment-upload");
    assert.ok(spans.some((event) => event.metadata.action === "pause-wait"));
    assert.ok(spans.some((event) => event.metadata.action === "begin-recovery"));
    assert.ok(spans.every((event) => event.metadata.uploadId === original));
    assert.ok(spans.some((event) => event.metadata.messageRequestId === sends[0].params.clientUserMessageId));
    assert.ok(spans.some((event) => event.metadata.serverOwnerMs === 4.5));
  } finally { await browser.close(); }
});

test("browser reload retains the first begin deadline before a manual same-ID retry", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  try {
    await openFixture(page, { chunkedUpload: true });
    await attach(page, 3);
    const original = (await persisted(page))[0].attachments[0].uploadId;
    await page.evaluate(() => localStorage.setItem("fixture:upload-mode", "drop-begin-once"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.locator("[data-upload-resume]").waitFor({ state: "visible" });
    const attemptedAtMs = await page.evaluate(async (id) => new Promise((resolve, reject) => {
      const open = indexedDB.open("agent-hub-composer-files-v1", 1);
      open.onsuccess = () => {
        const read = open.result.transaction("files", "readonly").objectStore("files").get(id);
        read.onsuccess = () => resolve(read.result?.uploadAttemptedAt);
        read.onerror = () => reject(read.error);
      };
      open.onerror = () => reject(open.error);
    }), original);
    assert.ok(Number.isSafeInteger(attemptedAtMs));
    await page.locator("[data-upload-cancel]").click();
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Resume exact attachment");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1);
    assert.equal((await persisted(page))[0].attachments[0].uploadId, original);
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
      .some((entry) => entry.action === "send-message"));
    const uploads = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]"));
    assert.equal(uploads.filter((entry) => entry.method === "POST" && !entry.id).length, 1);
    assert.equal(uploads.find((entry) => entry.method === "POST" && !entry.id).value.attemptedAtMs, attemptedAtMs);
    assert.ok(uploads.every((entry) => !entry.id || entry.id === original));
  } finally { await browser.close(); }
});

test("production cancel stops preparation and restores original durable Blob draft without message admission", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6000);
  try {
    await openFixture(page, { chunkedUpload: true });
    await page.evaluate(() => window.AgentHub.showSelectedTask());
    await attach(page);
    const original = (await persisted(page))[0].attachments[0];
    await page.evaluate(() => localStorage.setItem("fixture:upload-mode", "fail-once"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.locator("[data-upload-resume]").waitFor({ state: "visible" });
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "agent-hub-upload-mobile.png") });
    await page.locator("[data-upload-cancel]").click();
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Resume exact attachment");
    const draft = (await persisted(page))[0];
    assert.ok(draft.recoveryRequestId);
    assert.equal(draft.attachments[0].uploadId, original.uploadId);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(await page.locator("[data-upload-cancel]").count(), 0);
  } finally { await browser.close(); }
});

test("production unavailable Blob storage keeps memory draft and refuses a false durable recovery", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  try {
    await page.addInitScript(() => {
      const original = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, ...args) {
        if (name === "agent-hub-composer-files-v1") throw new DOMException("quota", "QuotaExceededError");
        return original.call(this, name, ...args);
      };
    });
    await openFixture(page, { chunkedUpload: true });
    await attach(page, 7);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
    assert.equal((await persisted(page))[0].attachments.length, 0);
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Resume exact attachment");
    assert.equal((await persisted(page))[0].recoveryRequestId, undefined);
    assert.equal(await page.locator("[data-attachment-index]").count(), 1);
    assert.equal(await page.evaluate(() => window.AgentHub.prepareForRuntimeReload()), false);
  } finally { await browser.close(); }
});

test("production legacy upload completion after cancel cannot admit a message", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  page.setDefaultTimeout(6000);
  try {
    await openFixture(page, { persistedDrafts: [persistedRecovery({
      requestId: "legacy-original-id", text: "Legacy cancellation",
      attachments: [{ name: "legacy.png", type: "image/png", size: 3, dataUrl: "data:image/png;base64,AQID" }],
    })] });
    await page.evaluate(() => localStorage.setItem("fixture:upload-mode", "hold"));
    await page.locator("[data-composer]").evaluate((form) => form.requestSubmit());
    await page.waitForFunction(() => Boolean(window.__agentHubFixture.heldUpload));
    await page.locator("[data-upload-cancel]").click();
    await page.evaluate(() => window.__releaseHeldUpload());
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Legacy cancellation");
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal((await persisted(page))[0].recoveryRequestId, "legacy-original-id");
  } finally { await browser.close(); }
});

async function holdStorageCompletion(page, allWrites = false) {
  await page.evaluate((allWrites) => {
    const original = IDBDatabase.prototype.transaction;
    window.__attemptArchiveScans = 0;
    IDBDatabase.prototype.transaction = function (...args) {
      const tx = original.apply(this, args);
      if (this.name !== "agent-hub-composer-files-v1" || args[1] !== "readwrite") return tx;
      let callback;
      let archive = false;
      Object.defineProperty(tx, "oncomplete", {
        configurable: true, get: () => callback, set: value => { callback = value; },
      });
      tx.addEventListener("complete", event => {
        if (!allWrites && !archive) callback?.call(tx, event);
      });
      const objectStore = tx.objectStore.bind(tx);
      tx.objectStore = (...names) => {
        const store = objectStore(...names);
        const cursor = store.openCursor.bind(store);
        store.openCursor = (...options) => {
          archive = true; window.__attemptArchiveScans += 1;
          return cursor(...options);
        };
        return store;
      };
      return tx;
    };
  }, allWrites);
}

test("production attempt metadata avoids a stalled archive while three original PNGs reach message admission", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  try {
    const issues = await openFixture(page, { chunkedUpload: true });
    await page.locator("[data-composer-input]").fill("Three own fixture screenshots");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
    await page.locator("[data-file-input]").setInputFiles([1, 2, 3].map(n => ({
      name: `own-${n}.png`, mimeType: "image/png", buffer: png,
    })));
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 3);
    const originals = (await persisted(page))[0].attachments.map(file => file.uploadId);
    await holdStorageCompletion(page);
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    await page.locator("[data-composer]").evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
      .some(entry => entry.action === "send-message") || document.querySelector("[data-upload-resume]"));
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends.length, 1, "unrelated archive traversal cannot prevent these prepared files from sending");
    assert.equal(await page.evaluate(() => window.__attemptArchiveScans), 0);
    const uploads = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]"));
    assert.deepEqual(uploads.filter(entry => entry.method === "POST" && !entry.id).map(entry => entry.value.uploadId), originals);
    assert.equal(sends[0].params.attachments.length, 3);
    assert.deepEqual(issues, []);
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "attempt-three-png-after.png") });
  } finally { await browser.close(); }
});

test("production paused storage timeout retains its file and never labels it a Hub disconnection", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(15000);
  try {
    await openFixture(page, { chunkedUpload: true });
    await page.evaluate(() => window.AgentHub.showSelectedTask());
    await attach(page, 4096);
    const original = (await persisted(page))[0].attachments[0];
    await holdStorageCompletion(page, true);
    await page.locator("[data-composer]").evaluate(form => form.requestSubmit());
    await page.locator("[data-upload-resume]").waitFor({ state: "visible" });
    const paused = await page.getByText(/Загрузка приостановлена:/u).innerText();
    assert.match(paused, /локальное хранилище/u);
    assert.doesNotMatch(paused, /Нет связи с Agent Hub/u);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    const retained = await page.evaluate(manifest => {
      const record = AgentHubComposerFiles.resolve(manifest);
      return { uploadId: record?.uploadId, size: record?.blob.size,
        pendingId: record?.pendingUploadAttempt?.uploadAttemptId, durable: record?.durable };
    }, original);
    assert.equal(retained.uploadId, original.uploadId);
    assert.equal(retained.pendingId, original.uploadId);
    assert.equal(retained.size, 4096);
    assert.equal(retained.durable, false, "an unconfirmed write cannot promise reload recovery");
    const uploads = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]"));
    assert.equal(uploads.filter(entry => entry.method === "POST" && !entry.id).length, 0);
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "attempt-storage-error-after.png") });
  } finally { await browser.close(); }
});

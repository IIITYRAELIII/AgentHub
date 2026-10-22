import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { createLocalWebviewSession } from "../../src/interfaces/web/local-webview-session.mjs";
import { attachmentUploadLimits } from "../../src/domain/attachment-upload-policy.mjs";
import { launchBrowser, openFixture, bridgeCalls } from "./composer-production.fixture.mjs";

test("fresh upload uses its authenticated begin receipt without another HTTP status round trip", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hub-upload-latency-"));
  const secret = "q".repeat(43);
  let server;
  const context = vm.createContext({ Blob, URL, crypto: webcrypto, Uint8Array, console });
  context.window = context;
  try {
    server = new MiniAppServer({ port: 0, attachmentDirectory: root, localAccessSecret: secret,
      journalDatabase: { metadata: async () => ({ version: "upload-fixture", revision: 0 }), subscribe: () => () => {} } });
    for (const name of ["composer-files.js", "upload.js"]) {
      vm.runInContext(await readFile(new URL(`../../assets/web-app/attachments/${name}`, import.meta.url), "utf8"), context);
    }
    const address = await server.start();
    const token = createLocalWebviewSession(secret).token;
    const calls = [];
    const uploader = context.AgentHubAttachmentUpload.create({ request: async (pathname, init) => {
      const { traceUploadId, traceRequestId, traceChunkIndex, ...wire } = init;
      calls.push({ method: init.method, id: new URL(pathname, address.url).searchParams.get("id"), traceUploadId, traceRequestId });
      return fetch(new URL(pathname, address.url), { ...wire, headers: { ...wire.headers, Authorization: `webview ${token}` } });
    } });
    const bytes = Buffer.alloc(4096, 7);
    const file = await context.AgentHubComposerFiles.prepare(new Blob([bytes]), { name: "screen.bin", type: "application/octet-stream", size: bytes.length });
    await uploader.validateBatch([file], { traceRequestId: "latency-message" });
    const target = await uploader.upload(file, { traceRequestId: "latency-message" });
    assert.deepEqual(await readFile(target), bytes, "the resulting attachment is available to the receiving owner");
    assert.equal(calls.filter((call) => call.method === "GET" && call.id).length, 0,
      "begin already returns the exact authoritative receipt");
    assert.equal(calls[0].traceUploadId, file.uploadId, "first capabilities/auth wait belongs to this upload");
    assert.equal(calls[0].traceRequestId, "latency-message");
    const beforeRetry = calls.length;
    assert.equal(await uploader.upload(file, { traceRequestId: "latency-message" }), target);
    assert.deepEqual(calls.slice(beforeRetry).map((call) => call.method), ["GET"],
      "an already-ready receipt never retransmits file bytes or completes again");
  } finally {
    await server?.close();
    assert.equal(path.dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test("real HTTP expired receipt stays expired while retained bytes use a new transport attempt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hub-upload-expiry-"));
  const secret = "q".repeat(43); let server;
  const context = vm.createContext({ Blob, URL, crypto: webcrypto, Uint8Array, console }); context.window = context;
  try {
    server = new MiniAppServer({ port: 0, attachmentDirectory: root, localAccessSecret: secret,
      attachmentUploadPolicy: { ...attachmentUploadLimits(), ttlMs: 2000 },
      journalDatabase: { metadata: async () => ({ version: "expiry-fixture", revision: 0 }), subscribe: () => () => {} } });
    for (const name of ["composer-files.js", "upload.js"]) vm.runInContext(
      await readFile(new URL(`../../assets/web-app/attachments/${name}`, import.meta.url), "utf8"), context);
    const address = await server.start(); const token = createLocalWebviewSession(secret).token;
    const calls = []; const request = (pathname, init) => {
      const { traceUploadId, traceAttemptId, traceRequestId, traceChunkIndex, ...wire } = init;
      calls.push({ method: init.method, id: new URL(pathname, address.url).searchParams.get("id"),
        beginId: init.method === "POST" && init.body ? JSON.parse(init.body).uploadId : null });
      return fetch(new URL(pathname, address.url), { ...wire, headers: { ...wire.headers, Authorization: `webview ${token}` } });
    };
    const uploader = context.AgentHubAttachmentUpload.create({ request });
    const bytes = Buffer.alloc(4096, 7); const file = await context.AgentHubComposerFiles.prepare(new Blob([bytes]),
      { name: "retained.bin", type: "application/octet-stream", size: bytes.length });
    const originalId = file.uploadId; const manifest = JSON.stringify(context.AgentHubComposerFiles.serialized(file));
    const oldPath = await uploader.upload(file); await new Promise(resolve => setTimeout(resolve, 2100));
    const renewed = []; const freshPath = await uploader.upload(file, { progress: (_bytes, _total, recovery) => { if (recovery) renewed.push(recovery); } });
    assert.notEqual(freshPath, oldPath); assert.equal(file.uploadId, originalId);
    assert.notEqual(file.uploadAttemptId, originalId); assert.equal(JSON.stringify(context.AgentHubComposerFiles.serialized(file)), manifest);
    assert.deepEqual(await readFile(freshPath), bytes); assert.deepEqual(await readFile(oldPath), bytes);
    assert.deepEqual(calls.filter(call => call.beginId).map(call => call.beginId), [originalId, file.uploadAttemptId]);
    const expired = await request(`/api/attachment-upload?id=${originalId}`, { method: "GET" });
    assert.equal(expired.status, 410); assert.equal((await expired.json()).state, "expired");
    assert.equal(renewed.length, 1); assert.equal(renewed[0].reason, "expired");
  } finally { await server?.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); }
});

async function expiredPreviewSend(lostAdmission = false) {
  const browser = await launchBrowser(); const page = await browser.newPage();
  const releaseBegin = Promise.withResolvers();
  try {
    const errors = await openFixture(page, { chunkedUpload: true });
    await page.evaluate(mode => localStorage.setItem("fixture:send-mode", mode), lostAdmission ? "disconnect" : "accept");
    await page.locator("[data-composer-input]").fill("retained text and sibling");
    await page.locator("[data-file-input]").setInputFiles([
      { name: "expired.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(16, 7) },
      { name: "sibling.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(16, 8) },
    ]);
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 2);
    const ids = await page.evaluate(async () => {
      const draft = JSON.parse(localStorage.getItem("agent-hub:composer-drafts:v1:vscode"))[0];
      await AgentHubComposerFiles.markUploadStarted(draft.attachments[0]);
      return draft.attachments.map(file => file.uploadId);
    });
    await page.route(`**/api/attachment-upload?id=${ids[0]}`, route => route.fulfill({ status: 410,
      contentType: "application/json", body: '{"error":"expired","state":"expired"}' }));
    const traces = []; let expiryResponses = 0;
    page.on("response", response => { if (response.status() === 410) expiryResponses += 1; });
    await page.route("**/api/command-trace/client-events", async route => {
      traces.push(...route.request().postDataJSON().events);
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await page.route("**/api/attachment-upload", async route => {
      if (route.request().method() === "POST") await releaseBegin.promise;
      await route.fallback();
    });
    const freshBegin = page.waitForRequest(request => request.method() === "POST"
      && new URL(request.url()).pathname === "/api/attachment-upload"
      && !new URL(request.url()).search, { timeout: 10_000 });
    await page.locator("[data-composer]").evaluate(form => form.requestSubmit());
    await freshBegin;
    await page.getByText("Срок прежней загрузки истёк. Загружаю сохранённый файл заново…", { exact: true }).first().waitFor();
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "expired-attempt-recovery.png") });
    releaseBegin.resolve();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
      .some(entry => entry.action === "send-message"));
    if (lostAdmission) {
      const retry = page.locator("[data-message-retry-unconfirmed]"); await retry.waitFor({ state: "visible" });
      const original = await bridgeCalls(page, "send-message"); assert.equal(original.length, 3);
      const before = await page.evaluate(() => localStorage.getItem("fixture:upload-log"));
      await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept")); await retry.click();
      await retry.waitFor({ state: "detached" });
      const retried = await bridgeCalls(page, "send-message"); assert.equal(retried.length, 4);
      const payload = ({ params: { clientTiming: _timing, ...params } }) => params;
      for (const call of retried) assert.deepEqual(payload(call), payload(original[0]));
      assert.equal(await page.evaluate(() => localStorage.getItem("fixture:upload-log")), before,
        "unknown message retry must use its frozen uploaded paths, without renewing or uploading again");
    }
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "");
    const sends = await bridgeCalls(page, "send-message"); assert.equal(sends.length, lostAdmission ? 4 : 1);
    assert.equal(new Set(sends.map(call => call.params.clientUserMessageId)).size, 1);
    assert.equal(sends[0].params.text, "retained text and sibling");
    const uploaded = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]"));
    const begins = uploaded.filter(entry => entry.method === "POST" && !entry.id).map(entry => entry.value.uploadId);
    assert.equal(begins.length, 2); assert.notEqual(begins[0], ids[0]); assert.equal(begins[1], ids[1]);
    assert.equal(sends[0].params.attachments.length, 2);
    assert.ok(sends[0].params.attachments[0].includes(begins[0]));
    assert.ok(sends[0].params.attachments[1].includes(ids[1]));
    assert.equal(await page.locator("[data-attachment-index]").count(), 0);
    const drainDeadline = performance.now() + 10_000;
    let drainBatches = 0;
    let drainFailure = null;
    const waitForTraceIdle = () => page.waitForFunction(() => !AgentHubCommandTrace.diagnostics().flushing,
      null, { timeout: Math.max(1, drainDeadline - performance.now()) }).then(handle => handle.dispose());
    try {
      while (drainBatches < 32 && performance.now() < drainDeadline) {
        await waitForTraceIdle();
        await page.evaluate(() => { void AgentHubCommandTrace.flush(); });
        drainBatches += 1;
        await waitForTraceIdle();
        if (await page.evaluate(() => !AgentHubCommandTrace.diagnostics().pending)) break;
      }
    } catch (error) { drainFailure = error.name; }
    const drainState = await page.evaluate(() => AgentHubCommandTrace.diagnostics());
    assert.ok(!drainFailure && !drainState.pending && !drainState.retainedUpload && !drainState.flushing,
      `upload trace drain incomplete: ${JSON.stringify({ batches: drainBatches, failure: drainFailure, ...drainState })}`);
    const uploadTraces = traces.filter(span => span.stage === "attachment-upload");
    assert.ok(uploadTraces.some(span => span.metadata.uploadState === "expired" && span.commandId === ids[0]
      && span.metadata.uploadAttemptId === ids[0]));
    assert.ok(uploadTraces.some(span => span.metadata.action === "begin" && span.commandId === ids[0]
      && span.metadata.uploadAttemptId === begins[0] && span.metadata.messageRequestId === sends[0].params.clientUserMessageId));
    assert.equal(expiryResponses, 1);
    assert.doesNotMatch(JSON.stringify(uploadTraces), /expired\.bin|sibling\.bin|retained text/u);
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "expired-attempt-sent-once.png") });
    assert.deepEqual(errors.filter(error => !/Failed to load resource: the server responded with a status of 410/u.test(error)), []);
  } finally { releaseBegin.resolve(); await browser.close(); }
}

test("ready expired preview preserves message identity and siblings through success or unknown retry", { timeout: 45_000 }, async () => {
  await expiredPreviewSend(false); await expiredPreviewSend(true);
});

test("failed local preparation keeps both selected files and retries only failed work under the same identity", { timeout: 25_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(3000);
  try {
    const errors = await openFixture(page, { chunkedUpload: true });
    const spans = [];
    await page.route("**/api/command-trace/client-events", async (route) => {
      spans.push(...route.request().postDataJSON().events);
      await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
    });
    await page.evaluate(() => {
      const files = window.AgentHubComposerFiles;
      window.__preparationAttempts = [];
      window.AgentHubComposerFiles = { ...files, prepare: (...args) => {
        window.__preparationAttempts.push(args[2]?.uploadId);
        return files.prepare(...args);
      } };
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let fail = true;
      crypto.subtle.digest = (...args) => {
        if (fail) { fail = false; return Promise.reject(new DOMException("Synthetic local read timeout", "TimeoutError")); }
        return digest(...args);
      };
    });
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZf8AAAAASUVORK5CYII=", "base64");
    await page.locator("[data-file-input]").setInputFiles([
      { name: "first.png", mimeType: "image/png", buffer: image },
      { name: "second.png", mimeType: "image/png", buffer: image },
    ]);
    const retry = page.locator("[data-attachment-preparation-retry]").first();
    await retry.waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-attachment-preparing]").count(), 2);
    const ids = await page.locator("[data-attachment-preparing]").evaluateAll((nodes) => nodes.map((node) => node.dataset.attachmentPreparationId));
    assert.ok(ids.every(Boolean));
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.match(await page.title(), /Agent Hub/iu);
    assert.equal(new URL(page.url()).hostname, "agent-hub.test");
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "preparation-retained.png") });
    await retry.click();
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-index]").length === 2);
    const drafts = await page.evaluate(() => JSON.parse(localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]"));
    assert.deepEqual(drafts[0].attachments.map((file) => file.uploadId), ids);
    assert.deepEqual(await page.evaluate(() => window.__preparationAttempts), [ids[0], ids[1], ids[0]]);
    assert.equal(await page.locator("[data-attachment-preparing]").count(), 0);
    for (let batch = 0; batch < 8; batch += 1) {
      const pending = await page.evaluate(async () => {
        await AgentHubCommandTrace.flush();
        return AgentHubCommandTrace.diagnostics().pending;
      });
      if (!pending) break;
    }
    const preparation = spans.filter((span) => span.stage === "attachment-upload");
    assert.ok(preparation.some((span) => span.commandId === ids[0] && span.metadata.action === "attachment-hash"
      && span.outcome === "failed" && span.metadata.failureKind === "timeout"));
    assert.ok(preparation.some((span) => span.commandId === ids[1] && span.metadata.action === "attachment-storage-verify"
      && span.outcome === "succeeded"));
    assert.ok(preparation.every((span) => ids.includes(span.metadata.uploadId)));
    assert.equal(JSON.stringify(preparation).includes("Synthetic local read timeout"), false);
    assert.equal(JSON.stringify(preparation).includes("first.png"), false);
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "preparation-retried.png") });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("removing a ready file preserves failed originals and prepared siblings for same-ID retry", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    // No text: removing the sole ready file also crosses the empty-draft path.
    for (const keepSibling of [false, true]) {
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      const errors = await openFixture(page, { chunkedUpload: true });
      const file = (name) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.alloc(16, 7) });
      await page.locator("[data-file-input]").setInputFiles([
        file("ready.bin"), ...(keepSibling ? [file("sibling.bin")] : []),
      ]);
      await page.waitForFunction((count) => document.querySelectorAll("[data-attachment-index]").length === count,
        keepSibling ? 2 : 1);
      const readDraft = () => page.evaluate(() => JSON.parse(localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]")[0]);
      const before = await readDraft();
      await page.evaluate(() => {
        const files = window.AgentHubComposerFiles;
        window.__retryAttempts = [];
        window.AgentHubComposerFiles = { ...files, prepare: (...args) => {
          window.__retryAttempts.push(args[2]?.uploadId);
          return files.prepare(...args);
        } };
        const digest = crypto.subtle.digest.bind(crypto.subtle);
        let fail = true;
        crypto.subtle.digest = (...args) => {
          if (fail) { fail = false; return Promise.reject(new DOMException("Synthetic read timeout", "TimeoutError")); }
          return digest(...args);
        };
      });
      await page.locator("[data-file-input]").setInputFiles(file("failed.bin"));
      const retry = page.locator("[data-attachment-preparation-retry]");
      await retry.waitFor({ state: "visible" });
      const originalId = await retry.getAttribute("data-attachment-preparation-retry");
      const preview = await page.locator("[data-attachment-preparing]").getAttribute("data-attachment-preparation-id");
      assert.equal(preview, originalId);
      await page.locator('[data-attachment-index="0"]').click();
      assert.equal(await page.locator("[data-attachment-preparing]").count(), 1);
      assert.equal(await retry.getAttribute("data-attachment-preparation-retry"), originalId);
      assert.equal(await retry.isVisible(), true);
      assert.equal(await page.locator("[data-composer-send]").isDisabled(), true);
      if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR,
        `ready-remove-retained-${keepSibling}.png`) });
      await retry.click();
      await page.waitForFunction((count) => document.querySelectorAll("[data-attachment-index]").length === count
        && !document.querySelector("[data-attachment-preparing]"), keepSibling ? 2 : 1);
      const after = await readDraft();
      assert.deepEqual(after.attachments.map((item) => item.name), [...(keepSibling ? ["sibling.bin"] : []), "failed.bin"]);
      assert.deepEqual(after.attachments.map((item) => item.uploadId), [
        ...(keepSibling ? [before.attachments[1].uploadId] : []), originalId,
      ]);
      assert.deepEqual(await page.evaluate(() => window.__retryAttempts), [originalId, originalId]);
      assert.equal((await bridgeCalls(page, "send-message")).length, 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

test("removing a failed live preview preserves its prepared sibling without sending", { timeout: 20_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(3000);
  try {
    const errors = await openFixture(page, { chunkedUpload: true });
    await page.locator('[data-mobile-button="chat"]').click();
    await page.evaluate(() => {
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let fail = true;
      crypto.subtle.digest = (...args) => {
        if (fail) { fail = false; return Promise.reject(new DOMException("Synthetic local read failure", "NotReadableError")); }
        return digest(...args);
      };
    });
    await page.locator("[data-file-input]").setInputFiles([
      { name: "failed.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(16, 7) },
      { name: "retained.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(16, 7) },
    ]);
    await page.locator("[data-attachment-preparation-retry]").waitFor({ state: "visible" });
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "preparation-mobile-retained.png") });
    await page.locator('[data-attachment-preparation-remove][aria-label="Удалить failed.bin"]').click();
    await page.waitForFunction(() => document.querySelectorAll("[data-attachment-preparing]").length === 0);
    assert.equal(await page.locator("[data-attachment-index]").count(), 1);
    const retained = await page.evaluate(() => JSON.parse(localStorage.getItem("agent-hub:composer-drafts:v1:vscode") ?? "[]"));
    assert.equal(retained[0].attachments[0].name, "retained.bin");
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

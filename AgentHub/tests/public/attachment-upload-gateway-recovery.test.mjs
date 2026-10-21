import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { readFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { createLocalWebviewSession } from "../../src/interfaces/web/local-webview-session.mjs";
import { UPLOAD_TRACE_HEADERS } from "../../src/interfaces/web/upload-transport-trace.mjs";
import { launchBrowser, openFixture, bridgeCalls } from "./composer-production.fixture.mjs";

for (const lostStage of ["begin", "chunk", "complete"]) test(`actual HTTP lost ${lostStage} reply preserves original upload and skips acknowledged bytes on explicit resume`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-gateway-upload-"));
  const secret = "q".repeat(43), spans = [], calls = [], clientSpans = [];
  const context = vm.createContext({ Blob, URL, Response, crypto: webcrypto, Uint8Array, console });
  context.window = context;
  const server = new MiniAppServer({ port: 0, localAccessSecret: secret, attachmentDirectory: root,
    recordCommandTrace: span => spans.push(span),
    journalDatabase: { metadata: async () => ({ version: "upload-gateway-fixture", revision: 0 }), subscribe: () => () => {} } });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  for (const name of ["composer-files.js", "upload.js"]) vm.runInContext(
    await readFile(new URL(`../../assets/web-app/attachments/${name}`, import.meta.url), "utf8"), context);
  const address = await server.start(), token = createLocalWebviewSession(secret).token;
  let lose = true;
  const uploader = context.AgentHubAttachmentUpload.create({
    trace: (action, operation, identity) => { clientSpans.push({ action, ...identity }); return operation(); },
    request: async (pathname, init) => {
      const url = new URL(pathname, address.url);
      const stage = init.method === "PUT" ? "chunk" : init.method === "POST" ? url.searchParams.has("complete") ? "complete" : "begin" : "status";
      calls.push({ stage, method: init.method, id: url.searchParams.get("id"), requestId: init.headers["X-Agent-Hub-Upload-Request-Id"] });
      const response = await fetch(url, { method: init.method, body: init.body, signal: init.signal,
        headers: { ...init.headers, Authorization: `webview ${token}`, Origin: "vscode-webview://fixture" } });
      if (stage === lostStage && lose) {
        lose = false;
        assert.equal(response.status, 200);
        await response.text(); // The real authenticated owner committed; only its response is lost.
        return new Response("", { status: 502 });
      }
      assert.ok(response.headers.get("Access-Control-Expose-Headers").includes("X-Agent-Hub-Upload-Request-Id"));
      assert.equal(response.headers.get("X-Agent-Hub-Upload-Request-Id"), init.headers["X-Agent-Hub-Upload-Request-Id"]);
      return response;
    },
  });
  const bytes = Buffer.alloc(4096, 7), messageId = randomUUID();
  const file = await context.AgentHubComposerFiles.prepare(new Blob([bytes]), { name: "private-file-name.bin", type: "application/octet-stream", size: bytes.length });
  const originalId = file.uploadId;
  await assert.rejects(uploader.upload(file, { traceRequestId: messageId }), error => {
    assert.equal(error.attachmentUploadStatus, 502);
    assert.equal(error.attachmentUploadAction, lostStage);
    assert.equal(error.attachmentUploadTerminal, false);
    assert.match(error.message, /Файл сохранён в черновике/u);
    return true;
  });
  const boundary = calls.length;
  const target = await uploader.upload(file, { traceRequestId: messageId });
  assert.deepEqual(await readFile(target), bytes);
  assert.equal(file.uploadId, originalId);
  assert.equal(context.AgentHubComposerFiles.resolve(file).uploadAttemptId, originalId);
  assert.equal(calls.filter(c => c.stage === "begin").length, 1);
  if (lostStage !== "begin") assert.equal(calls.slice(boundary).some(c => c.stage === "chunk"), false);
  if (lostStage === "complete") assert.deepEqual(calls.slice(boundary).map(c => c.method), ["GET"]);
  assert.equal(new Set(calls.map(c => c.requestId)).size, calls.length);
  assert.ok(spans.filter(s => s.metadata.httpRequestId).every(s => s.commandId === originalId && s.metadata.messageRequestId === messageId));
  assert.ok(clientSpans.some(s => s.traceHttpRequestId === calls.at(-1).requestId));
  assert.equal(JSON.stringify(spans).includes(token), false);
  assert.equal(JSON.stringify(spans).includes("private-file-name"), false);
  const preflight = await fetch(new URL("/api/attachment-upload", address.url), { method: "OPTIONS", headers: { Origin: "vscode-webview://fixture" } });
  assert.equal(preflight.status, 204);
  for (const header of UPLOAD_TRACE_HEADERS) assert.ok(preflight.headers.get("Access-Control-Allow-Headers").toLowerCase().includes(header));
});

test("non-JSON capability 502 has a retryable stage and never begins a new upload", async () => {
  const context = vm.createContext({ crypto: webcrypto }); context.window = context;
  vm.runInContext(await readFile(new URL("../../assets/web-app/attachments/upload.js", import.meta.url), "utf8"), context);
  let requests = 0;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (_path, init) => {
    requests += 1; assert.equal(init.method, "GET"); return new Response("upstream unavailable", { status: 502 });
  } });
  await assert.rejects(uploader.capabilities({ traceUploadId: randomUUID() }), error => {
    assert.equal(error.attachmentUploadAction, "capabilities");
    assert.equal(error.attachmentUploadStatus, 502);
    assert.match(error.message, /согласование загрузки/u);
    return true;
  });
  assert.equal(requests, 1);
});

// Browser plugin not available; actual shipped UI in the isolated Edge fixture.
test("rendered 502 names the chunk stage and explicit resume retains original Blob and message identity", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const diagnostics = await openFixture(page, { chunkedUpload: true });
    await page.evaluate(() => localStorage.setItem("fixture:send-mode", "accept"));
    let failed = false, messageId, uploadId;
    await page.route("**/api/attachment-upload?**", async route => {
      if (!failed && route.request().method() === "PUT") {
        failed = true;
        messageId = route.request().headers()["x-agent-hub-message-request-id"];
        uploadId = route.request().headers()["x-agent-hub-upload-id"];
        return route.fulfill({ status: 502, body: "" });
      }
      return route.fallback();
    });
    await page.locator("[data-composer-input]").fill("Retain screenshot on 502");
    await page.locator("[data-file-input]").setInputFiles({ name: "synthetic.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(4096, 7) });
    await page.waitForFunction(() => document.querySelectorAll("[data-attachments] [data-attachment-index]").length === 1);
    const original = await page.evaluate(() => JSON.parse(localStorage.getItem("agent-hub:composer-drafts:v1:vscode"))[0].attachments[0]);
    await page.locator("[data-composer]").evaluate(form => form.requestSubmit());
    const resume = page.locator("[data-upload-resume]").first();
    await resume.waitFor({ state: "visible" });
    await page.getByText(/передача части, HTTP 502/u).first().waitFor({ state: "visible" });
    assert.equal(uploadId, original.uploadId);
    assert.ok(messageId);
    const retained = await page.evaluate(() => window.AgentHubRetainedUploadAttachments().map(file => ({ uploadId: file.uploadId, blobId: file.blobId })));
    assert.ok(retained.some(file => file.uploadId === original.uploadId && file.blobId === original.blobId));
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(page.url(), "http://agent-hub.test/");
    assert.match(await page.title(), /Agent Hub/iu);
    if (process.env.AGENT_HUB_UPLOAD_QA_DIR) {
      await mkdir(process.env.AGENT_HUB_UPLOAD_QA_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_UPLOAD_QA_DIR, "gateway502-retained-preview.png") });
    }
    await resume.click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]").filter(entry => entry.action === "send-message").length === 1);
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].params.clientUserMessageId, messageId);
    const begins = await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:upload-log") ?? "[]").filter(entry => entry.method === "POST" && !entry.id));
    assert.equal(begins.length, 1);
    assert.deepEqual(diagnostics.filter(message => !/Failed to load resource: the server responded with a status of 502/u.test(message)), []);
  } finally { await browser.close(); }
});

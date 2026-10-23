import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { MiniAppServer } from "../../src/interfaces/web/mini-app-server.mjs";
import { createLocalWebviewSession } from "../../src/interfaces/web/local-webview-session.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "hub-receipt-body-"));
  const secret = "q".repeat(43);
  const server = new MiniAppServer({ host: "127.0.0.1", port: 0, attachmentDirectory: root, localAccessSecret: secret,
    journalDatabase: { metadata: async () => ({ version: "receipt-fixture", revision: 0 }), subscribe: () => () => {} } });
  const context = vm.createContext({ Blob, URL, crypto: webcrypto, Uint8Array, console }); context.window = context;
  for (const name of ["composer-files.js", "upload.js"]) vm.runInContext(
    await readFile(new URL(`../../assets/web-app/attachments/${name}`, import.meta.url), "utf8"), context);
  const address = await server.start(), token = createLocalWebviewSession(secret).token;
  const calls = [], traceFailures = [];
  let fault = null;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (pathname, init) => {
    const u = new URL(pathname, address.url);
    const action = init.method === "GET" ? u.searchParams.has("id") ? "status" : "capabilities"
      : init.method === "PUT" ? "chunk" : u.searchParams.has("complete") ? "complete" : "begin";
    calls.push({ action, id: u.searchParams.get("id"), beginId: action === "begin" ? JSON.parse(init.body).uploadId : null });
    const response = await fetch(u, { ...init, headers: { ...init.headers, Authorization: `webview ${token}` } });
    if (!fault || fault.action !== action) return response;
    const selected = fault; fault = null;
    const receipt = await response.json();
    if (selected.kind === "foreign-id") return Response.json({ ...receipt, uploadId: webcrypto.randomUUID() });
    if (selected.kind === "foreign-protocol") return Response.json({ ...receipt, protocol: "foreign-protocol" });
    if (selected.kind === "generic-404") return new Response("{", { status: 404 });
    if (selected.kind === "malformed") return new Response("{", { status: 200 });
    return new Response(new ReadableStream({ start(controller) {
      controller.error(new DOMException("synthetic lost receipt body", "AbortError"));
    } }), { status: 200 });
  }, trace: async (action, operation) => {
    try { return await operation(); }
    catch (error) { traceFailures.push({ action, name: error.name }); throw error; }
  } });
  const bytes = Buffer.alloc(4096, 7);
  const file = await context.AgentHubComposerFiles.prepare(new Blob([bytes]),
    { name: "harmless.bin", type: "application/octet-stream", size: bytes.length });
  return { root, server, context, uploader, calls, traceFailures, bytes, file,
    fail(action, kind = "lost-body") { fault = { action, kind }; },
    async close() { await server.close(); assert.equal(path.dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); } };
}

for (const action of ["begin", "status", "complete"]) {
  test(`lost ${action} body remains unconfirmed and explicit resume retains the exact attempt`, async () => {
    const f = await fixture();
    try {
      if (action === "status") await f.uploader.upload(f.file);
      f.fail(action);
      const uploadId = f.file.uploadId;
      await assert.rejects(f.uploader.upload(f.file), error => {
        assert.equal(error.attachmentUploadReceiptUnconfirmed, true);
        assert.equal(error.attachmentUploadTerminal, false);
        assert.equal(error.attachmentUploadAction, action);
        assert.equal(error.attachmentUploadStatus, 200);
        assert.doesNotMatch(error.message, /Несовпадение|сумма/u);
        return true;
      });
      const attemptId = f.file.uploadAttemptId, attemptedAt = f.file.uploadAttemptedAt;
      assert.equal(attemptId, uploadId);
      assert.ok(f.traceFailures.some(failure => failure.action === "response-json" && failure.name === "AbortError"));
      const beforeResume = f.calls.length;
      const result = await f.uploader.upload(f.file);
      assert.deepEqual(await readFile(result), f.bytes);
      assert.equal(f.file.uploadId, uploadId);
      assert.equal(f.file.uploadAttemptId, attemptId);
      assert.equal(f.file.uploadAttemptedAt, attemptedAt);
      assert.equal(f.calls.filter(call => call.action === "begin").length, 1);
      const resumed = f.calls.slice(beforeResume);
      assert.equal(resumed[0].action, "status");
      assert.ok(resumed.every(call => call.id === attemptId));
      if (action !== "begin") assert.deepEqual(resumed.map(call => call.action), ["status"]);
    } finally { await f.close(); }
  });
}

test("malformed successful begin body is unconfirmed without another mutation", async () => {
  const f = await fixture();
  try {
    f.fail("begin", "malformed");
    await assert.rejects(f.uploader.upload(f.file), error => error.attachmentUploadReceiptUnconfirmed === true);
    assert.deepEqual(f.calls.map(call => call.action), ["capabilities", "begin"]);
    assert.ok(f.traceFailures.some(failure => failure.action === "response-json" && failure.name === "SyntaxError"));
  } finally { await f.close(); }
});

for (const kind of ["foreign-id", "foreign-protocol"]) {
  test(`decoded ${kind} still refuses strictly without status fallback or new begin`, async () => {
    const f = await fixture();
    try {
      f.fail("begin", kind);
      await assert.rejects(f.uploader.upload(f.file), /Несовпадение загрузки файла/u);
      assert.deepEqual(f.calls.map(call => call.action), ["capabilities", "begin"]);
    } finally { await f.close(); }
  });
}

test("unreadable generic HTTP404 never invents absent state or recovery authority", async () => {
  const f = await fixture();
  try {
    f.fail("begin", "generic-404");
    await assert.rejects(f.uploader.upload(f.file), error => {
      assert.equal(error.attachmentUploadStatus, 404);
      assert.equal(error.attachmentUploadTerminal, true);
      assert.equal(error.attachmentUploadState, undefined);
      return true;
    });
    assert.deepEqual(f.calls.map(call => call.action), ["capabilities", "begin"]);
  } finally { await f.close(); }
});

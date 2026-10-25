import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { publishChunkedAttachmentView } from "../../../../src/interfaces/web/chunked-attachment-view.mjs";
import { attachmentUploadLimits } from "../../../../src/domain/attachment-upload-policy.mjs";

test("native workerd DigestStream and SQLite DO preserve multipart commit across reload", {  }, async (context) => {
  const options = {
    modules: true,
    // The deployed bundle exposes only the actual handler and Durable Object;
    // helper constants exported for Node tests are not workerd entrypoints.
    script: 'export { default, JournalStore } from "./worker.mjs";',
    scriptPath: fileURLToPath(new URL("../../../../cloudflare-worker/src/native-upload-entry.mjs", import.meta.url)),
    compatibilityDate: "2026-07-28",
    durableObjects: { JOURNAL: { className: "JournalStore", useSQLite: true } },
    cf: false,
  };
  const runtime = new Miniflare(options);
  context.after(() => runtime.dispose());
  let namespace = await runtime.getDurableObjectNamespace("JOURNAL");
  let store = namespace.getByName("upload-test");
  const id = randomUUID();
  const bytes = Buffer.alloc(1024 * 1024, 77);
  const hash = (body) => createHash("sha256").update(body).digest("hex");
  const request = (method, query = "", body, headers = {}) => store.fetch(`https://journal.internal/attachment-upload${query}`, {
    method, headers: { "X-Agent-Hub-User-Id": "42", "Content-Type": "application/json", ...headers }, body,
  });
  const begin = JSON.stringify({ uploadId: id, name: "native.bin", type: "application/octet-stream", size: 2 * bytes.length });
  assert.equal((await request("POST", "", begin)).status, 200);
  assert.equal((await request("PUT", `?id=${id}&index=0`, bytes, { "X-Agent-Hub-Chunk-Sha256": hash(bytes) })).status, 200);
  assert.equal((await request("POST", `?id=${id}&complete=1`)).status, 409);
  await runtime.setOptions({ ...options, bindings: { TEST_GENERATION: 2 } });
  namespace = await runtime.getDurableObjectNamespace("JOURNAL");
  store = namespace.getByName("upload-test");
  assert.deepEqual((await (await request("POST", "", begin)).json()).received.map((part) => part.index), [0]);
  assert.equal((await request("PUT", `?id=${id}&index=1`, bytes, { "X-Agent-Hub-Chunk-Sha256": hash(bytes) })).status, 200);
  const finalized = await Promise.all([request("POST", `?id=${id}&complete=1`), request("POST", `?id=${id}&complete=1`)]);
  const first = await finalized[0].json();
  assert.deepEqual(finalized.map((response) => response.status), [200, 200], JSON.stringify(first));
  assert.equal(first.sha256, hash(Buffer.concat([bytes, bytes])));
  assert.equal((await finalized[1].json()).sha256, first.sha256);
  assert.equal((await request("DELETE", `?id=${id}`)).status, 200);
  assert.equal((await request("GET", `?id=${id}`)).status, 410);
});

test("Node large-view publisher crosses signed native Worker upload and public streamed view with exact bytes", {  }, async (context) => {
  const secret = "synthetic-upload-service-test-secret";
  const token = "123456:synthetic-telegram-test-token";
  const runtime = new Miniflare({
    modules: true,
    script: 'export { default, JournalStore } from "./worker.mjs";',
    scriptPath: fileURLToPath(new URL("../../../../cloudflare-worker/src/native-upload-entry.mjs", import.meta.url)),
    compatibilityDate: "2026-07-28",
    durableObjects: { JOURNAL: { className: "JournalStore", useSQLite: true } },
    bindings: { SYNC_SECRET: secret, TELEGRAM_BOT_TOKEN: token, ALLOWED_USER_IDS: "42" },
    cf: false,
  });
  context.after(() => runtime.dispose());
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub172-native-view-"));
  context.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("hub172-native-view-"));
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "large.zip");
  const bytes = Buffer.alloc(21 * 1024 * 1024 + 7, 81);
  const expected = createHash("sha256").update(bytes).digest("hex");
  await writeFile(file, bytes);
  const request = async (payload) => {
    const body = JSON.stringify(payload);
    const timestamp = Math.trunc(Date.now() / 1000);
    const hash = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", secret).update([timestamp, "POST", "/api/control/attachment-upload", hash].join("\n")).digest("hex");
    const response = await runtime.dispatchFetch("https://hub.test/api/control/attachment-upload", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Hub-Timestamp": String(timestamp), "X-Agent-Hub-Signature": signature }, body,
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  };
  const published = await publishChunkedAttachmentView({ file, metadata: { name: "large.zip", type: "application/zip" }, userId: "42", request, limits: attachmentUploadLimits() });
  const initData = new URLSearchParams({ auth_date: String(Math.trunc(Date.now() / 1000)), user: JSON.stringify({ id: 42 }) });
  const authKey = createHmac("sha256", "WebAppData").update(token).digest();
  initData.set("hash", createHmac("sha256", authKey).update([...initData].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n")).digest("hex"));
  const response = await runtime.dispatchFetch(`https://hub.test/api/attachment/view?id=${published.id}`, {
    headers: { Authorization: `tma ${initData}` },
  });
  assert.equal(response.status, 200);
  // workerd derives Content-Length from the stream and may use chunked transfer.
  const length = response.headers.get("Content-Length");
  if (length !== null) assert.equal(Number(length), bytes.length);
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) { size += chunk.byteLength; digest.update(chunk); }
  assert.equal(size, bytes.length);
  assert.equal(digest.digest("hex"), expected);
});

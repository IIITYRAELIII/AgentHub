import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { webcrypto, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { launchBrowser, openFixture } from "./composer-production.fixture.mjs";

const sources = await Promise.all(["composer-files.js", "upload.js"].map((name) =>
  readFile(new URL(`../../assets/web-app/attachments/${name}`, import.meta.url), "utf8")));
const CHUNK = 1024 * 1024;
const protocol = "agent-hub-attachment-upload-v1";
async function fixture(size = 2 * CHUNK + 3) {
  const context = vm.createContext({ Blob, URL, crypto: webcrypto, Uint8Array, console });
  context.window = context;
  sources.forEach((source) => vm.runInContext(source, context));
  const file = await context.AgentHubComposerFiles.prepare(new Blob([new Uint8Array(size)], { type: "application/octet-stream" }),
    { name: "payload.bin", type: "application/octet-stream", size });
  return { context, file };
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

function storageFixture({ mode = "ready", seed = [] } = {}) {
  const records = new Map(seed.map((record, index) => [String(index), record]));
  const timers = new Map();
  const connections = [];
  const opens = [];
  const traces = [];
  let timerId = 0;
  let aborts = 0;
  let digests = 0;
  let clock = Date.now();
  const finishOpen = (request) => {
    const db = {
      closed: false,
      close() { this.closed = true; },
      transaction(_name, access) {
        const transaction = { error: null, aborted: false, abort() {
          this.aborted = true; aborts += 1;
          queueMicrotask(() => this.onabort?.());
        } };
        const complete = () => queueMicrotask(() => {
          if (!transaction.aborted) transaction.oncomplete?.();
        });
        transaction.objectStore = () => ({
          openCursor() {
            const request = {};
            const values = [...records.entries()];
            let index = 0;
            const step = () => queueMicrotask(() => {
              if (transaction.aborted) return;
              const entry = values[index++];
              request.result = entry ? { value: entry[1], continue: step, delete: () => records.delete(entry[0]) } : null;
              request.onsuccess?.();
            });
            if (mode !== "write-hang" && !(mode === "first-write-hang" && connections[0] === db)) step();
            return request;
          },
          put(value) {
            if (mode === "quota") throw new DOMException("Synthetic browser quota", "QuotaExceededError");
            if (mode === "abort-write") {
              transaction.error = new DOMException("Synthetic transaction abort", "AbortError");
              transaction.abort();
              return {};
            }
            records.set(value.blobId, value);
            complete();
            return {};
          },
          get(id) {
            assert.equal(access, "readonly");
            const request = {};
            queueMicrotask(() => {
              const record = records.get(id);
              request.result = mode === "corrupt-read" && record
                ? { ...record, blob: new Blob([new Uint8Array(record.size).fill(255)], { type: record.type }) }
                : record;
              request.onsuccess?.();
              complete();
            });
            return request;
          },
        });
        return transaction;
      },
    };
    connections.push(db);
    request.result = db;
    request.onsuccess?.();
  };
  const context = vm.createContext({ Blob, URL, crypto: {
    randomUUID: () => webcrypto.randomUUID(),
    subtle: { async digest(...args) {
      const result = await webcrypto.subtle.digest(...args); digests += 1;
      if (mode === "slow-verify" && digests === 2) clock += 6_000;
      return result;
    } },
  }, Uint8Array, console, Date: class extends Date { static now() { return clock; } },
    AgentHubCommandTrace: { async measure(_stage, action, operation) {
      const trace = { action, outcome: "started" }; traces.push(trace);
      try { const result = await operation(); trace.outcome = "succeeded"; return result; }
      catch (error) { trace.outcome = "failed"; trace.errorName = error.name; throw error; }
    } },
    setTimeout: (callback) => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
    indexedDB: { open() {
      const request = {};
      opens.push(request);
      if (mode === "blocked") queueMicrotask(() => request.onblocked?.());
      else if (mode !== "open-hang") queueMicrotask(() => finishOpen(request));
      return request;
    } },
  });
  context.window = context;
  vm.runInContext(sources[0], context);
  return {
    api: context.AgentHubComposerFiles, records, connections, opens, timers, traces,
    aborts: () => aborts,
    digests: () => digests,
    finishOpen: () => finishOpen(opens.at(-1)),
    expire: () => { for (const callback of [...timers.values()]) callback(); },
  };
}

async function waitUntil(predicate) {
  for (let index = 0; index < 1000; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("fixture did not reach the requested storage boundary");
}

const prepareSmall = (api) => api.prepare(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  { name: "screen.png", type: "image/png", size: 3 });

test("concurrent Blob preparation shares one verified database handle", async () => {
  const ready = storageFixture({ mode: "open-hang" });
  const pending = Promise.all([prepareSmall(ready.api), prepareSmall(ready.api)]);
  await waitUntil(() => ready.digests() === 2);
  assert.equal(ready.opens.length, 1, "concurrent screenshot preparation shares one database open");
  ready.finishOpen();
  const files = await pending;
  assert.equal(ready.timers.size, 0);
  for (const file of files) {
    assert.equal(ready.api.durable(file), true);
    assert.equal(ready.api.storageFailure(ready.api.serialized(file)), null);
  }
});

test("Blob storage grants durability only after exact committed readback", async () => {
  const corrupted = storageFixture({ mode: "corrupt-read" });
  const file = await prepareSmall(corrupted.api);
  assert.equal(corrupted.api.durable(file), false);
  assert.equal(corrupted.api.storageFailure(corrupted.api.serialized(file)).code, "verification");
  assert.deepEqual([...new Uint8Array(await corrupted.api.resolve(file).blob.arrayBuffer())], [1, 2, 3]);
});

test("Blob storage distinguishes browser quota, archive capacity and transaction failure", async () => {
  for (const [mode, code] of [["quota", "quota"], ["abort-write", "failed"]]) {
    const value = storageFixture({ mode });
    const file = await prepareSmall(value.api);
    assert.equal(value.api.durable(file), false);
    assert.equal(value.api.storageFailure(file).code, code);
    assert.equal(value.timers.size, 0);
  }
  const seeded = Array.from({ length: 128 }, (_, index) => ({ blobId: String(index), size: 1, storedAt: Date.now() }));
  const full = storageFixture({ seed: seeded });
  const file = await prepareSmall(full.api);
  assert.equal(full.api.storageFailure(file).code, "capacity");
  assert.equal(full.records.size, 128, "unproven retained files are not deleted to make room");
  assert.equal(full.api.resolve(file).blob.size, 3, "the new file remains sendable in memory");
});

test("blocked and timed out database opens close late handles without claiming durability", async () => {
  for (const mode of ["blocked", "open-hang"]) {
    const value = storageFixture({ mode });
    const pending = prepareSmall(value.api);
    await waitUntil(() => value.opens.length === 1);
    if (mode === "open-hang") value.expire();
    const file = await pending;
    assert.equal(value.api.durable(file), false);
    assert.equal(value.api.storageFailure(file).code, mode === "blocked" ? "blocked" : "timeout");
    value.finishOpen();
    assert.equal(value.connections[0].closed, true);
    assert.equal(value.timers.size, 0);
  }
});

test("stalled Blob transaction is aborted at its bound and retains the original file", async () => {
  const value = storageFixture({ mode: "write-hang" });
  const pending = prepareSmall(value.api);
  await waitUntil(() => value.connections.length === 1 && value.timers.size === 1);
  value.expire();
  const file = await pending;
  assert.equal(value.aborts(), 1);
  assert.equal(value.api.storageFailure(file).code, "timeout");
  assert.equal(value.api.resolve(file).blob.size, 3);
});

test("version change closes its captured connection and the next paste opens a fresh one", async () => {
  const value = storageFixture();
  await prepareSmall(value.api);
  const first = value.connections[0];
  first.onversionchange();
  await prepareSmall(value.api);
  const second = value.connections[1];
  assert.equal(first.closed, true);
  first.onversionchange();
  assert.equal(second.closed, false, "a stale version event cannot close the new handle");
});

test("timed out connection is retired and the next explicit paste preserves stored files", async () => {
  const seed = { blobId: "existing", storedAt: Date.now(), size: 3 };
  const value = storageFixture({ mode: "first-write-hang", seed: [seed] });
  const pending = prepareSmall(value.api);
  await waitUntil(() => value.connections.length === 1 && value.timers.size === 1);
  value.expire();
  const first = await pending;
  assert.equal(value.api.storageFailure(first).code, "timeout");
  assert.equal(value.connections[0].closed, true);
  assert.equal(value.opens.length, 1, "timing out does not automatically repeat the write");
  assert.equal(value.records.get("0"), seed, "existing stored files are retained");
  const second = await prepareSmall(value.api);
  assert.equal(value.opens.length, 2);
  assert.equal(value.api.durable(second), true);
  assert.equal(value.api.resolve(first).blob.size, 3, "the original unsaved attachment remains sendable");
  assert.equal(value.traces.find((trace) => trace.action === "attachment-storage-write").errorName, "TimeoutError");
  assert.deepEqual(value.traces.filter((trace) => trace.action.startsWith("attachment-storage-")).slice(-4)
    .map(({ action, outcome }) => [action, outcome]), [
    ["attachment-storage-open", "succeeded"], ["attachment-storage-write", "succeeded"],
    ["attachment-storage-read", "succeeded"], ["attachment-storage-verify", "succeeded"],
  ]);
});

test("delayed hash verification does not revoke an exact committed Blob read", async () => {
  const value = storageFixture({ mode: "slow-verify" });
  const file = await prepareSmall(value.api);
  assert.equal(value.api.durable(file), true);
  assert.equal(value.api.storageFailure(file), null);
  assert.equal(value.records.get(file.blobId).blob.size, file.size);
  assert.equal(value.timers.size, 0);
  assert.equal(value.traces.find((trace) => trace.action === "attachment-storage-verify").outcome, "succeeded");
});

test("real browser File remains durable after delayed verification and reload", { timeout: 25_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hub264-storage-file-"));
  const filePath = path.join(directory, "screen.png");
  await writeFile(filePath, Buffer.alloc(4096, 37));
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await openFixture(page);
    await page.evaluate(() => {
      const input = document.createElement("input"); input.type = "file"; input.id = "storage-fixture-file";
      document.body.append(input);
    });
    await page.locator("#storage-fixture-file").setInputFiles(filePath);
    const saved = await page.evaluate(async () => {
      const file = document.querySelector("#storage-fixture-file").files[0];
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      let calls = 0;
      crypto.subtle.digest = async (...args) => {
        const result = await digest(...args);
        if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 5_250));
        return result;
      };
      try {
        const attachment = await AgentHubComposerFiles.prepare(file, { name: file.name, type: file.type, size: file.size });
        return { manifest: AgentHubComposerFiles.serialized(attachment), durable: AgentHubComposerFiles.durable(attachment),
          failure: AgentHubComposerFiles.storageFailure(attachment) };
      } finally { crypto.subtle.digest = digest; }
    });
    assert.equal(saved.durable, true);
    assert.equal(saved.failure, null);
    await page.reload({ waitUntil: "load" });
    const restored = await page.evaluate(async (manifest) => {
      await AgentHubComposerFiles.hydrate([manifest]);
      const record = AgentHubComposerFiles.resolve(manifest);
      return { durable: AgentHubComposerFiles.durable(manifest),
        bytes: record ? [...new Uint8Array(await record.blob.arrayBuffer())] : null };
    }, saved.manifest);
    assert.equal(restored.durable, true);
    assert.deepEqual(restored.bytes, Array(4096).fill(37));
  } finally {
    await browser.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancel stops capability negotiation before any attachment upload", async () => {
  const { context } = await fixture(1);
  const controller = new AbortController();
  const calls = [];
  const uploader = context.AgentHubAttachmentUpload.create({ request: (path, { method, signal }) => {
    calls.push(method);
    assert.equal(path, "/api/attachment-upload");
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } });
  const pending = uploader.validateBatch([{ size: 1 }], { signal: controller.signal });
  controller.abort(new Error("cancel preparation"));
  await assert.rejects(pending, /cancel preparation/);
  assert.deepEqual(calls, ["GET"]);
});

test("chunk uploader resumes a lost acknowledgement under the same upload ID without whole-file encoding", { timeout: 25_000 }, async () => {
  const { context, file } = await fixture(21 * CHUNK + 5);
  assert.equal(context.AgentHubComposerFiles.durable(file), false);
  assert.equal(context.AgentHubComposerFiles.serialized(file).dataUrl, undefined);
  const received = new Map();
  const begins = [];
  const written = [];
  let loseAck = true;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    const url = new URL(path, "http://fixture");
    if (init.method === "GET" && !url.search) return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK, maxTotalBytes: 256 * CHUNK });
    if (init.method === "POST" && !url.search) { begins.push(JSON.parse(init.body)); return response({}); }
    assert.equal(url.searchParams.get("id"), file.uploadId);
    if (init.method === "GET") return response({ protocol, uploadId: file.uploadId, received: [...received.values()] });
    if (init.method === "PUT") {
      const index = Number(url.searchParams.get("index"));
      assert.ok(init.body instanceof Blob);
      assert.ok(init.body.size <= CHUNK);
      const hash = createHash("sha256").update(Buffer.from(await init.body.arrayBuffer())).digest("hex");
      assert.equal(init.headers["X-Agent-Hub-Chunk-Sha256"], hash);
      received.set(index, { index, size: init.body.size, sha256: hash });
      written.push(index);
      if (loseAck) { loseAck = false; throw new Error("lost acknowledgement"); }
      return response({});
    }
    return response({ uploadId: file.uploadId, status: "ready", path: "/attachment/complete", sha256: "a".repeat(64) });
  } });
  await assert.rejects(uploader.upload(file), /lost acknowledgement/u);
  const progress = [];
  assert.equal(await uploader.upload(file, { progress: (bytes) => progress.push(bytes) }), "/attachment/complete");
  assert.equal(begins.length, 1);
  assert.equal(begins[0].uploadId, file.uploadId);
  assert.deepEqual(written, Array.from({ length: 22 }, (_, index) => index));
  assert.equal(progress.at(-1), file.size);
});

test("begin not reaching the server resumes under the original upload ID", async () => {
  const { context, file } = await fixture(3);
  const originalId = file.uploadId;
  let begins = 0;
  let created = false;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    const url = new URL(path, "http://fixture");
    if (init.method === "GET" && !url.search) return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK,
      maxTotalBytes: 256 * CHUNK, expiresInMs: 30 * 60_000, supportsBeginRecovery: true });
    if (init.method === "POST" && !url.search) {
      assert.equal(JSON.parse(init.body).uploadId, originalId);
      begins += 1;
      if (begins === 1) throw new TypeError("begin request never reached server");
      created = true;
      return response({ protocol, uploadId: originalId, status: "uploading", received: [] });
    }
    assert.equal(url.searchParams.get("id"), originalId);
    if (init.method === "GET") return created
      ? response({ protocol, uploadId: originalId, status: "uploading", received: [] })
      : response({ error: "attachment upload not found", state: "absent" }, 404);
    if (init.method === "PUT") return response({});
    return response({ protocol, uploadId: originalId, status: "ready", path: "/attachment/complete", sha256: "a".repeat(64) });
  } });
  await assert.rejects(uploader.upload(file), /never reached server/u);
  assert.equal(await uploader.upload(file), "/attachment/complete");
  assert.equal(file.uploadId, originalId);
  assert.equal(begins, 2);
});

test("a failed update of an earlier durable Blob blocks begin until its attempt is persisted", async () => {
  const { context, file } = await fixture(3);
  const record = context.AgentHubComposerFiles.resolve(file);
  record.durable = true; // An earlier successful Blob write; this fixture has no IndexedDB for the update.
  let begins = 0;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    if (init.method === "POST") begins += 1;
    return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK, maxTotalBytes: 256 * CHUNK,
      expiresInMs: 30 * 60_000, supportsBeginRecovery: true });
  } });
  await assert.rejects(uploader.upload(file), /локальное хранилище недоступно/u);
  await assert.rejects(uploader.upload(file), /локальное хранилище недоступно/u);
  assert.equal(begins, 0, "an old stored Blob must not reload as a fresh attempt after an unpersisted begin");
  assert.equal(context.AgentHubComposerFiles.storageFailure(file)?.code, "unavailable");
});

test("lost begin acknowledgement reads the admitted receipt without a second begin", async () => {
  const { context, file } = await fixture(3);
  let begins = 0;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    const url = new URL(path, "http://fixture");
    if (init.method === "GET" && !url.search) return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK,
      maxTotalBytes: 256 * CHUNK, expiresInMs: 30 * 60_000, supportsBeginRecovery: true });
    if (init.method === "POST" && !url.search) {
      begins += 1;
      if (begins === 1) throw new TypeError("lost begin acknowledgement");
      return response({ protocol, uploadId: file.uploadId, status: "uploading", received: [] });
    }
    if (init.method === "GET") return response({ protocol, uploadId: file.uploadId, status: "uploading", received: [] });
    if (init.method === "PUT") return response({});
    return response({ protocol, uploadId: file.uploadId, status: "ready", path: "/attachment/ready", sha256: "a".repeat(64) });
  } });
  await assert.rejects(uploader.upload(file), /lost begin acknowledgement/u);
  assert.equal(await uploader.upload(file), "/attachment/ready");
  assert.equal(begins, 1);
});

test("lost complete acknowledgement reuses the ready receipt without repeating completion", async () => {
  const { context, file } = await fixture(3);
  let completes = 0;
  let ready = false;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    const url = new URL(path, "http://fixture");
    if (init.method === "GET" && !url.search) return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK,
      maxTotalBytes: 256 * CHUNK });
    if (init.method === "POST" && !url.search) return response({});
    if (init.method === "GET") return response(ready
      ? { protocol, uploadId: file.uploadId, status: "ready", path: "/attachment/ready", sha256: "a".repeat(64), received: [] }
      : { protocol, uploadId: file.uploadId, status: "uploading", received: [] });
    if (init.method === "PUT") return response({});
    completes += 1;
    ready = true;
    throw new TypeError("lost complete acknowledgement");
  } });
  await assert.rejects(uploader.upload(file), /lost complete acknowledgement/u);
  assert.equal(await uploader.upload(file), "/attachment/ready");
  assert.equal(completes, 1);
});

test("generic absence, cancelled and expired receipts never authorize re-begin", async () => {
  for (const [statusCode, state] of [[404, undefined], [410, "cancelled"], [410, "expired"]]) {
    const { context, file } = await fixture(3);
    let begins = 0;
    const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
      const url = new URL(path, "http://fixture");
      if (init.method === "GET" && !url.search) return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK,
        maxTotalBytes: 256 * CHUNK, expiresInMs: 30 * 60_000, supportsBeginRecovery: true });
      if (init.method === "POST" && !url.search) { begins += 1; throw new TypeError("lost begin"); }
      return response({ error: "unavailable", ...(state ? { state } : {}) }, statusCode);
    } });
    await assert.rejects(uploader.upload(file), /lost begin/u);
    await assert.rejects(uploader.upload(file), (error) => error.attachmentUploadTerminal === true);
    assert.equal(begins, 1);
  }
});

test("chunk uploader rejects mismatched stored hashes and exposes expired IDs as terminal", { timeout: 25_000 }, async () => {
  const { context, file } = await fixture(3);
  let expired = false;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    const url = new URL(path, "http://fixture");
    if (!url.search && init.method === "GET") return response({ protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK, maxTotalBytes: 256 * CHUNK });
    if (!url.search) return response({});
    assert.equal(init.method, "GET");
    return expired ? response({ error: "expired" }, 410)
      : response({ protocol, uploadId: file.uploadId, received: [{ index: 0, size: 3, sha256: "b".repeat(64) }] });
  } });
  await assert.rejects(uploader.upload(file), /сумма/u);
  expired = true;
  await assert.rejects(uploader.upload(file), (error) => error.attachmentUploadTerminal === true);
});

test("upload capabilities accept a total quota below the nominal file quota", async () => {
  const { context } = await fixture(3);
  const uploader = context.AgentHubAttachmentUpload.create({ request: async () => response({
    protocol, chunkBytes: CHUNK, maxBytes: 128 * CHUNK, maxTotalBytes: 64 * CHUNK,
  }) });
  assert.equal((await uploader.capabilities()).maxBytes, 64 * CHUNK);
});

test("draft attachment batch checks negotiated aggregate quota before any upload", async () => {
  const { context } = await fixture(3);
  const calls = [];
  const uploader = context.AgentHubAttachmentUpload.create({ request: async (path, init) => {
    calls.push([path, init.method]);
    return response({ protocol, chunkBytes: CHUNK, maxBytes: 8, maxTotalBytes: 10 });
  } });
  await assert.rejects(uploader.validateBatch([{ size: 6 }, { size: 5 }]),
    (error) => error.attachmentUploadTerminal === true);
  await uploader.validateBatch([{ size: 6 }, { size: 4 }]);
  await assert.rejects(uploader.validateBatch([{ size: 9 }]), /лимит/u);
  assert.deepEqual(calls, [["/api/attachment-upload", "GET"]]);
});

test("legacy aggregate quota remains 20 MiB and empty text sends do not negotiate", async () => {
  const { context } = await fixture(3);
  let calls = 0;
  const uploader = context.AgentHubAttachmentUpload.create({ request: async () => {
    calls += 1;
    return response({}, 404);
  } });
  await uploader.validateBatch([]);
  assert.equal(calls, 0);
  await assert.rejects(uploader.validateBatch([{ size: 11 * CHUNK }, { size: 10 * CHUNK }]), /лимит/u);
  assert.equal(calls, 1);
});

test("Blob durability expires and memory pruning preserves staged and explicitly owned files", async () => {
  const { context, file } = await fixture(3);
  file.durable = true;
  assert.equal(context.AgentHubComposerFiles.durable(file), true);
  file.storedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
  assert.equal(context.AgentHubComposerFiles.durable(file), false);
  context.AgentHubComposerFiles.prune([]);
  assert.ok(context.AgentHubComposerFiles.resolve(file));
  context.AgentHubComposerFiles.settle([file]);
  context.AgentHubComposerFiles.prune([file.blobId]);
  assert.ok(context.AgentHubComposerFiles.resolve(file));
  context.AgentHubComposerFiles.prune([]);
  assert.equal(context.AgentHubComposerFiles.resolve(file), null);
});

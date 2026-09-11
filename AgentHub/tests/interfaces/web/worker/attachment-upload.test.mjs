import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Execute the actual public Worker and DO routes. Node supplies the same
// incremental WritableStream hash contract as Cloudflare's native DigestStream.
const source = await readFile(new URL("../../../../cloudflare-worker/src/worker.mjs", import.meta.url), "utf8");
const shim = `import { createHash } from 'node:crypto';
class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
class DigestStream extends WritableStream {
  constructor(algorithm) {
    const hash = createHash(algorithm.toLowerCase().replace('-', ''));
    let done, failed;
    const digest = new Promise((resolve, reject) => { done = resolve; failed = reject; });
    digest.catch(() => {});
    super({ write(bytes) { hash.update(new Uint8Array(bytes)); }, close() { done(hash.digest()); }, abort(error) { failed(error); } });
    this.digest = digest;
  }
}
const crypto = { subtle: globalThis.crypto.subtle, randomUUID: globalThis.crypto.randomUUID.bind(globalThis.crypto), DigestStream };`;
const worker = await import(`data:text/javascript;base64,${Buffer.from(source.replace('import { DurableObject } from "cloudflare:workers";', shim)).toString("base64")}`);
const MiB = 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

class Storage {
  values = new Map();
  alarmAt = null;
  tail = Promise.resolve();
  async get(keys) {
    if (Array.isArray(keys)) return new Map(keys.filter((key) => this.values.has(key)).map((key) => [key, structuredClone(this.values.get(key))]));
    return structuredClone(this.values.get(keys));
  }
  async put(key, value) {
    for (const [entryKey, entryValue] of typeof key === "string" ? [[key, value]] : Object.entries(key)) {
      this.values.set(entryKey, structuredClone(entryValue));
    }
  }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key); }
  async list({ prefix = "", start = "", end = "", limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix) && (!start || key >= start) && (!end || key < end))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
  }
  transaction(callback) {
    const result = this.tail.then(async () => {
      // Metadata snapshot suffices: all binary buffers and records are immutable.
      const before = new Map(this.values);
      const alarm = this.alarmAt;
      try { return await callback(this); }
      catch (error) { this.values = before; this.alarmAt = alarm; throw error; }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async getAlarm() { return this.alarmAt; }
  async setAlarm(value) { this.alarmAt = Number(value); }
  async deleteAlarm() { this.alarmAt = null; }
}

function fixture(limits = {}) {
  const storage = new Storage();
  const env = { TELEGRAM_BOT_TOKEN: "123456:test-token", ALLOWED_USER_IDS: "42,84", SYNC_SECRET: "s".repeat(64), ...limits };
  let store = new worker.JournalStore({ storage }, env);
  env.JOURNAL = { getByName: () => store };
  env.ASSETS = { fetch: async () => new Response("asset") };
  const authorization = (userId = "42") => {
    const params = new URLSearchParams({ auth_date: String(Math.trunc(Date.now() / 1000)), user: JSON.stringify({ id: Number(userId) }) });
    const key = createHmac("sha256", "WebAppData").update(env.TELEGRAM_BOT_TOKEN).digest();
    params.set("hash", createHmac("sha256", key).update([...params].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join("\n")).digest("hex"));
    return `tma ${params}`;
  };
  const request = (method, query = "", body, userId = "42", headers = {}) => worker.default.fetch(new Request(`https://hub.test/api/attachment-upload${query}`, {
    method, headers: { Authorization: authorization(userId), "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "object" && !(body instanceof Uint8Array) ? JSON.stringify(body) : body }),
  }), env);
  const internal = (route, body) => store.fetch(new Request(`https://journal.internal${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return {
    storage, request, env, internal, authorization,
    recreate() { store = new worker.JournalStore({ storage }, env); },
    alarm: () => store.alarm(),
    begin: (id, size, extras = {}) => request("POST", "", { uploadId: id, name: "file.bin", type: "application/octet-stream", size, ...extras }),
    part: (id, index, bytes, sha256 = hash(bytes)) => request("PUT", `?id=${id}&index=${index}`, bytes, "42", { "X-Agent-Hub-Chunk-Sha256": sha256 }),
    complete: (id) => request("POST", `?id=${id}&complete=1`),
    enqueue: (id, commandId = randomUUID()) => internal("/control/enqueue", {
      id: commandId, userId: "42", action: "send-message", params: { text: "file", attachments: [`remote-attachment:${id}`] },
    }),
  };
}

test("resumable Worker upload persists immutable parts across recreation and publishes only complete bytes", { timeout: 20_000 }, async () => {
  const f = fixture();
  const id = randomUUID();
  const a = Buffer.alloc(MiB, 71);
  const b = Buffer.from("last-part");
  assert.equal((await f.begin(id, a.length + b.length)).status, 200);
  assert.equal((await f.part(id, 1, b)).status, 200);
  assert.equal((await f.enqueue(id)).status, 404, "partial storage must not be a command attachment");
  assert.equal((await f.complete(id)).status, 409);
  f.recreate();
  const resumed = await (await f.request("GET", `?id=${id}`)).json();
  assert.deepEqual(resumed.received, [{ index: 1, size: b.length, sha256: hash(b) }]);
  assert.equal(resumed.status, "uploading");
  assert.equal(resumed.path, undefined);
  assert.equal((await f.begin(id, a.length + b.length, { name: "other.bin" })).status, 409);
  assert.equal((await f.part(id, 1, b)).status, 200);
  assert.equal((await f.part(id, 1, Buffer.alloc(b.length, 99))).status, 409);
  assert.equal((await f.part(id, 0, a, "0".repeat(64))).status, 400);
  assert.equal((await f.part(id, 0, a.subarray(1))).status, 400);
  assert.equal((await f.part(id, 0, a)).status, 200);
  const finals = await Promise.all([f.complete(id), f.complete(id)]);
  assert.deepEqual(finals.map((response) => response.status), [200, 200]);
  const ready = await finals[0].json();
  assert.equal(ready.status, "ready");
  assert.equal(ready.path, `remote-attachment:${id}`);
  assert.equal(ready.sha256, hash(Buffer.concat([a, b])));
  const commandId = randomUUID();
  assert.equal((await f.enqueue(id, commandId)).status, 202);
  assert.equal((await f.request("DELETE", `?id=${id}`)).status, 409);
  const manifest = await f.internal("/attachment/pull", { id, userId: "42", commandId, mode: "manifest", page: 0 });
  const raw = await manifest.text();
  assert.ok(Buffer.byteLength(raw) < 25 * 1024);
  const descriptors = JSON.parse(raw);
  assert.equal(descriptors.hash, ready.sha256);
  const chunk = await f.internal("/attachment/pull", { id, userId: "42", commandId, mode: "chunk", index: 0 });
  assert.equal((await chunk.arrayBuffer()).byteLength, 16 * 1024);
  f.recreate();
  assert.equal((await (await f.complete(id)).json()).sha256, ready.sha256);
  await f.internal("/control/pull", { limit: 1 });
  assert.equal((await f.internal("/control/result", { id: commandId, userId: "42", ok: false, error: "explicit rejection" })).status, 200);
  const retained = await (await f.begin(id, a.length + b.length)).json();
  assert.equal(retained.status, "ready");
  assert.equal(retained.path, ready.path);
  assert.equal(retained.expiresAt, ready.expiresAt, "terminal handling cannot extend the original upload TTL");
  const cancelled = await f.request("DELETE", `?id=${id}`);
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, "cancelled");
});

test("Worker upload authentication, cancellation, expiry and reservations share exact owner fences", { timeout: 20_000 }, async () => {
  const f = fixture({ AGENT_HUB_ATTACHMENT_MAX_BYTES: 2 * MiB, AGENT_HUB_ATTACHMENT_USER_MAX_BYTES: 3 * MiB });
  const id = randomUUID();
  assert.equal((await worker.default.fetch(new Request("https://hub.test/api/attachment-upload"), f.env)).status, 401);
  assert.equal((await f.request("GET")).status, 200);
  assert.equal((await f.begin(id, 2 * MiB + 1)).status, 413);
  assert.equal((await f.begin(id, 2 * MiB)).status, 200);
  assert.equal((await f.begin(randomUUID(), 2 * MiB)).status, 429);
  assert.equal((await f.request("GET", `?id=${id}`, undefined, "84")).status, 404);
  assert.equal((await f.request("DELETE", `?id=${id}`, undefined, "84")).status, 404);
  assert.equal((await f.part(id, 0, Buffer.alloc(MiB))).status, 200);
  assert.equal((await f.request("DELETE", `?id=${id}`)).status, 200);
  assert.equal((await f.begin(id, 2 * MiB)).status, 410);
  assert.equal([...f.storage.values.keys()].some((key) => key.startsWith(`control:attachment-chunk:${id}:`)), false);
  const expiredId = randomUUID();
  assert.equal((await f.begin(expiredId, 2 * MiB)).status, 200);
  assert.equal((await f.part(expiredId, 0, Buffer.alloc(MiB))).status, 200);
  const recordKey = `control:attachment-upload:${expiredId}`;
  const record = await f.storage.get(recordKey);
  await f.storage.put(recordKey, { ...record, expiresAt: Date.now() - 1 });
  f.recreate();
  await f.alarm();
  assert.equal(await f.storage.get(recordKey), undefined);
  assert.equal(await f.storage.get(`control:attachment-chunk:${expiredId}:0`), undefined);
  assert.equal((await f.begin(randomUUID(), 2 * MiB)).status, 200);
});

test("large ready uploads use bounded download transport and cannot resurrect after command cleanup", { timeout: 20_000 }, async () => {
  const f = fixture();
  const id = randomUUID();
  const bytes = Buffer.alloc(MiB, 29);
  const expected = createHash("sha256");
  assert.equal((await f.begin(id, 21 * MiB)).status, 200);
  for (let index = 0; index < 21; index += 1) {
    assert.equal((await f.part(id, index, bytes)).status, 200);
    expected.update(bytes);
  }
  assert.equal((await (await f.complete(id)).json()).sha256, expected.digest("hex"));
  const commandId = randomUUID();
  const race = await Promise.all([f.enqueue(id, commandId), f.request("DELETE", `?id=${id}`)]);
  assert.deepEqual(race.map((response) => response.status), [202, 409]);
  const pull = (extra) => f.internal("/attachment/pull", { id, userId: "42", commandId, ...extra });
  assert.equal((await pull({})).status, 413);
  const response = await pull({ mode: "manifest", page: 10 });
  assert.equal(response.status, 200);
  assert.ok((await response.arrayBuffer()).byteLength < 25 * 1024);
  // Simulate the existing command terminal cleanup owner, not a client cancellation.
  await f.storage.delete(`control:attachment-manifest:${id}`);
  assert.equal((await f.complete(id)).status, 410);
  assert.equal((await f.begin(id, 21 * MiB)).status, 410);
});

test("Worker upload finalize detects durable corruption and leaves no ready manifest", { timeout: 20_000 }, async () => {
  const f = fixture();
  const id = randomUUID();
  await f.begin(id, 4);
  await f.part(id, 0, Buffer.from("good"));
  await f.storage.put(`control:attachment-chunk:${id}:0`, new Uint8Array([1, 2, 3, 4]));
  assert.equal((await f.complete(id)).status, 409);
  assert.equal(await f.storage.get(`control:attachment-manifest:${id}`), undefined);
  assert.equal((await f.enqueue(id)).status, 404);
});

test("signed service upload streams verified view parts without exposing its owner to public upload operations", { timeout: 20_000 }, async () => {
  const f = fixture();
  const id = randomUUID();
  const bytes = Buffer.alloc(MiB, 87);
  const service = (payload, secret = f.env.SYNC_SECRET) => {
    const body = JSON.stringify({ userId: "42", uploadId: id, ...payload });
    const timestamp = Math.trunc(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update([timestamp, "POST", "/api/control/attachment-upload", hash(body)].join("\n")).digest("hex");
    return worker.default.fetch(new Request("https://hub.test/api/control/attachment-upload", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Hub-Timestamp": String(timestamp), "X-Agent-Hub-Signature": signature }, body,
    }), f.env);
  };
  assert.equal((await service({ action: "begin", size: 2 * MiB }, "wrong-secret")).status, 401);
  const begin = { action: "begin", name: "large.bin", type: "application/octet-stream", size: 2 * MiB };
  assert.equal((await service(begin)).status, 200);
  assert.equal((await f.request("GET", `?id=${id}`)).status, 404);
  assert.equal((await f.request("DELETE", `?id=${id}`)).status, 404);
  assert.equal((await service({ action: "chunk", index: 0, sha256: hash(bytes), dataBase64: bytes.toString("base64") })).status, 200);
  f.recreate();
  assert.deepEqual((await (await service(begin)).json()).received.map((part) => part.index), [0]);
  assert.equal((await service({ action: "chunk", index: 1, sha256: hash(bytes), dataBase64: bytes.toString("base64") })).status, 200);
  const ready = await (await service({ action: "complete" })).json();
  assert.equal(ready.sha256, hash(Buffer.concat([bytes, bytes])));
  assert.equal((await f.enqueue(id)).status, 404, "service views cannot become user command input");
  const view = (userId) => worker.default.fetch(new Request(`https://hub.test/api/attachment/view?id=${id}`, { headers: { Authorization: f.authorization(userId) } }), f.env);
  assert.equal((await view("84")).status, 404);
  const response = await view("42");
  assert.equal(response.status, 200);
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of response.body) { assert.ok(chunk.length <= MiB); size += chunk.length; digest.update(chunk); }
  assert.equal(size, 2 * MiB);
  assert.equal(digest.digest("hex"), ready.sha256);
  await f.storage.put(`control:attachment-chunk:${id}:1`, new Uint8Array(MiB));
  const damaged = await view("42");
  await assert.rejects(damaged.arrayBuffer(), /missing or damaged/u);
});

test("legacy upload cannot overwrite staged bytes or bypass pending upload reservations", { timeout: 20_000 }, async () => {
  const f = fixture({ AGENT_HUB_ATTACHMENT_USER_MAX_BYTES: MiB });
  const id = randomUUID();
  await f.begin(id, MiB);
  const legacy = (attachmentId) => worker.default.fetch(new Request("https://hub.test/api/attachment", {
    method: "POST", headers: { Authorization: f.authorization(), "Content-Type": "application/octet-stream", "X-Agent-Hub-Attachment-Id": attachmentId }, body: Buffer.from("legacy"),
  }), f.env);
  assert.equal((await legacy(id)).status, 409);
  assert.equal((await legacy(randomUUID())).status, 429);
  assert.equal(await f.storage.get(`control:attachment-chunk:${id}:0`), undefined);
});

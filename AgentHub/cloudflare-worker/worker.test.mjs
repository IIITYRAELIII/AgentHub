import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

async function loadWorker() {
  const source = (await readFile(path.join(here, "src", "worker.mjs"), "utf8"))
    .replace(
      'import { DurableObject } from "cloudflare:workers";',
      "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`);
}

class MemoryStorage {
  values = new Map();
  alarmAt = null;

  async get(key) {
    if (Array.isArray(key)) {
      return new Map(key.filter((item) => this.values.has(item)).map((item) => [item, this.values.get(item)]));
    }
    return this.values.get(key);
  }

  async put(key, value) {
    if (typeof key === "object" && key !== null) {
      for (const [itemKey, itemValue] of Object.entries(key)) this.values.set(itemKey, itemValue);
      return;
    }
    this.values.set(key, value);
  }

  async delete(key) {
    for (const item of Array.isArray(key) ? key : [key]) this.values.delete(item);
  }

  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort(([left], [right]) => (
      left.localeCompare(right)
    )));
  }

  async transaction(callback) {
    return callback(this);
  }

  async getAlarm() {
    return this.alarmAt;
  }

  async setAlarm(timestamp) {
    this.alarmAt = Number(timestamp);
  }

  async deleteAlarm() {
    this.alarmAt = null;
  }
}

function telegramInitData(botToken, userId, authDate = Math.trunc(Date.now() / 1_000)) {
  const values = new URLSearchParams({
    auth_date: String(authDate),
    query_id: `query-${userId}`,
    user: JSON.stringify({ id: Number(userId), first_name: "Tester" }),
  });
  const dataCheckString = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  values.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return values.toString();
}

function signedServiceRequest(url, payload, secret) {
  const body = JSON.stringify(payload);
  const timestamp = Math.trunc(Date.now() / 1_000);
  const pathname = new URL(url).pathname;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret)
    .update([timestamp, "POST", pathname, bodyHash].join("\n"))
    .digest("hex");
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-Hub-Timestamp": String(timestamp),
      "X-Agent-Hub-Signature": signature,
    },
    body,
  });
}

function syncChunkRequest({
  syncId,
  index,
  count,
  version = "version-1",
  updatedAt = "2026-07-30T08:00:00.000Z",
  body = new Uint8Array([index + 1]),
}) {
  return new Request("https://journal.internal/sync-chunk", {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Agent-Hub-Sync-Id": syncId,
      "X-Agent-Hub-Chunk-Index": String(index),
      "X-Agent-Hub-Chunk-Count": String(count),
      "X-Agent-Hub-Encoding": "gzip",
      "X-Agent-Hub-Journal-Version": version,
      "X-Agent-Hub-Journal-Updated-At": updatedAt,
    },
    body,
  });
}

test("Worker relay authenticates, isolates, executes once, and returns results", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const botToken = "123456:test-token";
  const syncSecret = "s".repeat(64);
  const env = {
    TELEGRAM_BOT_TOKEN: botToken,
    ALLOWED_USER_IDS: "42,84",
    SYNC_SECRET: syncSecret,
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce10";
  const authorization = `tma ${telegramInitData(botToken, 42)}`;
  const command = {
    commandId: id,
    action: "open-turn",
    params: { provider: "codex", taskThreadId: "task", turnId: "turn" },
  };

  let response = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  }), env);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, pending: true, id });

  response = await workerModule.default.fetch(new Request("https://hub.test/api/control/enqueue", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  }), env);
  assert.equal(response.status, 200);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10 }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);
  const pulled = await response.json();
  assert.equal(pulled.commands.length, 1);
  assert.equal(pulled.commands[0].id, id);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10 }, syncSecret),
    env,
  );
  assert.deepEqual((await response.json()).commands, []);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/control/result?id=${id}`,
    { headers: { Authorization: authorization } },
  ), env);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, pending: true, id, status: "running" });

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/result", {
      id,
      userId: "42",
      ok: true,
      result: { opened: true },
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/control/result?id=${id}`,
    { headers: { Authorization: authorization } },
  ), env);
  assert.deepEqual(await response.json(), {
    ok: true,
    pending: false,
    id,
    result: { opened: true },
  });

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/control/result?id=${id}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 84)}` } },
  ), env);
  assert.equal(response.status, 404);

  const record = await storage.get(`control:command:${id}`);
  record.expiresAt = Date.now() - 1;
  await storage.put(`control:command:${id}`, record);
  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/control/result?id=${id}`,
    { headers: { Authorization: authorization } },
  ), env);
  assert.equal(response.status, 404);
  assert.equal(await storage.get(`control:command:${id}`), undefined);
});

test("Worker relay retries an abandoned running command with the same id", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce51";
  const command = {
    id,
    userId: "42",
    action: "status-details",
    params: {},
  };

  let response = await store.fetch(new Request("https://journal.internal/control/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  }));
  assert.equal(response.status, 202);

  const pull = () => store.fetch(new Request("https://journal.internal/control/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10 }),
  }));
  response = await pull();
  assert.equal((await response.json()).commands[0].id, id);
  assert.equal((await storage.get(`control:command:${id}`)).deliveryAttempt, 1);

  response = await pull();
  assert.deepEqual((await response.json()).commands, []);

  const abandoned = await storage.get(`control:command:${id}`);
  abandoned.leaseExpiresAt = Date.now() - 1;
  await storage.put(`control:command:${id}`, abandoned);
  response = await pull();
  assert.equal((await response.json()).commands[0].id, id);
  assert.equal((await storage.get(`control:command:${id}`)).deliveryAttempt, 2);
});

test("Worker alarm removes expired staging chunks without touching the published journal", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const before = Date.now();

  let response = await store.fetch(syncChunkRequest({
    syncId: "orphan-sync",
    index: 0,
    count: 2,
  }));
  assert.equal(response.status, 202);
  const staged = await storage.get("staging:orphan-sync");
  assert.ok(staged.createdAt >= before);
  assert.ok(staged.expiresAt > staged.createdAt);
  assert.equal(storage.alarmAt, staged.expiresAt);

  await storage.put({
    "journal-manifest": {
      syncId: "published-sync",
      count: 1,
      encoding: "gzip",
      version: "published",
      updatedAt: "2026-07-30T07:00:00.000Z",
    },
    "chunk:published-sync:0": new Uint8Array([9]),
    "staging:published-sync": {
      syncId: "published-sync",
      count: 1,
      createdAt: before - 60_000,
      expiresAt: before - 1,
    },
    "staging:fresh-sync": {
      syncId: "fresh-sync",
      count: 2,
      createdAt: before,
      expiresAt: before + 120_000,
    },
    "chunk:fresh-sync:0": new Uint8Array([7]),
  });
  staged.expiresAt = before - 1;
  await storage.put("staging:orphan-sync", staged);

  await store.alarm();

  assert.equal(await storage.get("staging:orphan-sync"), undefined);
  assert.equal(await storage.get("chunk:orphan-sync:0"), undefined);
  assert.equal(await storage.get("staging:published-sync"), undefined);
  assert.deepEqual(await storage.get("chunk:published-sync:0"), new Uint8Array([9]));
  assert.equal((await storage.get("journal-manifest")).syncId, "published-sync");
  assert.ok(await storage.get("staging:fresh-sync"));
  assert.deepEqual(await storage.get("chunk:fresh-sync:0"), new Uint8Array([7]));
  assert.equal(storage.alarmAt, before + 120_000);
});

test("Worker relay rejects unsupported actions, attachments, and unsigned service calls", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const botToken = "123456:test-token";
  const env = {
    TELEGRAM_BOT_TOKEN: botToken,
    ALLOWED_USER_IDS: "42",
    SYNC_SECRET: "s".repeat(64),
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const authorization = `tma ${telegramInitData(botToken, 42)}`;
  const enqueue = (payload) => workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }), env);

  let response = await enqueue({
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce12",
    action: "shell",
    params: {},
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /not allowed/iu);

  response = await enqueue({
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce13",
    action: "send-message",
    params: { text: "hello", attachments: ["data:image/png;base64,..."] },
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /invalid remote attachments/iu);

  response = await workerModule.default.fetch(new Request("https://hub.test/api/control/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10 }),
  }), env);
  assert.equal(response.status, 401);
});

test("Worker relay stores user-bound image uploads and serves them only to their command", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const botToken = "123456:test-token";
  const syncSecret = "s".repeat(64);
  const env = {
    TELEGRAM_BOT_TOKEN: botToken,
    ALLOWED_USER_IDS: "42,84",
    SYNC_SECRET: syncSecret,
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const authorization = `tma ${telegramInitData(botToken, 42)}`;
  const upload = () => workerModule.default.fetch(new Request("https://hub.test/api/attachment", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "image/png" },
    body: png,
  }), env);

  let response = await upload();
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.match(uploaded.path, /^remote-attachment:[0-9a-f-]{36}$/u);

  response = await upload();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).path, uploaded.path);

  response = await workerModule.default.fetch(new Request("https://hub.test/api/attachment", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "image/png",
      "X-Agent-Hub-Attachment-Id": uploaded.id,
    },
    body: Buffer.concat([png, Buffer.from([0])]),
  }), env);
  assert.equal(response.status, 409);

  response = await workerModule.default.fetch(new Request("https://hub.test/api/attachment", {
    method: "POST",
    headers: {
      Authorization: `tma ${telegramInitData(botToken, 84)}`,
      "Content-Type": "image/png",
    },
    body: png,
  }), env);
  assert.equal(response.status, 201);
  assert.notEqual((await response.json()).path, uploaded.path);

  response = await workerModule.default.fetch(new Request("https://hub.test/api/attachment", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "image/png",
      "Content-Length": String(20 * 1024 * 1024 + 1),
    },
    body: png,
  }), env);
  assert.equal(response.status, 413);

  const commandId = "018f6c86-3f34-7a31-8f27-16f5b96cce30";
  response = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: commandId,
      action: "send-message",
      params: { text: "Посмотри", attachments: [uploaded.path] },
    }),
  }), env);
  assert.equal(response.status, 202);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10 }, syncSecret),
    env,
  );
  const command = (await response.json()).commands[0];
  assert.deepEqual(command.params.attachments, [uploaded.path]);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/attachment/pull", {
      id: uploaded.id,
      userId: "42",
      commandId,
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/attachment/pull", {
      id: uploaded.id,
      userId: "84",
      commandId,
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 404);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/result", {
      id: commandId,
      userId: "42",
      ok: true,
      result: { accepted: true },
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/attachment/pull", {
      id: uploaded.id,
      userId: "42",
      commandId,
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 404);

  // A completed attempt removes its attachment. Re-uploading the same image
  // recreates the deterministic reference for a new command.
  response = await upload();
  assert.equal(response.status, 201);
  const retriedUpload = await response.json();
  assert.equal(retriedUpload.path, uploaded.path);

  const retryCommandId = "018f6c86-3f34-7a31-8f27-16f5b96cce31";
  response = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: retryCommandId,
      action: "send-message",
      params: { text: "Повтор", attachments: [retriedUpload.path] },
    }),
  }), env);
  assert.equal(response.status, 202);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10 }, syncSecret),
    env,
  );
  const retriedCommand = (await response.json()).commands[0];
  assert.equal(retriedCommand.id, retryCommandId);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/attachment/pull", {
      id: retriedUpload.id,
      userId: "42",
      commandId: retryCommandId,
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
});

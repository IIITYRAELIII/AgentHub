import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function loadWorker() {
  const source = (await readFile(path.join(ROOT, "cloudflare-worker", "src", "worker.mjs"), "utf8"))
    .replace(
      'import { DurableObject } from "cloudflare:workers";',
      "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
    );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Date.now()}-${Math.random()}`);
}

function unboundedBodyRequest({ chunkSize = 1_024, chunkCount = 10 } = {}) {
  let produced = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (produced >= chunkCount) {
        controller.close();
        return;
      }
      produced += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    request: { headers: new Headers(), body },
    state: () => ({ produced, cancelled }),
  };
}

test("bounded readers cancel an oversized streamed body without Content-Length", async () => {
  const worker = await loadWorker();
  const { request, state } = unboundedBodyRequest();

  await assert.rejects(worker.readBoundedBinary(request, 2 * 1_024, "test payload"), /test payload is too large/);

  assert.deepEqual(state(), { produced: 3, cancelled: true });
});

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

  async list({ prefix = "", start = "", startAfter = "", end = "", limit = Number.POSITIVE_INFINITY } = {}) {
    return new Map([...this.values]
      .filter(([key]) => (
        key.startsWith(prefix)
        && (!start || key >= start)
        && (!startAfter || key > startAfter)
        && (!end || key < end)
      ))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, limit));
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

function signedServiceRequest(url, payload, secret, headers = {}) {
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
      ...headers,
      "Content-Type": "application/json",
      "X-Agent-Hub-Timestamp": String(timestamp),
      "X-Agent-Hub-Signature": signature,
    },
    body,
  });
}

function durableNamespace(workerModule) {
  const stores = new Map();
  return {
    stores,
    namespace: {
      getByName(name) {
        if (!stores.has(name)) {
          stores.set(name, new workerModule.JournalStore({ storage: new MemoryStorage() }, {}));
        }
        return stores.get(name);
      },
    },
  };
}

function signedBinaryServiceRequest(url, body, secret, headers = {}) {
  const timestamp = Math.trunc(Date.now() / 1_000);
  const pathname = new URL(url).pathname;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", secret)
    .update([timestamp, "POST", pathname, bodyHash].join("\n"))
    .digest("hex");
  return new Request(url, {
    method: "POST",
    headers: {
      ...headers,
      "X-Agent-Hub-Timestamp": String(timestamp),
      "X-Agent-Hub-Signature": signature,
    },
    body,
  });
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
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

test("Worker serves the latest pushed snapshot without creating a control command", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const botToken = "123456:test-token";
  const syncSecret = "p".repeat(64);
  const env = {
    TELEGRAM_BOT_TOKEN: botToken,
    ALLOWED_USER_IDS: "42",
    SYNC_SECRET: syncSecret,
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const snapshot = { apiVersion: 3, tasks: [], version: "snapshot-v1" };

  let response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/snapshot/push", { userId: "42", snapshot }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);

  response = await workerModule.default.fetch(new Request("https://hub.test/api/snapshot", {
    headers: { Authorization: `tma ${telegramInitData(botToken, 42)}` },
  }), env);
  assert.deepEqual(await response.json(), snapshot);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/snapshot?knownVersion=snapshot-v1&waitMs=0",
    { headers: { Authorization: `tma ${telegramInitData(botToken, 42)}` } },
  ), env);
  assert.deepEqual(await response.json(), { notModified: true, version: "snapshot-v1" });
  assert.equal([...storage.values.keys()].some((key) => key.startsWith("control:command:")), false);
});

test("completed control receipts do not consume live queue capacity", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const now = Date.now();
  await storage.put(Object.fromEntries(Array.from({ length: 500 }, (_, index) => [
    `control:command:completed-${index}`,
    {
      id: `completed-${index}`,
      userId: "42",
      status: "completed",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + 60_000,
    },
  ])));

  const response = await store.fetch(new Request("https://journal.internal/control/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "018f6c86-3f34-7a31-8f27-16f5b96cce13",
      userId: "42",
      action: "rename-task",
      params: { provider: "codex", threadId: "thread", title: "Новое название" },
    }),
  }));

  assert.equal(response.status, 202);
});

test("Worker long poll wakes as soon as any client enqueues a command", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const botToken = "123456:test-token";
  const syncSecret = "l".repeat(64);
  const env = {
    TELEGRAM_BOT_TOKEN: botToken,
    ALLOWED_USER_IDS: "42",
    SYNC_SECRET: syncSecret,
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce71";
  const startedAt = Date.now();
  const pendingPull = workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10, waitMs: 1_000 }, syncSecret),
    env,
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  const enqueue = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: {
      Authorization: `tma ${telegramInitData(botToken, 42)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      commandId: id,
      action: "snapshot",
      params: {},
    }),
  }), env);
  assert.equal(enqueue.status, 202);

  const response = await pendingPull;
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.longPoll, true);
  assert.equal(payload.commands[0].id, id);
  assert.ok(Date.now() - startedAt < 500);

  const invalid = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10, waitMs: 25_001 }, syncSecret),
    env,
  );
  assert.equal(invalid.status, 400);
});

test("Worker result long poll wakes as soon as Hub completes a command", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const botToken = "123456:test-token";
  const syncSecret = "r".repeat(64);
  const env = {
    TELEGRAM_BOT_TOKEN: botToken,
    ALLOWED_USER_IDS: "42",
    SYNC_SECRET: syncSecret,
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce72";
  const authorization = `tma ${telegramInitData(botToken, 42)}`;
  await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ commandId: id, action: "snapshot", params: {} }),
  }), env);
  await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10 }, syncSecret),
    env,
  );

  const startedAt = Date.now();
  const pendingResult = workerModule.default.fetch(new Request(
    `https://hub.test/api/control/result?id=${id}&waitMs=1000`,
    { headers: { Authorization: authorization } },
  ), env);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const delivered = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/result", {
      id,
      userId: "42",
      ok: true,
      result: { ready: true },
    }, syncSecret),
    env,
  );
  assert.equal(delivered.status, 200);

  const response = await pendingResult;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    pending: false,
    id,
    result: { ready: true },
  });
  assert.ok(Date.now() - startedAt < 500);

  const invalid = await workerModule.default.fetch(new Request(
    `https://hub.test/api/control/result?id=${id}&waitMs=25001`,
    { headers: { Authorization: authorization } },
  ), env);
  assert.equal(invalid.status, 400);
});

test("Worker prevents stale Mini App shells and caches versioned assets", async () => {
  const workerModule = await loadWorker();
  const env = {
    JOURNAL: { getByName: () => ({}) },
    ASSETS: {
      fetch: async (request) => new Response("asset", {
        headers: {
          "Content-Type": new URL(request.url).pathname === "/"
            ? "text/html; charset=utf-8"
            : "text/javascript; charset=utf-8",
        },
      }),
    },
  };

  let response = await workerModule.default.fetch(new Request("https://hub.test/"), env);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  response = await workerModule.default.fetch(
    new Request("https://hub.test/app.js?v=123456789abc"),
    env,
  );
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");

  response = await workerModule.default.fetch(
    new Request("https://hub.test/app.123456789abc.js"),
    env,
  );
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=31536000, immutable");

  response = await workerModule.default.fetch(new Request("https://hub.test/app.js"), env);
  assert.equal(response.headers.get("Cache-Control"), "no-cache");
});

test("Android device pairing creates a revocable signed session", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const syncSecret = "d".repeat(64);
  const env = {
    TELEGRAM_BOT_TOKEN: "123456:test-token",
    ALLOWED_USER_IDS: "42",
    SYNC_SECRET: syncSecret,
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };

  let response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/device/pairing", { userId: "42" }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);
  const pairing = await response.json();
  assert.match(pairing.code, /^[A-Z2-7]{5}(?:-[A-Z2-7]{5}){3}$/u);

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  response = await workerModule.default.fetch(new Request("https://hub.test/api/device/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: pairing.code,
      name: "Pixel test",
      platform: "Android test",
      publicKey: base64Url(publicKey.export({ type: "spki", format: "der" })),
    }),
  }), env);
  assert.equal(response.status, 201);
  const paired = await response.json();
  assert.equal(paired.device.name, "Pixel test");

  response = await workerModule.default.fetch(new Request("https://hub.test/api/device/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: paired.device.id }),
  }), env);
  assert.equal(response.status, 200);
  const challenge = await response.json();
  const message = [
    "agent-hub-device-session-v1",
    paired.device.id,
    challenge.challengeId,
    challenge.challenge,
  ].join("\n");
  const signature = sign("sha256", Buffer.from(message), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  response = await workerModule.default.fetch(new Request("https://hub.test/api/device/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: paired.device.id,
      challengeId: challenge.challengeId,
      signature: base64Url(signature),
    }),
  }), env);
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/u);

  const commandId = "018f6c86-3f34-7a31-8f27-16f5b96cce11";
  response = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: {
      Authorization: `device ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commandId, action: "snapshot", params: {} }),
  }), env);
  assert.equal(response.status, 202);
  assert.equal((await storage.get(`control:command:${commandId}`)).userId, "42");

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/device/list", { userId: "42" }, syncSecret),
    env,
  );
  assert.deepEqual((await response.json()).devices.map(({ id, name }) => ({ id, name })), [{
    id: paired.device.id,
    name: "Pixel test",
  }]);

  const importedId = "018f6c86-3f34-7a31-8f27-16f5b96cce19";
  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/device/import", {
      userId: "42",
      devices: [{
        id: importedId,
        userId: "42",
        name: "Direct browser",
        platform: "Chromium",
        publicKey: base64Url(publicKey.export({ type: "spki", format: "der" })),
        createdAt: Date.now() - 1_000,
        lastSeenAt: null,
        revokedAt: null,
      }],
    }, syncSecret),
    env,
  );
  assert.deepEqual(await response.json(), { imported: 1, existing: 0 });

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/device/revoke", {
      userId: "42",
      deviceId: paired.device.id,
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);
  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/device/delete", {
      userId: "42",
      deviceIds: [paired.device.id],
    }, syncSecret),
    env,
  );
  assert.deepEqual(await response.json(), { deleted: 1 });
  response = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: {
      Authorization: `device ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      commandId: "018f6c86-3f34-7a31-8f27-16f5b96cce12",
      action: "snapshot",
      params: {},
    }),
  }), env);
  assert.equal(response.status, 401);
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
  await storage.delete(abandoned.availabilityKey);
  abandoned.leaseExpiresAt = Date.now() - 1;
  abandoned.availabilityKey = `control:available:${String(abandoned.leaseExpiresAt).padStart(16, "0")}:${id}`;
  await storage.put({
    [`control:command:${id}`]: abandoned,
    [abandoned.availabilityKey]: { id },
  });
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

  assert.deepEqual(workerModule.validateControlCommand({
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce10",
    action: "submit-bug-report",
    params: {
      text: "Проверка",
      attachments: ["remote-attachment:018f6c86-3f34-7a31-8f27-16f5b96cce11"],
    },
  }), {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce10",
    action: "submit-bug-report",
    params: {
      text: "Проверка",
      attachments: ["remote-attachment:018f6c86-3f34-7a31-8f27-16f5b96cce11"],
    },
  });

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

test("shared Dashboard bot pairs one Telegram user and queues Tasks only for that Hub", async (context) => {
  const workerModule = await loadWorker();
  const { namespace, stores } = durableNamespace(workerModule);
  const webhookSecret = "w".repeat(64);
  const hubId = "018f6c86-3f34-7a31-8f27-16f5b96cce50";
  const otherHubId = "018f6c86-3f34-7a31-8f27-16f5b96cce51";
  const hubSecret = "h".repeat(64);
  const otherSecret = "o".repeat(64);
  const telegramCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.includes("/file/bot")) {
      return new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { "Content-Type": "image/jpeg" },
      });
    }
    const body = JSON.parse(options.body);
    telegramCalls.push({ url: target, body });
    if (target.endsWith("/getFile")) {
      return Response.json({ ok: true, result: { file_path: "documents/reply.jpg", file_size: 4 } });
    }
    return Response.json({ ok: true, result: { message_id: 700 } });
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = {
    DASHBOARD_BOT_TOKEN: `123456:${"A".repeat(30)}`,
    DASHBOARD_BOT_WEBHOOK_SECRET: webhookSecret,
    JOURNAL: namespace,
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const register = async (id, name, secret) => workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubId: id, name, secret }),
    },
  ), env);
  const webhook = async (update) => workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/webhook",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
      },
      body: JSON.stringify(update),
    },
  ), env);

  let response = await register(hubId, "Hub Алисы", hubSecret);
  assert.equal(response.status, 200);
  const pairing = await response.json();
  assert.match(pairing.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/u);
  response = await register(otherHubId, "Hub Боба", otherSecret);
  assert.equal(response.status, 200);

  response = await webhook({
    update_id: 100,
    message: {
      message_id: 1,
      date: 1_786_200_000,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      text: `/link ${pairing.code}`,
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.match(telegramCalls.at(-1).body.text, /Hub Алисы/u);

  response = await webhook({
    update_id: 101,
    message: {
      message_id: 2,
      date: 1_786_200_001,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      text: "Исправить фильтр на дашборде",
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(telegramCalls.at(-1).body.text, "Принято в Backlog.");

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  const [command] = (await response.json()).commands;
  assert.equal(command.action, "board-task-ingest");
  assert.equal(command.userId, "42");
  assert.deepEqual(command.params, {
    text: "Исправить фильтр на дашборде",
    sourceKey: "shared-dashboard:101",
    sourceDetails: {
      updateId: 101,
      chatId: 42,
      messageId: 2,
      userId: 42,
    },
  });

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    otherSecret,
    { "X-Agent-Hub-Dashboard-Id": otherHubId },
  ), env);
  assert.equal(response.status, 409);

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: command.id, userId: "42", ok: true, result: { taskId: "task-1" } },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  assert.ok(stores.has(`dashboard-bot:${hubId}`));

  response = await webhook({
    update_id: 102,
    message: {
      message_id: 3,
      date: 1_786_200_002,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      document: {
        file_id: "reply-jpg",
        file_name: "photo_2026-08-10.jpg",
        mime_type: "application/octet-stream",
        file_size: 4,
      },
      reply_to_message: {
        message_id: 2,
        from: { id: 42, first_name: "Алиса" },
        text: "Исправить фильтр на дашборде",
      },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(telegramCalls.at(-1).body.text, "Скриншот добавлен к задаче.");

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  const [attachmentCommand] = (await response.json()).commands;
  assert.equal(attachmentCommand.action, "board-task-ingest");
  assert.equal(attachmentCommand.params.replyMessageId, 2);
  assert.equal(attachmentCommand.params.text, undefined);
  assert.equal(attachmentCommand.params.sourceKey, undefined);
  assert.equal(attachmentCommand.params.sourceDetails.messageId, 3);
  assert.match(attachmentCommand.params.attachments[0], /^remote-attachment:[0-9a-f-]{36}$/u);

  response = await webhook({
    update_id: 103,
    message: {
      message_id: 4,
      date: 1_786_200_010,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      text: "КЭМЗ",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(telegramCalls.at(-1).body.text, "Принято в Backlog.");
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [precedingCommand] = (await response.json()).commands;
  assert.equal(precedingCommand.params.text, "КЭМЗ");

  response = await webhook({
    update_id: 104,
    message: {
      message_id: 5,
      date: 1_786_200_014,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Иван" },
      text: "Изменился механизм распределения запасов",
    },
  });
  assert.equal(response.status, 200);
  const precedingBundleCard = telegramCalls
    .filter((call) => /\/sendMessage$/u.test(call.url) && /Собираю пачку/u.test(call.body.text))
    .at(-1);
  assert.match(precedingBundleCard.body.text, /Сообщений: 2/u);
  assert.match(precedingBundleCard.body.text, /ваших: 1/u);

  response = await webhook({
    update_id: 105,
    callback_query: {
      id: "callback-preceding-comment",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: 701, chat: { id: 42, type: "private" } },
      data: precedingBundleCard.body.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  assert.equal(response.status, 200);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [mergeCommand] = (await response.json()).commands;
  assert.equal(mergeCommand.params.mergeMessageId, 4);
  assert.match(mergeCommand.params.text, /Сообщение 1 · Вы[\s\S]*КЭМЗ/u);
  assert.match(mergeCommand.params.text, /Сообщение 2 · Переслано · Иван/u);
  assert.equal(mergeCommand.params.sourceDetails.messageCount, 2);

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    "x".repeat(64),
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 401);
});

test("shared Dashboard bot can send forwards separately with their reply clarifications", async (context) => {
  const workerModule = await loadWorker();
  const { namespace } = durableNamespace(workerModule);
  const webhookSecret = "w".repeat(64);
  const hubId = "018f6c86-3f34-7a31-8f27-16f5b96cce52";
  const hubSecret = "h".repeat(64);
  const telegramCalls = [];
  let sentMessageId = 800;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/file/bot")) {
      return new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
        headers: { "Content-Type": "image/jpeg", "Content-Length": "4" },
      });
    }
    const method = String(url).split("/").at(-1);
    const body = JSON.parse(options.body);
    telegramCalls.push({ method, body });
    if (method === "getFile") {
      return Response.json({ ok: true, result: { file_path: "photos/example.jpg", file_size: 4 } });
    }
    return Response.json({
      ok: true,
      result: method === "sendMessage" ? { message_id: sentMessageId++ } : true,
    });
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = {
    DASHBOARD_BOT_TOKEN: `123456:${"B".repeat(30)}`,
    DASHBOARD_BOT_WEBHOOK_SECRET: webhookSecret,
    JOURNAL: namespace,
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const webhook = (update) => workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/webhook",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
      },
      body: JSON.stringify(update),
    },
  ), env);
  let response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hubId, name: "Командный Hub", secret: hubSecret }),
    },
  ), env);
  const pairing = await response.json();
  await webhook({
    update_id: 200,
    message: {
      message_id: 1,
      date: 1_786_200_000,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      text: `/link ${pairing.code}`,
    },
  });
  await webhook({
    update_id: 201,
    message: {
      message_id: 2,
      date: 1_786_200_001,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Заказчик" },
      photo: [{ file_id: "photo-small" }, { file_id: "photo-large", file_size: 4 }],
      caption: "Фильтр сбрасывается после обновления",
    },
  });
  const bundleCard = telegramCalls.find((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text));
  const sendCallback = bundleCard.body.reply_markup.inline_keyboard[0][0].callback_data;
  const separateCallback = bundleCard.body.reply_markup.inline_keyboard[1][0].callback_data;
  assert.match(sendCallback, /^forward-bundle:send:[0-9a-f-]{36}$/u);
  assert.match(separateCallback, /^forward-bundle:separate:[0-9a-f-]{36}$/u);
  assert.equal(bundleCard.body.reply_markup.inline_keyboard[1][0].text, "📤 Отправить раздельно");
  assert.doesNotMatch(JSON.stringify(bundleCard.body.reply_markup), /Убрать последнее/u);

  await webhook({
    update_id: 202,
    message: {
      message_id: 3,
      date: 1_786_200_002,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Другой автор" },
      text: "Вторая независимая задача",
    },
  });
  assert.match(telegramCalls.at(-1).body.text, /переслано: 2/u);

  await webhook({
    update_id: 203,
    message: {
      message_id: 4,
      date: 1_786_200_003,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      reply_to_message: { message_id: 2 },
      text: "Уточнение только для первой задачи",
    },
  });
  assert.match(telegramCalls.at(-1).body.text, /Сообщений: 3/u);

  await webhook({
    update_id: 204,
    message: {
      message_id: 5,
      date: 1_786_200_004,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      reply_to_message: { message_id: 3 },
      text: "Уточнение только для второй задачи",
    },
  });
  assert.match(telegramCalls.at(-1).body.text, /ваших: 2/u);

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.deepEqual((await response.json()).commands, []);

  response = await webhook({
    update_id: 205,
    callback_query: {
      id: "callback-1",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: bundleCard.body.message_id ?? 801, chat: { id: 42, type: "private" } },
      data: separateCallback,
    },
  });
  assert.equal(response.status, 200);
  assert.ok(telegramCalls.some((call) => call.method === "answerCallbackQuery"));

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [firstCommand, secondCommand] = (await response.json()).commands;
  assert.equal(firstCommand.action, "board-task-ingest");
  assert.match(firstCommand.params.attachments[0], /^remote-attachment:[0-9a-f-]{36}$/u);
  assert.match(firstCommand.params.text, /Переслано · Заказчик/u);
  assert.doesNotMatch(firstCommand.params.text, /Ниже пакет сообщений/u);
  assert.match(firstCommand.params.text, /Изображение 1 приложено/u);
  assert.match(firstCommand.params.text, /Уточнение только для первой задачи/u);
  assert.doesNotMatch(firstCommand.params.text, /Вторая независимая задача|Уточнение только для второй/u);
  assert.equal(firstCommand.params.sourceDetails.messageCount, 2);
  assert.equal(firstCommand.params.sourceDetails.separate, true);
  assert.equal(firstCommand.params.sourceDetails.separateIndex, 1);
  assert.match(firstCommand.params.sourceKey, /^shared-dashboard:[0-9a-f-]{36}:1$/u);

  assert.equal(secondCommand.action, "board-task-ingest");
  assert.match(secondCommand.params.text, /Переслано · Другой автор/u);
  assert.match(secondCommand.params.text, /Вторая независимая задача/u);
  assert.match(secondCommand.params.text, /Уточнение только для второй задачи/u);
  assert.doesNotMatch(secondCommand.params.text, /Заказчик|Уточнение только для первой/u);
  assert.equal(secondCommand.params.sourceDetails.messageCount, 2);
  assert.equal(secondCommand.params.sourceDetails.separate, true);
  assert.equal(secondCommand.params.sourceDetails.separateIndex, 2);
  assert.match(secondCommand.params.sourceKey, /^shared-dashboard:[0-9a-f-]{36}:2$/u);
  assert.ok(telegramCalls.some((call) => call.method === "editMessageText" && /Создано отдельных задач: 2/u.test(call.body.text)));

  await webhook({
    update_id: 206,
    message: {
      message_id: 6,
      date: 1_786_200_006,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Другой автор" },
      text: "Это уже отдельная задача",
    },
  });
  const latestCard = telegramCalls.filter((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text)).at(-1);
  assert.notEqual(latestCard.body.reply_markup.inline_keyboard[0][0].callback_data, sendCallback);

  response = await webhook({
    update_id: 207,
    callback_query: {
      id: "callback-send-bundle",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: latestCard.body.message_id ?? 802, chat: { id: 42, type: "private" } },
      data: latestCard.body.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  assert.equal(response.status, 200);

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [bundledCommand] = (await response.json()).commands;
  assert.equal(bundledCommand.params.sourceDetails.separate, false);
  assert.doesNotMatch(bundledCommand.params.text, /Ниже пакет сообщений/u);
  assert.match(bundledCommand.params.sourceKey, /^shared-dashboard:[0-9a-f-]{36}$/u);

  await webhook({
    update_id: 208,
    message: {
      message_id: 7,
      date: 1_786_200_008,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      photo: [{ file_id: "standalone-small" }, { file_id: "standalone-large", file_size: 4 }],
    },
  });
  const standaloneImageCard = telegramCalls
    .filter((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text))
    .at(-1);
  assert.match(standaloneImageCard.body.text, /изображений: 1/u);

  await webhook({
    update_id: 209,
    message: {
      message_id: 8,
      date: 1_786_200_009,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      text: "FB Миллениум",
    },
  });
  assert.match(telegramCalls.at(-1).body.text, /Сообщений: 2/u);

  await webhook({
    update_id: 210,
    callback_query: {
      id: "callback-send-standalone-image",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: 803, chat: { id: 42, type: "private" } },
      data: standaloneImageCard.body.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [standaloneImageCommand] = (await response.json()).commands;
  assert.equal(standaloneImageCommand.params.sourceDetails.messageCount, 2);
  assert.equal(standaloneImageCommand.params.sourceDetails.imageCount, 1);
  assert.match(standaloneImageCommand.params.attachments[0], /^remote-attachment:[0-9a-f-]{36}$/u);
  assert.match(standaloneImageCommand.params.text, /Изображение 1 приложено/u);
  assert.match(standaloneImageCommand.params.text, /FB Миллениум/u);
});

test("Worker relay stores user-bound file uploads and serves them only to their command", async () => {
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

  const documentBody = Buffer.from("проверить документ", "utf8");
  response = await workerModule.default.fetch(new Request("https://hub.test/api/attachment", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "text/plain",
      "X-Agent-Hub-File-Name": encodeURIComponent("требования.txt"),
    },
    body: documentBody,
  }), env);
  assert.equal(response.status, 201);
  const uploadedDocument = await response.json();
  assert.match(uploadedDocument.path, /^remote-attachment:[0-9a-f-]{36}$/u);

  const commandId = "018f6c86-3f34-7a31-8f27-16f5b96cce30";
  response = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: commandId,
      action: "send-message",
      params: { text: "Посмотри", attachments: [uploaded.path, uploadedDocument.path] },
    }),
  }), env);
  assert.equal(response.status, 202);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10 }, syncSecret),
    env,
  );
  const command = (await response.json()).commands[0];
  assert.deepEqual(command.params.attachments, [uploaded.path, uploadedDocument.path]);

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
      id: uploadedDocument.id,
      userId: "42",
      commandId,
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/plain");
  assert.equal(decodeURIComponent(response.headers.get("X-Agent-Hub-File-Name")), "требования.txt");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), documentBody);

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

test("Worker serves temporary historical attachment views only to their owner", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const botToken = "123456:test-token";
  const syncSecret = "h".repeat(64);
  const env = {
    TELEGRAM_BOT_TOKEN: botToken,
    ALLOWED_USER_IDS: "42,84",
    SYNC_SECRET: syncSecret,
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce41";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const bodyHash = createHash("sha256").update(png).digest("hex");
  let response = await workerModule.default.fetch(signedBinaryServiceRequest(
    "https://hub.test/api/control/attachment/view/push",
    png,
    syncSecret,
    {
      "Content-Type": "image/png",
      "X-Agent-Hub-User-Id": "42",
      "X-Agent-Hub-Attachment-Id": id,
      "X-Agent-Hub-Attachment-Hash": bodyHash,
    },
  ), env);
  assert.equal(response.status, 201);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${id}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 42)}` } },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${id}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 84)}` } },
  ), env);
  assert.equal(response.status, 404);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/control/attachment/view/push",
    { method: "POST", headers: { "Content-Type": "image/png" }, body: png },
  ), env);
  assert.equal(response.status, 401);
});

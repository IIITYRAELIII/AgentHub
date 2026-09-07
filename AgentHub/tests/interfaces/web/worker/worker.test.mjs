import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { measureImmediateControlDrain } from "../../../../cloudflare-worker/verify-deployment.mjs";

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

test("Dashboard bot materializes an attachment before crossing the public Worker boundary", async () => {
  const worker = await loadWorker();
  const chunks = [Buffer.from("first"), Buffer.from("second")];
  const upstream = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), {
    status: 200,
    headers: {
      "Content-Length": String(chunks.reduce((total, chunk) => total + chunk.length, 0)),
      "Content-Type": "application/octet-stream",
      "X-Agent-Hub-Attachment-Hash": "a".repeat(64),
    },
  });

  const response = await worker.materializeDashboardBotAttachmentResponse(upstream);

  assert.equal(upstream.bodyUsed, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Agent-Hub-Attachment-Hash"), "a".repeat(64));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat(chunks));
});

test("Dashboard bot reports Durable Object exhaustion as an observable retryable service state", async () => {
  const worker = await loadWorker();
  const hubId = "018f6c86-3f34-7a31-8f27-16f5b96cce70";
  const hubSecret = "h".repeat(64);
  const diagnostics = [];
  const originalError = console.error;
  console.error = (message) => diagnostics.push(String(message));
  try {
    const response = await worker.default.fetch(signedServiceRequest(
      "https://hub.test/api/dashboard-bot/pull",
      { limit: 10, waitMs: 25_000 },
      hubSecret,
      { "X-Agent-Hub-Dashboard-Id": hubId },
    ), {
      JOURNAL: {
        getByName: () => ({
          fetch: async () => { throw new Error("Exceeded allowed volume of requests in Durable Objects free tier."); },
        }),
      },
      ASSETS: { fetch: async () => new Response("asset") },
    });

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.deepEqual(await response.json(), {
      error: "Dashboard bot storage is temporarily unavailable",
      code: "dashboard_bot_storage_unavailable",
    });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /"stage":"authenticate"/u);
    assert.match(diagnostics[0], /Exceeded allowed volume/u);
  } finally {
    console.error = originalError;
  }
});

test("Dashboard transport probe exposes a bounded ordered attachment manifest", async () => {
  const worker = await loadWorker();
  const manifestResponse = await worker.dashboardAttachmentTransportProbeResponse(new Request(
    "https://hub.test/api/transport-probe/attachment?mode=manifest&page=0",
  ));
  const manifestBody = Buffer.from(await manifestResponse.arrayBuffer());
  const manifest = JSON.parse(manifestBody.toString("utf8"));
  assert.ok(manifestBody.length < 25 * 1024);
  assert.ok(manifest.size > 100 * 1024);
  assert.equal(manifest.protocol, worker.ATTACHMENT_TRANSPORT_PROTOCOL);
  assert.equal(manifest.count, manifest.chunks.length);
  const chunks = [];
  for (const descriptor of manifest.chunks) {
    const request = new Request(
      `https://hub.test/api/transport-probe/attachment?mode=chunk&index=${descriptor.index}`,
    );
    const first = await worker.dashboardAttachmentTransportProbeResponse(request);
    const second = await worker.dashboardAttachmentTransportProbeResponse(request);
    const firstBody = Buffer.from(await first.arrayBuffer());
    const secondBody = Buffer.from(await second.arrayBuffer());
    assert.ok(firstBody.length <= worker.ATTACHMENT_TRANSPORT_CHUNK_BYTES);
    assert.deepEqual(firstBody, secondBody);
    assert.equal(createHash("sha256").update(firstBody).digest("hex"), descriptor.hash);
    chunks.push(firstBody);
  }
  const body = Buffer.concat(chunks);
  assert.equal(body.length, manifest.size);
  assert.equal(createHash("sha256").update(body).digest("hex"), manifest.hash);
});

class MemoryStorage {
  values = new Map();
  alarmAt = null;
  listCalls = [];
  getTrace = [];
  listTrace = [];

  async get(key) {
    this.getTrace.push(Array.isArray(key) ? [...key] : [key]);
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
    this.listCalls.push({ prefix, start, startAfter, end, limit });
    this.listTrace.push({ prefix, start, startAfter, end, limit });
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
    const values = new Map(this.values);
    try {
      return await callback(this);
    } catch (error) {
      this.values = values;
      throw error;
    }
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

  resetReadTrace() {
    this.getTrace = [];
    this.listTrace = [];
  }
}

class RollbackFaultStorage extends MemoryStorage {
  failDeleteKey = null;

  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    if (this.failDeleteKey && keys.includes(this.failDeleteKey)) {
      this.failDeleteKey = null;
      throw new Error("injected attachment manifest promotion failure");
    }
    return super.delete(key);
  }

  async transaction(callback) {
    const values = new Map(this.values);
    const alarmAt = this.alarmAt;
    try {
      return await callback(this);
    } catch (error) {
      this.values = values;
      this.alarmAt = alarmAt;
      throw error;
    }
  }
}

class FakeWakeSocket {
  attachment = null;
  sent = [];
  onSend = null;

  serializeAttachment(value) {
    this.attachment = value;
  }

  send(value) {
    this.onSend?.(value);
    this.sent.push(value);
  }
}

function wakeContext(storage) {
  const sockets = [];
  return {
    storage,
    sockets,
    autoResponse: null,
    acceptWebSocket(socket, tags) {
      socket.tags = tags;
      sockets.push(socket);
    },
    getWebSockets(tag) {
      return sockets.filter((socket) => socket.tags?.includes(tag));
    },
    setWebSocketAutoResponse(value) {
      this.autoResponse = value;
    },
  };
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

function signedWakeRequest(url, secret) {
  const target = new URL(url);
  const timestamp = Math.trunc(Date.now() / 1_000);
  const signature = createHmac("sha256", secret)
    .update([
      timestamp,
      "GET",
      target.pathname,
      createHash("sha256").update("").digest("hex"),
    ].join("\n"))
    .digest("hex");
  target.searchParams.set("timestamp", String(timestamp));
  target.searchParams.set("signature", signature);
  return new Request(target, { headers: { Upgrade: "websocket" } });
}

function dashboardBotHubRegistry(entries) {
  return JSON.stringify({
    version: 1,
    hubs: Object.fromEntries(entries.map(([hubId, secret]) => [
      hubId,
      `sha256:${createHash("sha256").update(secret).digest("hex")}`,
    ])),
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

  const deniedPairingId = "018f6c86-3f34-7a31-8f27-16f5b96cce12";
  response = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      commandId: deniedPairingId,
      action: "create-device-pairing",
      source: "trusted-device",
      params: {},
    }),
  }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Только доверенное устройство может делегировать доступ." });
  assert.equal(await storage.get(`control:command:${deniedPairingId}`), undefined);

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

test("hibernation wake persists before notify and disables migrated service long polls", async () => {
  const workerModule = await loadWorker();
  const storage = new MemoryStorage();
  const ctx = wakeContext(storage);
  const client = new FakeWakeSocket();
  const server = new FakeWakeSocket();
  const commandId = "018f6c86-3f34-7a31-8f27-16f5b96cce75";
  let persistedBeforeNotify = false;
  server.onSend = () => {
    persistedBeforeNotify = storage.values.has(`control:command:${commandId}`);
  };
  await workerModule.acceptHibernatableControlWake(ctx, {
    channel: "mini-app",
    pairFactory: () => ({ client, server }),
    autoResponseFactory: () => ({ request: "ping", response: "pong" }),
  });
  const store = new workerModule.JournalStore(ctx, {});

  const enqueue = await store.fetch(new Request("https://journal.internal/control/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: commandId,
      userId: "42",
      action: "snapshot",
      params: {},
    }),
  }));
  assert.equal(enqueue.status, 202);
  assert.equal(persistedBeforeNotify, true);
  assert.deepEqual(server.attachment, {
    protocol: workerModule.CONTROL_WAKE_PROTOCOL,
    channel: "mini-app",
  });
  assert.deepEqual(JSON.parse(server.sent[0]), {
    protocol: workerModule.CONTROL_WAKE_PROTOCOL,
    kind: "available",
    revision: 1,
  });

  const legacy = await store.fetch(new Request("https://journal.internal/control/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10, waitMs: 1_000 }),
  }));
  assert.equal(legacy.status, 409);
  assert.equal((await legacy.json()).code, "control_wake_required");

  const immediate = await store.fetch(new Request("https://journal.internal/control/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit: 10, waitMs: 0, transport: workerModule.CONTROL_WAKE_PROTOCOL }),
  }));
  assert.equal(immediate.status, 200);
  assert.equal((await immediate.json()).commands[0].id, commandId);
});

test("immediate durable drain stays inside the production p99 budget", async () => {
  const workerModule = await loadWorker();
  const store = new workerModule.JournalStore({ storage: new MemoryStorage() }, {});
  const measured = await measureImmediateControlDrain({
    samples: 20,
    drain: async () => {
      const response = await store.fetch(new Request("https://journal.internal/control/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 10, waitMs: 0, transport: workerModule.CONTROL_WAKE_PROTOCOL }),
      }));
      return response.json();
    },
  });

  assert.equal(measured.samples, 20);
  assert.ok(measured.p99Ms <= 250);
});

test("wake authentication binds the exact path and routes each service to its exact Durable Object", async () => {
  const workerModule = await loadWorker();
  const syncSecret = "w".repeat(64);
  const hubSecret = "h".repeat(64);
  const hubId = "018f6c86-3f34-7a31-8f27-16f5b96cce76";
  const routed = [];
  const env = {
    SYNC_SECRET: syncSecret,
    JOURNAL: {
      getByName(name) {
        return {
          fetch: async (request) => {
            routed.push({ name, pathname: new URL(request.url).pathname });
            return Response.json({ routed: true });
          },
        };
      },
    },
    ASSETS: { fetch: async () => new Response("asset") },
  };

  const controlRequest = signedWakeRequest("https://hub.test/api/control/wake", syncSecret);
  assert.equal(await workerModule.validateControlWakeRequest(controlRequest.clone(), syncSecret), true);
  await assert.rejects(
    workerModule.validateControlWakeRequest(controlRequest.clone(), hubSecret),
    /invalid control wake signature/u,
  );
  let response = await workerModule.default.fetch(controlRequest, env);
  assert.equal(response.status, 200);
  assert.deepEqual(routed.pop(), { name: "current", pathname: "/control/wake" });

  const dashboardRequest = signedWakeRequest(
    `https://hub.test/api/dashboard-bot/wake?hubId=${hubId}`,
    hubSecret,
  );
  response = await workerModule.default.fetch(dashboardRequest, env);
  assert.equal(response.status, 200);
  assert.deepEqual(routed.pop(), { name: `dashboard-bot:${hubId}`, pathname: "/api/dashboard-bot/wake" });
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
  const shell = Buffer.alloc(32 * 1_024, "x");
  let shellResponse = null;
  const env = {
    JOURNAL: { getByName: () => ({}) },
    ASSETS: {
      fetch: async (request) => {
        shellResponse = new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(shell.subarray(0, 16 * 1_024));
              controller.enqueue(shell.subarray(16 * 1_024));
              controller.close();
            },
          }),
          {
            headers: {
              "Content-Length": "999999",
              "Content-Type": ["/", "/index.html"].includes(new URL(request.url).pathname)
                ? "text/html; charset=utf-8"
                : "text/javascript; charset=utf-8",
            },
          },
        );
        return shellResponse;
      },
    },
  };

  let response = await workerModule.default.fetch(new Request("https://hub.test/"), env);
  assert.equal(shellResponse.bodyUsed, true);
  assert.equal(response.headers.get("X-Agent-Hub-Static-Body"), "chunk-bootstrap");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const bootstrap = await response.text();
  const chunkCount = Number(bootstrap.match(/data-agent-hub-shell-chunks="(\d+)"/u)?.[1]);
  const shellBytes = Number(bootstrap.match(/data-agent-hub-shell-bytes="(\d+)"/u)?.[1]);
  assert.equal(shellBytes, shell.length);
  assert.ok(chunkCount > 1);

  response = await workerModule.default.fetch(
    new Request("https://hub.test/__agent-hub-shell-loader.js"),
    env,
  );
  assert.match(await response.text(), /document\.write\(html\)/u);

  const chunks = [];
  for (let index = 0; index < chunkCount; index += 1) {
    response = await workerModule.default.fetch(
      new Request(`https://hub.test/index.html?__agent_hub_shell_chunk=${index}`),
      env,
    );
    const chunk = Buffer.from(await response.arrayBuffer());
    assert.ok(chunk.length <= 16 * 1_024);
    assert.equal(response.headers.get("X-Agent-Hub-Shell-Chunk"), `${index + 1}/${chunkCount}`);
    chunks.push(chunk);
  }
  assert.deepEqual(Buffer.concat(chunks), shell);

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
    signedServiceRequest("https://hub.test/api/device/pairing", {
      userId: "42",
      code: "ABCDE-FGHIJ-KLMNO-PQRST",
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);
  const pairing = await response.json();
  assert.equal(pairing.code, "ABCDE-FGHIJ-KLMNO-PQRST");

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
    "agent-hub-device-session-v2",
    "https://hub.test",
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
  // The session also travels as an HttpOnly cookie, so page scripts never need
  // to hold the bearer token.
  assert.match(
    String(response.headers.get("Set-Cookie")),
    new RegExp(`^agent_hub_device=${session.token}; Max-Age=\\d+; Path=/; HttpOnly; Secure; SameSite=Strict$`, "u"),
  );

  const commandId = "018f6c86-3f34-7a31-8f27-16f5b96cce11";
  response = await workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: {
      Authorization: `device ${session.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commandId, action: "create-device-pairing", params: {} }),
  }), env);
  assert.equal(response.status, 202);
  assert.deepEqual(
    (({ action, source, userId }) => ({ action, source, userId }))(
      await storage.get(`control:command:${commandId}`),
    ),
    { action: "create-device-pairing", source: "trusted-device", userId: "42" },
  );

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

test("Worker journal exposes compact totals and bounded turn pages separately", async () => {
  const workerModule = await loadWorker();
  const store = new workerModule.JournalStore({ storage: new MemoryStorage() }, {});
  const turnEntries = [
    ...Array.from({ length: 60 }, (_, index) => ({
      turnRef: `ref-${String(index).padStart(2, "0")}`,
      date: "01.08.2026",
      dayMs: Date.UTC(2026, 7, 1),
      workspaceId: "workspace-1",
      streamId: "stream-1",
      provider: "codex",
      threadId: "thread-1",
      turnId: `turn-${index}`,
      completedAtMs: Date.UTC(2026, 7, 1, 12) - index,
      html: `<div data-work-log-turn-entry data-work-log-turn-id="turn-${index}">Ход</div>`,
    })),
    {
      turnRef: "ref-week",
      date: "03.08.2026",
      dayMs: Date.UTC(2026, 7, 3),
      workspaceId: "workspace-1",
      streamId: "stream-2",
      provider: "claude",
      threadId: "thread-2",
      turnId: "turn-week",
      completedAtMs: Date.UTC(2026, 7, 3, 12),
      html: '<div data-work-log-turn-entry data-work-log-turn-id="turn-week">Ход</div>',
    },
    {
      turnRef: "ref-month",
      date: "20.08.2026",
      dayMs: Date.UTC(2026, 7, 20),
      workspaceId: "workspace-1",
      streamId: "stream-2",
      provider: "codex",
      threadId: "thread-3",
      turnId: "turn-month",
      completedAtMs: Date.UTC(2026, 7, 20, 12),
      html: '<div data-work-log-turn-entry data-work-log-turn-id="turn-month">Ход</div>',
    },
  ];
  const summary = { version: 1, buckets: [{
    date: "01.08.2026",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    provider: "codex",
    turnCount: 60,
    fileTouches: 12,
    knownFileTouches: 60,
    skillNames: ["journal"],
  }, {
    date: "02.08.2026",
    dayMs: Date.UTC(2026, 7, 2),
    workspaceId: "workspace-2",
    streamId: "stream-2",
    provider: "codex",
    turnCount: 1,
    fileTouches: 99,
  }] };
  assert.equal((await store.fetch(new Request("https://journal.internal/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      html: '<details data-lazy-day="01.08.2026"></details>',
      summary,
      turnEntries,
      days: {},
      turns: {},
      version: "journal-v1",
      updatedAt: "2026-08-01T12:00:00.000Z",
    }),
  }))).status, 200);

  const index = await (await store.fetch(new Request("https://journal.internal/journal"))).json();
  assert.equal(index.summary.buckets[0].turnCount, 60);
  assert.equal(Object.hasOwn(index.summary.buckets[0], "fileTouches"), false);
  assert.equal(Object.hasOwn(index, "turnEntries"), false);

  const firstResponse = await store.fetch(new Request(
    "https://journal.internal/journal/turns?workspaceId=workspace-1&streamId=stream-1&profileMode=stream&limit=200",
  ));
  const firstBody = await firstResponse.text();
  assert.equal(firstResponse.status, 200, firstBody);
  const first = JSON.parse(firstBody);
  assert.equal(first.turns.length, 50);
  assert.equal(first.nextOffset, 50);
  assert.equal(first.profileSummary.buckets.length, 2);
  assert.equal(first.profileSummary.buckets[0].fileTouches, 12);
  assert.equal(first.profileSummary.buckets[1].fileTouches, 99);
  const second = await (await store.fetch(new Request(
    "https://journal.internal/journal/turns?workspaceId=workspace-1&streamId=stream-1&offset=50",
  ))).json();
  assert.equal(second.turns.length, 10);
  assert.equal(second.nextOffset, null);
  const ranged = await (await store.fetch(new Request(
    "https://journal.internal/journal/turns?workspaceId=workspace-1&streamId=stream-1"
    + `&fromMs=${Date.UTC(2026, 7, 1)}&toMs=${Date.UTC(2026, 7, 2)}&limit=10`,
  ))).json();
  assert.equal(ranged.turns.length, 10);
  assert.equal(ranged.nextOffset, 10);
  for (const [mode, fromMs, toMs, expected] of [
    ["date", Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 2), 10],
    ["week", Date.UTC(2026, 7, 1), Date.UTC(2026, 7, 8), 11],
    ["month", Date.UTC(2026, 7, 1), Date.UTC(2026, 8, 1), 12],
    ["workspace", 0, 0, 12],
  ]) {
    const page = await (await store.fetch(new Request(
      "https://journal.internal/journal/turns?workspaceId=workspace-1&offset=50&limit=50"
      + `${fromMs ? `&fromMs=${fromMs}&toMs=${toMs}` : ""}`,
    ))).json();
    assert.equal(page.turns.length, expected, mode);
    assert.equal(page.nextOffset, null, mode);
  }
  const codexWorkspace = await (await store.fetch(new Request(
    "https://journal.internal/journal/turns?workspaceId=workspace-1&provider=codex&offset=50&limit=50",
  ))).json();
  assert.equal(codexWorkspace.turns.length, 11);
  assert.equal((await store.fetch(new Request(
    "https://journal.internal/journal/turns?workspaceId=workspace-1&version=old",
  ))).status, 409);
});

test("Worker chunk publication cuts over atomically and retries an orphan generation", async () => {
  const worker = await loadWorker();
  class FailingManifestStorage extends MemoryStorage {
    failManifest = false;

    async put(key, value) {
      if (this.failManifest && key === "journal-projection-manifest") {
        throw new Error("injected manifest failure");
      }
      return super.put(key, value);
    }
  }
  const storage = new FailingManifestStorage();
  const store = new worker.JournalStore({ storage }, {});
  const payload = (version, label) => ({
    html: `<main>${label}</main>`,
    summary: { version: 1, buckets: [] },
    turnEntries: [],
    days: {},
    turns: {},
    version,
    updatedAt: "2026-09-07T23:59:00.000Z",
  });
  assert.equal((await store.fetch(new Request("https://journal.internal/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload("journal-a", "A")),
  }))).status, 200);

  storage.failManifest = true;
  await assert.rejects(store.fetch(new Request("https://journal.internal/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload("journal-b", "B")),
  })), /injected manifest failure/u);
  let current = await (await store.fetch(new Request("https://journal.internal/journal"))).json();
  assert.equal(current.version, "journal-a");
  assert.match(current.html, />A</u);

  storage.failManifest = false;
  const next = payload("journal-b", "B");
  const serialized = JSON.stringify(next);
  const body = gzipSync(Buffer.from(serialized, "utf8"));
  const complete = await store.fetch(syncChunkRequest({
    syncId: `sync-${createHash("sha256").update(serialized).digest("hex")}`,
    index: 0,
    count: 1,
    version: next.version,
    updatedAt: next.updatedAt,
    body,
  }));
  assert.equal(complete.status, 200);
  assert.deepEqual(await complete.json(), { ok: true, complete: true });
  current = await (await store.fetch(new Request("https://journal.internal/journal"))).json();
  assert.equal(current.version, "journal-b");
  assert.match(current.html, />B</u);
});

test("Worker retires the unqualified v1 generation after two v2 cutovers", async () => {
  const worker = await loadWorker();
  const storage = new MemoryStorage();
  const store = new worker.JournalStore({ storage }, {});
  const legacySyncId = `sync-${"1".repeat(64)}`;
  const legacyPrefix = `journal-projection:${legacySyncId}:`;
  await storage.put({
    "journal-projection-manifest": {
      layoutVersion: 1,
      syncId: legacySyncId,
      version: "journal-v1",
      updatedAt: "2026-09-07T23:58:00.000Z",
      previousSyncId: "",
    },
    [`${legacyPrefix}meta`]: {
      layoutVersion: 1,
      syncId: legacySyncId,
      version: "journal-v1",
      updatedAt: "2026-09-07T23:58:00.000Z",
    },
    [`${legacyPrefix}index-html:000000`]: new TextEncoder().encode("<main>legacy</main>"),
  });
  const payload = (version, label) => ({
    html: `<main>${label}</main>`,
    summary: { version: 1, buckets: [] },
    turnEntries: [],
    days: {},
    turns: {},
    version,
    updatedAt: "2026-09-07T23:59:00.000Z",
  });

  assert.equal((await store.fetch(new Request("https://journal.internal/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload("journal-v2-a", "A")),
  }))).status, 200);
  let current = await (await store.fetch(new Request("https://journal.internal/journal"))).json();
  assert.equal(current.version, "journal-v2-a");
  assert.match(current.html, />A</u);
  let manifest = await storage.get("journal-projection-manifest");
  assert.equal(manifest.previousSyncId, legacySyncId);
  assert.equal(manifest.previousLayoutVersion, 1);
  assert.equal((await storage.list({ prefix: legacyPrefix })).size, 2);

  assert.equal((await store.fetch(new Request("https://journal.internal/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload("journal-v2-b", "B")),
  }))).status, 200);
  current = await (await store.fetch(new Request("https://journal.internal/journal"))).json();
  assert.equal(current.version, "journal-v2-b");
  assert.match(current.html, />B</u);
  manifest = await storage.get("journal-projection-manifest");
  assert.equal(manifest.layoutVersion, 2);
  assert.equal(manifest.previousLayoutVersion, 2);
  assert.equal((await storage.list({ prefix: legacyPrefix })).size, 0);
  assert.ok((await storage.list({
    prefix: `journal-projection:v2:${manifest.previousSyncId}:`,
  })).size > 0);
});

test("Worker journal turn pages read only materialized bounded index keys", async () => {
  const worker = await loadWorker();
  const storage = new MemoryStorage();
  const store = new worker.JournalStore({ storage }, {});
  const turnEntries = Array.from({ length: 6_000 }, (_, index) => {
    const primary = index < 3_000;
    const ordinal = primary ? index : index - 3_000;
    return {
      turnRef: `turn-ref-${index}`,
      date: "07.09.2026",
      dayMs: Date.UTC(2026, 8, 7),
      workspaceId: primary ? "workspace-1" : "workspace-2",
      streamId: primary ? "stream-1" : "stream-2",
      provider: "codex",
      threadId: primary ? "thread-1" : "thread-2",
      turnId: `turn-${index}`,
      completedAtMs: Date.UTC(2026, 8, 7, 23, 59) - ordinal,
      html: `<div data-work-log-turn-entry data-work-log-turn-id="turn-${index}">Ход ${index}</div>`,
    };
  });
  const payload = {
    html: '<details data-lazy-day="07.09.2026"></details>',
    summary: { version: 1, buckets: [] },
    turnEntries,
    days: {},
    turns: {},
    version: "journal-large-v1",
    updatedAt: "2026-09-07T23:59:00.000Z",
  };
  assert.equal((await store.fetch(new Request("https://journal.internal/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }))).status, 200);
  storage.resetReadTrace();

  const index = await (await store.fetch(new Request("https://journal.internal/journal"))).json();
  assert.equal(index.version, "journal-large-v1");
  assert.ok(storage.getTrace.flat().every((key) => !/turn-shell|:scope:/u.test(key)));
  storage.resetReadTrace();

  const response = await store.fetch(new Request(
    "https://journal.internal/journal/turns?workspaceId=workspace-1&streamId=stream-1"
    + "&offset=2900&limit=30&version=journal-large-v1",
  ));
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.turns.length, 30);
  assert.equal(page.nextOffset, 2930);
  assert.match(page.turns[0].html, /turn-2900/u);
  assert.equal(storage.listTrace.length, 0);
  assert.ok(storage.getTrace.length <= 5);
  assert.ok(storage.getTrace.every((keys) => keys.length <= 30));
  assert.ok(storage.getTrace.flat().every((key) => (
    key === "journal-projection-manifest" || key.startsWith("journal-projection:")
  )));
});

test("Worker profile cohort retains the exact requested mixed-provider Stream", async () => {
  const worker = await loadWorker();
  const storage = new MemoryStorage();
  const store = new worker.JournalStore({ storage }, {});
  const peerBuckets = Array.from({ length: 2_048 }, (_, index) => ({
    date: "07.09.2026",
    dayMs: Date.UTC(2026, 8, 7),
    workspaceId: `workspace-${index}`,
    streamId: `stream-${index}`,
    provider: "codex",
    latestAt: 10_000 - index,
    credits: 10_000 - index,
    fileTouches: index + 1,
  }));
  const requestedBuckets = ["codex", "claude"].map((provider, index) => ({
    date: "01.01.2020",
    dayMs: Date.UTC(2020, 0, 1),
    workspaceId: "workspace-required",
    streamId: "stream-required",
    provider,
    latestAt: index + 1,
    credits: index + 1,
    fileTouches: 50 + index,
  }));
  assert.equal((await store.fetch(new Request("https://journal.internal/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      html: "<main></main>",
      summary: { version: 1, buckets: [...peerBuckets, ...requestedBuckets] },
      turnEntries: [],
      days: {},
      turns: {},
      version: "journal-profile-required-v1",
      updatedAt: "2026-09-07T23:59:00.000Z",
    }),
  }))).status, 200);
  storage.resetReadTrace();

  const response = await store.fetch(new Request(
    "https://journal.internal/journal/turns?workspaceId=workspace-required"
    + "&streamId=stream-required&profileMode=stream",
  ));
  assert.equal(response.status, 200);
  const page = await response.json();
  const requested = page.profileSummary.buckets.filter((bucket) => (
    bucket.workspaceId === "workspace-required" && bucket.streamId === "stream-required"
  ));
  assert.deepEqual(requested.map((bucket) => bucket.provider).sort(), ["claude", "codex"]);
  assert.equal(new Set(page.profileSummary.buckets.map((bucket) => (
    `${bucket.workspaceId}\u001f${bucket.streamId}\u001f${bucket.provider}`
  ))).size, page.profileSummary.buckets.length);
  assert.equal(page.profileSummary.buckets.length, 2_050);
  assert.equal(page.profileSummary.truncated, true);
  assert.equal(storage.listTrace.length, 0);
  assert.ok(storage.getTrace.flat().every((key) => !key.includes("turn-shell")));
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

  assert.deepEqual(workerModule.validateControlCommand({
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce16",
    action: "message-pin-set",
    params: { streamId: "stream-1", messageKey: "message:v1:answer", pinned: false },
  }), {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce16",
    action: "message-pin-set",
    params: { streamId: "stream-1", messageKey: "message:v1:answer", pinned: false },
  });

  assert.deepEqual(workerModule.validateControlCommand({
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce14",
    action: "board-task-attachment-add",
    params: {
      id: "board-1",
      attachments: ["remote-attachment:018f6c86-3f34-7a31-8f27-16f5b96cce15"],
    },
  }), {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce14",
    action: "board-task-attachment-add",
    params: {
      id: "board-1",
      attachments: ["remote-attachment:018f6c86-3f34-7a31-8f27-16f5b96cce15"],
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

test("Worker control payload limits reject deep, broad, and oversized commands", async () => {
  const worker = await loadWorker();
  const command = (params) => ({
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce10",
    action: "send-message",
    params,
  });
  let deeplyNested = "terminal";
  for (let depth = 0; depth <= 32; depth += 1) deeplyNested = { next: deeplyNested };

  assert.throws(
    () => worker.validateControlCommand(command(deeplyNested)),
    /control command payload exceeds depth limit/u,
  );
  assert.throws(
    () => worker.validateControlCommand(command({ values: Array.from({ length: 1_024 }, () => 0) })),
    /control command payload exceeds node limit/u,
  );
  assert.throws(
    () => worker.validateControlCommand(command({ text: "x".repeat(48 * 1_024) })),
    /control command payload exceeds byte limit/u,
  );
});

test("shared Dashboard bot registration rejects untrusted requests without storing them", async () => {
  const workerModule = await loadWorker();
  const { namespace, stores } = durableNamespace(workerModule);
  const hubId = "018f6c86-3f34-7a31-8f27-16f5b96cce50";
  const hubSecret = "h".repeat(64);
  const env = {
    DASHBOARD_BOT_HUB_REGISTRY: dashboardBotHubRegistry([[hubId, hubSecret]]),
    JOURNAL: namespace,
    ASSETS: { fetch: async () => new Response("asset") },
  };
  const unknownPayload = {
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce59",
    name: "Untrusted Hub",
    secret: hubSecret,
  };

  let response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(unknownPayload),
    },
  ), env);
  assert.equal(response.status, 403);
  const unknownError = await response.json();
  assert.equal(stores.get("dashboard-bot:router").ctx.storage.values.size, 0);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...unknownPayload, hubId, secret: "x".repeat(64) }),
    },
  ), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), unknownError);
  assert.equal(stores.get("dashboard-bot:router").ctx.storage.values.size, 0);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...unknownPayload, hubId, secret: hubSecret }),
    },
  ), { JOURNAL: namespace, ASSETS: env.ASSETS });
  assert.equal(response.status, 503);
  assert.equal(stores.get("dashboard-bot:router").ctx.storage.values.size, 0);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...unknownPayload, hubId, secret: hubSecret }),
    },
  ), { ...env, DASHBOARD_BOT_HUB_REGISTRY: "{" });
  assert.equal(response.status, 503);
  assert.equal(stores.get("dashboard-bot:router").ctx.storage.values.size, 0);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...unknownPayload, hubId, secret: hubSecret }),
    },
  ), env);
  assert.equal(response.status, 200);
  const storedEntries = stores.get("dashboard-bot:router").ctx.storage.values.size;
  assert.ok(storedEntries > 0);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...unknownPayload, hubId, secret: hubSecret }),
    },
  ), { JOURNAL: namespace, ASSETS: env.ASSETS });
  assert.equal(response.status, 200);
  assert.equal(stores.get("dashboard-bot:router").ctx.storage.values.size, storedEntries);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...unknownPayload, hubId, secret: hubSecret }),
    },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(stores.get("dashboard-bot:router").ctx.storage.values.size, storedEntries);
});

test("shared Dashboard bot migrates an existing paired Hub into its isolated router", async (context) => {
  const workerModule = await loadWorker();
  const { namespace, stores } = durableNamespace(workerModule);
  const hubId = "018f6c86-3f34-7a31-8f27-16f5b96cce49";
  const hubSecret = "m".repeat(64);
  const webhookSecret = "w".repeat(64);
  const registration = { hubId, name: "Legacy Hub", secret: hubSecret };
  const legacy = namespace.getByName("current");
  let response = await legacy.fetch(new Request(
    "https://journal.internal/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    },
  ));
  const pairing = await response.json();
  response = await legacy.fetch(new Request("https://journal.internal/dashboard-bot/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      update_id: 90,
      message: {
        message_id: 1,
        date: 1_786_200_000,
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Алиса" },
        text: `/link ${pairing.code}`,
      },
    }),
  }));
  assert.equal(response.status, 200);

  const telegramCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    telegramCalls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ ok: true, result: { message_id: 900 } });
  };
  context.after(() => { globalThis.fetch = originalFetch; });
  const env = {
    DASHBOARD_BOT_TOKEN: `123456:${"A".repeat(30)}`,
    DASHBOARD_BOT_WEBHOOK_SECRET: webhookSecret,
    JOURNAL: namespace,
    ASSETS: { fetch: async () => new Response("asset") },
  };
  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(registration),
    },
  ), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).paired, true);
  assert.equal(
    stores.get("dashboard-bot:router").ctx.storage.values.get(`dashboard-bot:user:42`),
    hubId,
  );

  stores.get("current").ctx.storage.values.clear();
  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/dashboard-bot/webhook",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": webhookSecret,
      },
      body: JSON.stringify({
        update_id: 91,
        message: {
          message_id: 2,
          date: 1_786_200_001,
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Алиса" },
          text: "/unknown",
        },
      }),
    },
  ), env);
  assert.equal(response.status, 200);
  assert.match(telegramCalls.at(-1).body.text, /Неизвестная команда/u);
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
    DASHBOARD_BOT_HUB_REGISTRY: dashboardBotHubRegistry([
      [hubId, hubSecret],
      [otherHubId, otherSecret],
    ]),
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
  assert.match(telegramCalls.at(-1).body.text, /Поставлено в очередь Agent Hub/u);

  stores.get(`dashboard-bot:${hubId}`).ctx.storage.values.delete("dashboard-bot:service-identity");

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
  assert.equal(telegramCalls.at(-1).body.text, "✅ Задача добавлена в Backlog.");
  const deliveredConfirmations = telegramCalls
    .filter((call) => call.body.text === "✅ Задача добавлена в Backlog.").length;
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: command.id, userId: "42", ok: true, result: { taskId: "task-1" } },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(
    telegramCalls.filter((call) => call.body.text === "✅ Задача добавлена в Backlog.").length,
    deliveredConfirmations,
  );
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
  assert.match(telegramCalls.at(-1).body.text, /Файл поставлен в очередь Agent Hub/u);

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
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: attachmentCommand.id, userId: "42", ok: true, result: { taskId: "task-1" } },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(telegramCalls.at(-1).body.text, "✅ Изменения сохранены в Dashboard.");

  response = await webhook({
    update_id: 1021,
    message: {
      message_id: 31,
      date: 1_786_200_003,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      voice: {
        file_id: "voice-ogg",
        mime_type: "audio/ogg",
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
  assert.match(telegramCalls.at(-1).body.text, /Файл поставлен в очередь Agent Hub/u);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [voiceCommand] = (await response.json()).commands;
  assert.equal(voiceCommand.params.replyMessageId, 2);
  assert.deepEqual(voiceCommand.params.sourceDetails.attachmentKinds, ["voice"]);
  assert.match(voiceCommand.params.attachments[0], /^remote-attachment:[0-9a-f-]{36}$/u);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: voiceCommand.id, userId: "42", ok: true, result: { taskId: "task-1" } },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);

  response = await webhook({
    update_id: 1022,
    message: {
      message_id: 32,
      date: 1_786_200_004,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      document: {
        file_id: "requirements-pdf",
        file_name: "requirements.pdf",
        mime_type: "application/pdf",
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
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [fileCommand] = (await response.json()).commands;
  assert.deepEqual(fileCommand.params.sourceDetails.attachmentKinds, ["document"]);
  assert.match(fileCommand.params.attachments[0], /^remote-attachment:[0-9a-f-]{36}$/u);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: fileCommand.id, userId: "42", ok: true, result: { taskId: "task-1" } },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);

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
  assert.match(telegramCalls.at(-1).body.text, /Поставлено в очередь Agent Hub/u);
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

  response = await webhook({
    update_id: 150,
    message: {
      message_id: 30,
      date: 1_786_200_020,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      reply_to_message: {
        message_id: 2,
        from: { id: 42, first_name: "Алиса" },
        text: "Исправить фильтр на дашборде",
      },
      text: "Нужно закончить до пятницы",
    },
  });
  assert.equal(
    stores.get(`dashboard-bot:${hubId}`).ctx.storage.values.get("dashboard-bot:service-identity").hubId,
    hubId,
  );

  const globalHubKey = `dashboard-bot:hub:${hubId}`;
  const globalHub = stores.get("dashboard-bot:router").ctx.storage.values.get(globalHubKey);
  stores.get("dashboard-bot:router").ctx.storage.values.delete(globalHubKey);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  const [clarificationCommand] = (await response.json()).commands;
  assert.equal(clarificationCommand.params.text, "Нужно закончить до пятницы");
  stores.get("dashboard-bot:router").ctx.storage.values.set(globalHubKey, globalHub);
  assert.equal(response.status, 200);
  assert.match(telegramCalls.at(-1).body.text, /Уточнение поставлено в очередь Agent Hub/u);
  assert.equal(clarificationCommand.params.replyMessageId, 2);
  assert.equal(clarificationCommand.params.sourceKey, undefined);
  assert.equal(clarificationCommand.params.sourceDetails.messageId, 30);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: clarificationCommand.id, userId: "42", ok: false, error: "Dashboard недоступен" },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  assert.match(telegramCalls.at(-1).body.text, /Agent Hub не принял задачу: Dashboard недоступен/u);

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
      if (body.file_id === "telegram-too-large") {
        return Response.json({ ok: false, description: "Bad Request: file is too big" }, { status: 400 });
      }
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
    DASHBOARD_BOT_HUB_REGISTRY: dashboardBotHubRegistry([[hubId, hubSecret]]),
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
  assert.ok(telegramCalls.some((call) => call.method === "deleteMessage"));
  assert.equal(
    telegramCalls.filter((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text)).length,
    2,
  );

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
  assert.ok(telegramCalls.some((call) => (
    call.method === "editMessageText" && /поставлено в очередь: 2/iu.test(call.body.text)
  )));
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: firstCommand.id, userId: "42", ok: true, result: { taskId: "task-1" } },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(telegramCalls.at(-1).body.text, "✅ Задача 1 добавлена в Backlog.");
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: secondCommand.id, userId: "42", ok: true, result: { taskId: "task-2" } },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(telegramCalls.at(-1).body.text, "✅ Задача 2 добавлена в Backlog.");

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
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/result",
    { id: bundledCommand.id, userId: "42", ok: true, result: { taskId: "task-bundle" } },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(telegramCalls.at(-1).body.text, "✅ Пачка сообщений добавлена в Backlog.");

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
  assert.match(standaloneImageCard.body.text, /файлов: 1/u);

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
  assert.equal(standaloneImageCommand.params.sourceDetails.attachmentCount, 1);
  assert.deepEqual(standaloneImageCommand.params.sourceDetails.attachmentKinds, ["image"]);
  assert.match(standaloneImageCommand.params.attachments[0], /^remote-attachment:[0-9a-f-]{36}$/u);
  assert.match(standaloneImageCommand.params.text, /Изображение 1 приложено/u);
  assert.match(standaloneImageCommand.params.text, /FB Миллениум/u);

  await webhook({
    update_id: 211,
    message: {
      message_id: 9,
      date: 1_786_200_010,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Заказчик" },
      photo: [{ file_id: "unconfirmed-small" }, { file_id: "unconfirmed-large", file_size: 4 }],
      text: "Пачка перед временным сбоем",
    },
  });
  const stuckCard = telegramCalls
    .filter((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text))
    .at(-1);
  const bundleKey = "dashboard-bot:bundle:42";
  const router = namespace.getByName("dashboard-bot:router");
  const routerStorage = router.ctx.storage.values;
  const hubStore = namespace.getByName(`dashboard-bot:${hubId}`);
  const originalHubStoreFetch = hubStore.fetch.bind(hubStore);
  let loseFirstEnqueueResponse = true;
  hubStore.fetch = async (request) => {
    const storedResponse = await originalHubStoreFetch(request);
    if (new URL(request.url).pathname === "/control/enqueue" && loseFirstEnqueueResponse) {
      loseFirstEnqueueResponse = false;
      throw new Error("simulated lost enqueue response");
    }
    return storedResponse;
  };
  response = await webhook({
    update_id: 2111,
    callback_query: {
      id: "callback-prepare-unconfirmed-bundle",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: 804, chat: { id: 42, type: "private" } },
      data: stuckCard.body.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  hubStore.fetch = originalHubStoreFetch;
  assert.equal(response.status, 503);
  const unconfirmedBundle = routerStorage.get(bundleKey);
  const preparedCommandId = unconfirmedBundle.submission.commands[0].command.id;
  const unconfirmedBundleId = unconfirmedBundle.id;
  assert.equal(routerStorage.get(bundleKey).submitting, false);
  assert.equal(unconfirmedBundle.submission.commands[0].telegramAttachments.length, 0);
  assert.equal(unconfirmedBundle.submission.commands[0].command.params.attachments.length, 1);
  assert.equal(routerStorage.get(bundleKey).submission.commands[0].command.id, preparedCommandId);

  response = await router.fetch(new Request("https://journal.internal/dashboard-bot/update", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      update_id: 211,
      message: {
        message_id: 9,
        date: 1_786_200_010,
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Алиса" },
        forward_origin: { type: "hidden_user", sender_user_name: "Заказчик" },
        text: "Пачка перед временным сбоем",
      },
    }),
  }));
  const duplicateWhileUnconfirmed = await response.json();
  assert.equal(duplicateWhileUnconfirmed.commands, undefined);
  assert.equal(routerStorage.get(bundleKey).submission.commands[0].command.id, preparedCommandId);

  const telegramCallCountBeforeRecovery = telegramCalls.length;
  const telegramGetFileCountBeforeRecovery = telegramCalls.filter((call) => call.method === "getFile").length;
  await webhook({
    update_id: 212,
    message: {
      message_id: 10,
      date: 1_786_200_011,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Другой автор" },
      text: "Не должно молча смешаться с зависшей пачкой",
    },
  });
  assert.ok(telegramCalls.slice(telegramCallCountBeforeRecovery).every((call) => (
    !/Новое сообщение не добавлено/u.test(String(call.body.text ?? ""))
  )));
  const nextBundle = routerStorage.get(bundleKey);
  assert.equal(nextBundle.items.length, 1);
  assert.equal(nextBundle.items[0].messageId, 10);
  assert.notEqual(nextBundle.id, unconfirmedBundleId);
  assert.equal(
    telegramCalls.filter((call) => call.method === "getFile").length,
    telegramGetFileCountBeforeRecovery,
  );

  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [retriedCommand] = (await response.json()).commands;
  assert.equal(retriedCommand.id, preparedCommandId);
  assert.equal(retriedCommand.params.attachments.length, 1);
  assert.match(retriedCommand.params.text, /Пачка перед временным сбоем/u);
  assert.doesNotMatch(retriedCommand.params.text, /Не должно молча смешаться/u);

  const nextCard = telegramCalls
    .filter((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text))
    .at(-1);
  response = await webhook({
    update_id: 213,
    callback_query: {
      id: "callback-send-next-bundle",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: 805, chat: { id: 42, type: "private" } },
      data: nextCard.body.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  assert.equal(response.status, 200);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [nextCommand] = (await response.json()).commands;
  assert.match(nextCommand.params.text, /Не должно молча смешаться с зависшей пачкой/u);
  assert.doesNotMatch(nextCommand.params.text, /Пачка перед временным сбоем/u);

  await webhook({
    update_id: 214,
    message: {
      message_id: 11,
      date: 1_786_200_012,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Заказчик" },
      text: "Пачка для отмены после сбоя",
    },
  });
  const cancelCard = telegramCalls
    .filter((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text))
    .at(-1);
  const stuckBundle = routerStorage.get(bundleKey);
  stuckBundle.submitting = true;
  stuckBundle.submissionStartedAt = 1;
  routerStorage.set(bundleKey, stuckBundle);
  await webhook({
    update_id: 215,
    callback_query: {
      id: "callback-cancel-stuck-bundle",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: 806, chat: { id: 42, type: "private" } },
      data: cancelCard.body.reply_markup.inline_keyboard[1][1].callback_data,
    },
  });
  assert.equal(routerStorage.has(bundleKey), false);
  assert.ok(telegramCalls.some((call) => (
    call.method === "editMessageText" && /Зависшая пачка закрыта/u.test(call.body.text)
  )));

  await webhook({
    update_id: 216,
    message: {
      message_id: 12,
      date: 1_786_200_013,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Заказчик" },
      text: "Новая пачка после отмены",
    },
  });
  const recoveredCard = telegramCalls
    .filter((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text))
    .at(-1);
  const recoveredBundle = routerStorage.get(bundleKey);
  recoveredBundle.submitting = true;
  recoveredBundle.submissionStartedAt = 1;
  routerStorage.set(bundleKey, recoveredBundle);
  response = await webhook({
    update_id: 217,
    callback_query: {
      id: "callback-retry-stuck-bundle",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: 807, chat: { id: 42, type: "private" } },
      data: recoveredCard.body.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(routerStorage.has(bundleKey), false);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [recoveredCommand] = (await response.json()).commands;
  assert.match(recoveredCommand.params.text, /Новая пачка после отмены/u);

  await webhook({
    update_id: 218,
    message: {
      message_id: 13,
      date: 1_786_200_014,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      forward_origin: { type: "hidden_user", sender_user_name: "Заказчик" },
      document: {
        file_id: "telegram-too-large",
        file_name: "meeting.mp4",
        mime_type: "video/mp4",
      },
      caption: "Видео и картинка относятся к одной задаче",
    },
  });
  await webhook({
    update_id: 219,
    message: {
      message_id: 14,
      date: 1_786_200_015,
      chat: { id: 42, type: "private" },
      from: { id: 42, first_name: "Алиса" },
      photo: [{ file_id: "valid-after-large" }, { file_id: "valid-after-large-best", file_size: 4 }],
      caption: "Где картинка?",
    },
  });
  const partialCard = telegramCalls
    .filter((call) => call.method === "sendMessage" && /Собираю пачку/u.test(call.body.text))
    .at(-1);
  response = await webhook({
    update_id: 220,
    callback_query: {
      id: "callback-send-partial-bundle",
      from: { id: 42, first_name: "Алиса" },
      message: { message_id: 808, chat: { id: 42, type: "private" } },
      data: partialCard.body.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  assert.equal(response.status, 200);
  response = await workerModule.default.fetch(signedServiceRequest(
    "https://hub.test/api/dashboard-bot/pull",
    { limit: 10, waitMs: 0 },
    hubSecret,
    { "X-Agent-Hub-Dashboard-Id": hubId },
  ), env);
  const [partialCommand] = (await response.json()).commands;
  assert.equal(partialCommand.params.attachments.length, 1);
  assert.match(partialCommand.params.attachments[0], /^remote-attachment:[0-9a-f-]{36}$/u);
  assert.equal(partialCommand.params.sourceDetails.attachmentCount, 2);
  assert.equal(partialCommand.params.sourceDetails.deliveredAttachmentCount, 1);
  assert.equal(partialCommand.params.sourceDetails.skippedAttachmentCount, 1);
  assert.equal(partialCommand.params.sourceDetails.skippedAttachments[0].name, "meeting.mp4");
  assert.match(partialCommand.params.text, /Изображение 2 приложено/u);
  assert.match(partialCommand.params.text, /meeting\.mp4[\s\S]*20 МБ/u);
  assert.ok(telegramCalls.some((call) => (
    call.method === "editMessageText"
      && /Пачка из 2 сообщений поставлена в очередь/u.test(call.body.text)
      && /Не приложено файлов: 1/u.test(call.body.text)
      && /meeting\.mp4/u.test(call.body.text)
  )));
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
      id: uploaded.id,
      userId: "42",
      commandId,
      mode: "manifest",
      page: 0,
    }, syncSecret),
    env,
  );
  const manifestBytes = Buffer.from(await response.arrayBuffer());
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.ok(manifestBytes.length < 25 * 1024);
  assert.deepEqual(manifest.chunks.map((chunk) => chunk.index), [0]);
  assert.equal(manifest.hash, createHash("sha256").update(png).digest("hex"));

  const pullChunk = () => workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/attachment/pull", {
      id: uploaded.id,
      userId: "42",
      commandId,
      mode: "chunk",
      index: 0,
    }, syncSecret),
    env,
  );
  const firstChunk = await pullChunk();
  const secondChunk = await pullChunk();
  assert.equal(firstChunk.headers.get("X-Agent-Hub-Chunk-Index"), "0");
  assert.deepEqual(Buffer.from(await firstChunk.arrayBuffer()), png);
  assert.deepEqual(Buffer.from(await secondChunk.arrayBuffer()), png);

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

test("Worker expires or atomically promotes exact legacy attachment manifests before mutation", async () => {
  const workerModule = await loadWorker();
  const storage = new RollbackFaultStorage();
  const store = new workerModule.JournalStore({ storage }, {});
  const botToken = "123456:test-token";
  const syncSecret = "l".repeat(64);
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
  const bodyHash = createHash("sha256").update(png).digest("hex");
  const authorization = `tma ${telegramInitData(botToken, 42)}`;
  const currentKey = (id) => `control:attachment-manifest:${id}`;
  const legacyKey = (id) => `control:attachment:${id}`;
  const chunkKey = (id) => `control:attachment-chunk:${id}:0`;
  const seedLegacy = async ({
    id,
    expiresAt,
    userId = "42",
    viewOnly = false,
    commandIds = [],
  }) => {
    const manifest = {
      id,
      userId,
      contentType: "image/png",
      name: "image.png",
      bodyHash,
      size: png.length,
      chunkCount: 1,
      commandIds,
      ...(viewOnly ? { viewOnly: true } : {}),
      createdAt: Date.now() - 60_000,
      expiresAt,
    };
    await storage.put({
      [legacyKey(id)]: manifest,
      [chunkKey(id)]: png,
    });
    return manifest;
  };
  const upload = (id) => workerModule.default.fetch(new Request("https://hub.test/api/attachment", {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "image/png",
      "X-Agent-Hub-File-Name": encodeURIComponent("image.png"),
      "X-Agent-Hub-Attachment-Id": id,
    },
    body: png,
  }), env);
  const viewUpload = (id) => workerModule.default.fetch(signedBinaryServiceRequest(
    "https://hub.test/api/control/attachment/view/push",
    png,
    syncSecret,
    {
      "Content-Type": "image/png",
      "X-Agent-Hub-User-Id": "42",
      "X-Agent-Hub-Attachment-Id": id,
      "X-Agent-Hub-Attachment-Hash": bodyHash,
      "X-Agent-Hub-File-Name": encodeURIComponent("image.png"),
    },
  ), env);
  const enqueue = (id, commandId) => workerModule.default.fetch(new Request("https://hub.test/api/control", {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({
      id: commandId,
      action: "send-message",
      params: { text: "Legacy", attachments: [`remote-attachment:${id}`] },
    }),
  }), env);

  const expiredUploadId = "018f6c86-3f34-7a31-8f27-16f5b96cce51";
  await seedLegacy({ id: expiredUploadId, expiresAt: Date.now() - 1 });
  let response = await upload(expiredUploadId);
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.ok(uploaded.expiresAt > Date.now());
  assert.equal(await storage.get(legacyKey(expiredUploadId)), undefined);
  assert.ok(await storage.get(currentKey(expiredUploadId)));

  const expiredViewId = "018f6c86-3f34-7a31-8f27-16f5b96cce52";
  await seedLegacy({ id: expiredViewId, expiresAt: Date.now() - 1, viewOnly: true });
  response = await viewUpload(expiredViewId);
  assert.equal(response.status, 201);
  const uploadedView = await response.json();
  assert.ok(uploadedView.expiresAt > Date.now());
  assert.equal(await storage.get(legacyKey(expiredViewId)), undefined);
  assert.ok(await storage.get(currentKey(expiredViewId)));

  const liveUploadId = "018f6c86-3f34-7a31-8f27-16f5b96cce58";
  await seedLegacy({ id: liveUploadId, expiresAt: Date.now() + 60_000 });
  response = await upload(liveUploadId);
  assert.equal(response.status, 200);
  assert.equal(await storage.get(legacyKey(liveUploadId)), undefined);
  assert.ok(await storage.get(currentKey(liveUploadId)));

  const liveViewId = "018f6c86-3f34-7a31-8f27-16f5b96cce59";
  await seedLegacy({ id: liveViewId, expiresAt: Date.now() + 60_000, viewOnly: true });
  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${liveViewId}`,
    { headers: { Authorization: authorization } },
  ), env);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.ok(await storage.get(legacyKey(liveViewId)));
  assert.equal(await storage.get(currentKey(liveViewId)), undefined);
  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${liveViewId}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 84)}` } },
  ), env);
  assert.equal(response.status, 404);
  assert.ok(await storage.get(legacyKey(liveViewId)));
  response = await viewUpload(liveViewId);
  assert.equal(response.status, 200);
  assert.equal(await storage.get(legacyKey(liveViewId)), undefined);
  assert.ok(await storage.get(currentKey(liveViewId)));

  const expiredEnqueueId = "018f6c86-3f34-7a31-8f27-16f5b96cce53";
  const expiredCommandId = "018f6c86-3f34-7a31-8f27-16f5b96cce63";
  await seedLegacy({ id: expiredEnqueueId, expiresAt: Date.now() - 1 });
  response = await enqueue(expiredEnqueueId, expiredCommandId);
  assert.equal(response.status, 404);
  assert.equal(await storage.get(legacyKey(expiredEnqueueId)), undefined);
  assert.equal(await storage.get(currentKey(expiredEnqueueId)), undefined);
  assert.equal(await storage.get(chunkKey(expiredEnqueueId)), undefined);
  assert.equal(await storage.get(`control:command:${expiredCommandId}`), undefined);

  const liveId = "018f6c86-3f34-7a31-8f27-16f5b96cce54";
  const liveCommandId = "018f6c86-3f34-7a31-8f27-16f5b96cce64";
  await seedLegacy({ id: liveId, expiresAt: Date.now() + 60_000 });
  response = await enqueue(liveId, liveCommandId);
  assert.equal(response.status, 202);
  assert.equal(await storage.get(legacyKey(liveId)), undefined);
  let promoted = await storage.get(currentKey(liveId));
  assert.deepEqual(promoted.commandIds, [liveCommandId]);
  response = await enqueue(liveId, liveCommandId);
  assert.equal(response.status, 200);
  promoted = await storage.get(currentKey(liveId));
  assert.deepEqual(promoted.commandIds, [liveCommandId]);

  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/pull", { limit: 10 }, syncSecret),
    env,
  );
  assert.ok((await response.json()).commands.some(({ id }) => id === liveCommandId));
  const retainedCommandId = "018f6c86-3f34-7a31-8f27-16f5b96cce65";
  promoted = { ...await storage.get(currentKey(liveId)), commandIds: [liveCommandId, retainedCommandId] };
  await storage.put(legacyKey(liveId), promoted);
  await storage.delete(currentKey(liveId));
  response = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/control/result", {
      id: liveCommandId,
      userId: "42",
      ok: true,
      result: { accepted: true },
    }, syncSecret),
    env,
  );
  assert.equal(response.status, 200);
  assert.equal(await storage.get(legacyKey(liveId)), undefined);
  assert.deepEqual((await storage.get(currentKey(liveId))).commandIds, [retainedCommandId]);

  const otherOwnerId = "018f6c86-3f34-7a31-8f27-16f5b96cce55";
  await seedLegacy({ id: otherOwnerId, expiresAt: Date.now() + 60_000, userId: "84" });
  response = await enqueue(otherOwnerId, "018f6c86-3f34-7a31-8f27-16f5b96cce66");
  assert.equal(response.status, 404);
  assert.ok(await storage.get(legacyKey(otherOwnerId)));
  assert.equal(await storage.get(currentKey(otherOwnerId)), undefined);

  const mixedId = "018f6c86-3f34-7a31-8f27-16f5b96cce56";
  const mixedLegacy = await seedLegacy({ id: mixedId, expiresAt: Date.now() + 60_000 });
  await storage.put(currentKey(mixedId), { ...mixedLegacy });
  response = await upload(mixedId);
  assert.equal(response.status, 409);
  response = await enqueue(mixedId, "018f6c86-3f34-7a31-8f27-16f5b96cce67");
  assert.equal(response.status, 409);
  assert.ok(await storage.get(legacyKey(mixedId)));
  assert.ok(await storage.get(currentKey(mixedId)));

  const rollbackId = "018f6c86-3f34-7a31-8f27-16f5b96cce57";
  const rollbackCommandId = "018f6c86-3f34-7a31-8f27-16f5b96cce68";
  await seedLegacy({ id: rollbackId, expiresAt: Date.now() + 60_000 });
  storage.failDeleteKey = legacyKey(rollbackId);
  response = await enqueue(rollbackId, rollbackCommandId);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /promotion failure/u);
  assert.ok(await storage.get(legacyKey(rollbackId)));
  assert.equal(await storage.get(currentKey(rollbackId)), undefined);
  assert.equal(await storage.get(`control:command:${rollbackCommandId}`), undefined);
  response = await enqueue(rollbackId, rollbackCommandId);
  assert.equal(response.status, 202);
  assert.equal(await storage.get(legacyKey(rollbackId)), undefined);
  assert.ok(await storage.get(currentKey(rollbackId)));
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
  for (let index = 0; index < 512; index += 1) {
    await storage.put(`control:attachment-chunk:legacy-${index}:0`, new Uint8Array(1_024));
  }
  storage.listCalls = [];
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
  assert.ok(storage.listCalls.some(({ prefix }) => prefix === "control:attachment-manifest:"));
  assert.equal(storage.listCalls.some(({ prefix }) => prefix === "control:attachment:"), false);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${id}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 42)}` } },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("Content-Length"), String(png.length));
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${id}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 42)}` } },
  ), env);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${id}`,
  ), env);
  assert.equal(response.status, 401);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${id}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 42)}forged` } },
  ), env);
  assert.equal(response.status, 401);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/attachment/view?id=018f6c86-3f34-7a31-8f27-16f5b96cce42",
    { headers: { Authorization: `tma ${telegramInitData(botToken, 42)}` } },
  ), env);
  assert.equal(response.status, 404);

  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${id}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 84)}` } },
  ), env);
  assert.equal(response.status, 404);

  const manifestKey = `control:attachment-manifest:${id}`;
  const expired = await storage.get(manifestKey);
  expired.expiresAt = Date.now() - 1;
  await storage.put(manifestKey, expired);
  response = await workerModule.default.fetch(new Request(
    `https://hub.test/api/attachment/view?id=${id}`,
    { headers: { Authorization: `tma ${telegramInitData(botToken, 42)}` } },
  ), env);
  assert.equal(response.status, 404);
  assert.equal(await storage.get(manifestKey), undefined);

  response = await workerModule.default.fetch(new Request(
    "https://hub.test/api/control/attachment/view/push",
    { method: "POST", headers: { "Content-Type": "image/png" }, body: png },
  ), env);
  assert.equal(response.status, 401);
});

async function pairedWorkerDevice(workerModule, env, syncSecret) {
  const pairingResponse = await workerModule.default.fetch(
    signedServiceRequest("https://hub.test/api/device/pairing", {
      userId: "42",
      code: "ABCDE-FGHIJ-KLMNO-PQRST",
    }, syncSecret),
    env,
  );
  const pairing = await pairingResponse.json();
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const response = await workerModule.default.fetch(new Request("https://hub.test/api/device/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: pairing.code,
      name: "Pixel test",
      platform: "Android test",
      publicKey: base64Url(publicKey.export({ type: "spki", format: "der" })),
    }),
  }), env);
  return { privateKey, device: (await response.json()).device };
}

function workerEnvironment(store, syncSecret) {
  return {
    TELEGRAM_BOT_TOKEN: "123456:test-token",
    ALLOWED_USER_IDS: "42",
    SYNC_SECRET: syncSecret,
    JOURNAL: { getByName: () => store },
    ASSETS: { fetch: async () => new Response("asset") },
  };
}

test("Worker refuses a device signature made for another endpoint", async () => {
  const workerModule = await loadWorker();
  const syncSecret = "d".repeat(64);
  const env = workerEnvironment(new workerModule.JournalStore({ storage: new MemoryStorage() }, {}), syncSecret);
  const { privateKey, device } = await pairedWorkerDevice(workerModule, env, syncSecret);

  const challengeResponse = await workerModule.default.fetch(new Request("https://hub.test/api/device/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // A relaying verifier cannot pick the origin: the Worker overwrites it with
    // the one it actually served.
    body: JSON.stringify({ deviceId: device.id, origin: "https://relay.example" }),
  }), env);
  const challenge = await challengeResponse.json();
  const sessionFor = (origin) => workerModule.default.fetch(new Request("https://hub.test/api/device/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      deviceId: device.id,
      challengeId: challenge.challengeId,
      signature: base64Url(sign("sha256", Buffer.from([
        "agent-hub-device-session-v2",
        origin,
        device.id,
        challenge.challengeId,
        challenge.challenge,
      ].join("\n")), { key: privateKey, dsaEncoding: "ieee-p1363" })),
    }),
  }), env);

  assert.equal((await sessionFor("https://relay.example")).status, 401);
});

test("Worker bounds unauthenticated device authentication attempts", async () => {
  const workerModule = await loadWorker();
  const syncSecret = "d".repeat(64);
  const env = workerEnvironment(new workerModule.JournalStore({ storage: new MemoryStorage() }, {}), syncSecret);
  const attempt = () => workerModule.default.fetch(new Request("https://hub.test/api/device/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
    body: JSON.stringify({ deviceId: "018f6c86-3f34-7a31-8f27-16f5b96cce10" }),
  }), env);

  for (let index = 0; index < 30; index += 1) assert.notEqual((await attempt()).status, 429);
  const limited = await attempt();
  assert.equal(limited.status, 429);
  assert.match(String(limited.headers.get("Retry-After")), /^\d+$/u);

  // A different client keeps its own budget.
  const other = await workerModule.default.fetch(new Request("https://hub.test/api/device/challenge", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.8" },
    body: JSON.stringify({ deviceId: "018f6c86-3f34-7a31-8f27-16f5b96cce10" }),
  }), env);
  assert.notEqual(other.status, 429);
});

test("Worker relay validates device enrollment as a control action", async () => {
  const workerModule = await loadWorker();
  assert.equal(
    workerModule.validateControlCommand({
      id: "018f6c86-3f34-7a31-8f27-16f5b96cce11",
      action: "create-device-pairing",
      params: {},
    }).action,
    "create-device-pairing",
  );
  assert.equal(
    workerModule.validateControlCommand({
      id: "018f6c86-3f34-7a31-8f27-16f5b96cce11",
      action: "revoke-device",
      params: {},
    }).action,
    "revoke-device",
  );
});

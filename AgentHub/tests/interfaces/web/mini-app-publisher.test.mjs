import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compressedJournalChunks,
  MiniAppPublisher,
  signMiniAppControlRequest,
  signMiniAppSyncChunk,
} from "../../../src/interfaces/web/mini-app-publisher.mjs";
import { createDesktopControlRouter } from "../../../src/interfaces/desktop/desktop-control-router.mjs";
import { REMOTE_CONTROL_WAKE_PROTOCOL } from "../../../src/interfaces/web/remote-control-wake-channel.mjs";

function memoryJournal(payload = {
  html: "<p>Журнал</p>",
  days: {},
  turns: {},
  updatedAt: "2026-07-28T12:00:00.000Z",
  version: "test-version",
}) {
  const listeners = new Set();
  return {
    snapshot: async () => structuredClone(payload),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {},
  };
}

test("Mini App publisher signs and sends the current journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publisher-"));
  const secretFile = path.join(root, "sync.secret");
  const secret = "a".repeat(64);
  await writeFile(secretFile, secret);
  const requests = [];
  const published = [];
  const publisher = new MiniAppPublisher({
    journalDatabase: memoryJournal({
      html: "<details open><summary>28.07.2026</summary></details>",
      days: {},
      turns: {},
      updatedAt: "2026-07-28T12:00:00.000Z",
      version: "test-version",
    }),
    dataDirectory: root,
    publicUrl: "https://hub.example.test/",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    onPublished: async (url) => published.push(url),
  });
  try {
    assert.equal(await publisher.sync(), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://hub.example.test/api/sync/chunk");
    const body = requests[0].options.body;
    const headers = requests[0].options.headers;
    const timestamp = Number(headers["X-Agent-Hub-Timestamp"]);
    assert.equal(headers["X-Agent-Hub-Encoding"], "gzip");
    assert.deepEqual(headers["X-Agent-Hub-Signature"], signMiniAppSyncChunk({
      body,
      secret,
      syncId: headers["X-Agent-Hub-Sync-Id"],
      index: Number(headers["X-Agent-Hub-Chunk-Index"]),
      count: Number(headers["X-Agent-Hub-Chunk-Count"]),
      encoding: headers["X-Agent-Hub-Encoding"],
      version: headers["X-Agent-Hub-Journal-Version"],
      updatedAt: headers["X-Agent-Hub-Journal-Updated-At"],
      timestamp,
    }).signature);
    const payload = JSON.parse(gunzipSync(body).toString("utf8"));
    assert.match(payload.html, /28\.07\.2026/u);
    assert.equal(published.length, 1);
    await publisher.sync();
    assert.equal(published.length, 1);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher aborts active journal and snapshot uploads during close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publisher-close-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "c".repeat(64));
  const started = [];
  const aborted = [];
  const publisher = new MiniAppPublisher({
    journalDatabase: memoryJournal(),
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    snapshotUserIds: ["95281881"],
    controlHandler: async () => ({ version: "snapshot-1" }),
    fetchImpl: (url, options) => new Promise((resolve, reject) => {
      started.push(url);
      const signal = options.signal;
      const stop = () => {
        aborted.push(url);
        reject(signal.reason ?? new Error("aborted"));
      };
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }),
  });
  try {
    const journalSync = publisher.sync().catch((error) => error);
    const snapshotSync = publisher.syncSnapshots().catch((error) => error);
    while (started.length < 2) await new Promise((resolve) => setImmediate(resolve));
    await publisher.close();
    await Promise.all([journalSync, snapshotSync]);
    assert.deepEqual(new Set(aborted), new Set([
      "https://hub.example.test/api/sync/chunk",
      "https://hub.example.test/api/snapshot/push",
    ]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher skips an unchanged journal before rebuilding its snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publisher-unchanged-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "u".repeat(64));
  let current = {
    html: "<p>Первая версия</p>",
    days: {},
    turns: {},
    updatedAt: "2026-08-14T12:00:00.000Z",
    version: "version-1",
    revision: 1,
  };
  let snapshotCalls = 0;
  const requests = [];
  const publisher = new MiniAppPublisher({
    journalDatabase: {
      payload: async () => ({
        updatedAt: current.updatedAt,
        version: current.version,
        revision: current.revision,
      }),
      snapshot: async () => {
        snapshotCalls += 1;
        return structuredClone(current);
      },
      subscribe: () => () => {},
      close() {},
    },
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ ok: true });
    },
  });
  try {
    assert.equal(await publisher.sync(), true);
    assert.equal(snapshotCalls, 1);
    assert.equal(requests.length, 1);
    assert.equal(await publisher.sync(), true);
    assert.equal(snapshotCalls, 1);
    assert.equal(requests.length, 1);

    current = {
      ...current,
      html: "<p>Вторая версия</p>",
      updatedAt: "2026-08-14T12:01:00.000Z",
      version: "version-2",
      revision: 2,
    };
    assert.equal(await publisher.sync(), true);
    assert.equal(snapshotCalls, 2);
    assert.equal(requests.length, 2);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher retries the same journal after an interrupted upload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publisher-retry-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "r".repeat(64));
  const payload = {
    html: "<p>Повтор после сбоя</p>",
    days: {},
    turns: {},
    updatedAt: "2026-08-14T12:00:00.000Z",
    version: "retry-version",
    revision: 7,
  };
  let requests = 0;
  let fail = true;
  const publisher = new MiniAppPublisher({
    journalDatabase: {
      payload: async () => structuredClone(payload),
      snapshot: async () => structuredClone(payload),
      subscribe: () => () => {},
      close() {},
    },
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    retrySeconds: 60,
    fetchImpl: async () => {
      requests += 1;
      if (fail) return Response.json({ error: "offline" }, { status: 503 });
      return Response.json({ ok: true });
    },
  });
  try {
    await assert.rejects(() => publisher.sync(), /HTTP 503/u);
    fail = false;
    assert.equal(await publisher.sync(), true);
    assert.equal(requests, 2);
    assert.equal(await publisher.sync(), true);
    assert.equal(requests, 2);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher splits a large compressed journal without losing data", async () => {
  const payload = {
    html: Array.from({ length: 10_000 }, (_, index) => `${index}:${"история".repeat(12)}`).join("\n"),
    updatedAt: "2026-07-29T08:00:00.000Z",
    version: "large",
  };
  const { syncId, chunks } = await compressedJournalChunks(payload, {
    chunkBytes: 4_096,
    syncId: "fixed-sync",
  });
  assert.equal(syncId, "fixed-sync");
  assert.ok(chunks.length > 1);
  assert.deepEqual(
    JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")),
    payload,
  );
});

test("Mini App publisher reuses the sync id for an identical journal retry", async () => {
  const payload = {
    html: "<p>Один и тот же снимок</p>",
    updatedAt: "2026-07-30T08:00:00.000Z",
    version: "same-version",
  };
  const first = await compressedJournalChunks(payload, { chunkBytes: 16 });
  const retry = await compressedJournalChunks(payload, { chunkBytes: 16 });
  const changed = await compressedJournalChunks({ ...payload, html: "<p>Другой снимок</p>" }, { chunkBytes: 16 });

  assert.match(first.syncId, /^sync-[a-f0-9]{64}$/u);
  assert.equal(retry.syncId, first.syncId);
  assert.deepEqual(retry.chunks, first.chunks);
  assert.notEqual(changed.syncId, first.syncId);
});

test("Mini App publisher pushes a client snapshot only when its version changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-snapshot-publisher-"));
  const secretFile = path.join(root, "sync.secret");
  const secret = "q".repeat(64);
  await writeFile(secretFile, secret);
  const requests = [];
  const versions = [];
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    snapshotUserIds: ["42"],
    controlHandler: async ({ action, params, context }) => {
      assert.equal(action, "snapshot");
      assert.equal(context.userId, "42");
      versions.push(params.knownVersion);
      return params.knownVersion === "snapshot-v1"
        ? { notModified: true, version: "snapshot-v1" }
        : { apiVersion: 3, tasks: [], version: "snapshot-v1" };
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ ok: true });
    },
  });
  try {
    assert.equal(await publisher.syncSnapshots(), true);
    assert.equal(await publisher.syncSnapshots(), false);
    assert.deepEqual(versions, ["", "snapshot-v1"]);
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, "/api/snapshot/push");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      userId: "42",
      snapshot: { apiVersion: 3, tasks: [], version: "snapshot-v1" },
    });
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher manages trusted devices through signed service requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-publisher-"));
  const secretFile = path.join(root, "sync.secret");
  const secret = "v".repeat(64);
  await writeFile(secretFile, secret);
  const requests = [];
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/pairing")) return Response.json({ code: "AAAAA-BBBBB-CCCCC-DDDDD", expiresAt: 1 });
      if (url.endsWith("/list")) return Response.json({ devices: [{ id: "device" }] });
      return Response.json({ device: { id: "device", revokedAt: 1 } });
    },
  });
  try {
    assert.equal((await publisher.createDevicePairing("42", {
      code: "AAAAA-BBBBB-CCCCC-DDDDD",
    })).code, "AAAAA-BBBBB-CCCCC-DDDDD");
    assert.equal((await publisher.trustedDevices("42")).devices.length, 1);
    assert.equal((await publisher.revokeDevice("42", "device")).device.revokedAt, 1);
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
      "/api/device/pairing",
      "/api/device/list",
      "/api/device/revoke",
    ]);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      userId: "42",
      code: "AAAAA-BBBBB-CCCCC-DDDDD",
    });
    for (const request of requests) {
      const pathname = new URL(request.url).pathname;
      const timestamp = Number(request.options.headers["X-Agent-Hub-Timestamp"]);
      assert.equal(
        request.options.headers["X-Agent-Hub-Signature"],
        signMiniAppControlRequest({
          body: request.options.body,
          secret,
          pathname,
          timestamp,
        }).signature,
      );
    }
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher proxies direct device authentication to the Worker registry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-proxy-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "w".repeat(64));
  const requests = [];
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json(new URL(url).pathname.endsWith("/resolve")
        ? { id: "42", deviceId: "device" }
        : { ok: true });
    },
  });
  try {
    await publisher.pairDevice({ code: "code" });
    await publisher.createDeviceChallenge({ deviceId: "device" });
    await publisher.createDeviceSession({ deviceId: "device" });
    await publisher.resolveDeviceSession("token");
    await publisher.importDevices("42", []);
    await publisher.deleteDevices("42", ["device"]);
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
      "/api/device/pair",
      "/api/device/challenge",
      "/api/device/session",
      "/api/device/session/resolve",
      "/api/device/import",
      "/api/device/delete",
    ]);
    assert.equal(requests[0].options.headers["X-Agent-Hub-Signature"], undefined);
    assert.match(String(requests[3].options.headers["X-Agent-Hub-Signature"]), /^[a-f0-9]{64}$/u);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher exposes a local image through a signed temporary view", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-view-publisher-"));
  const attachmentDirectory = path.join(root, "attachments");
  const secretFile = path.join(root, "sync.secret");
  const imageFile = path.join(attachmentDirectory, "message.png");
  const secret = "w".repeat(64);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  await mkdir(attachmentDirectory, { recursive: true });
  await writeFile(secretFile, secret);
  await writeFile(imageFile, png);
  let request;
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    attachmentDirectory,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({ ok: true, expiresAt: 123 }, { status: 201 });
    },
  });
  try {
    const result = await publisher.publishAttachmentView("42", imageFile);
    assert.equal(result.name, "message.png");
    assert.equal(result.type, "image/png");
    assert.equal(result.expiresAt, 123);
    assert.equal(new URL(request.url).pathname, "/api/control/attachment/view/push");
    assert.deepEqual(Buffer.from(request.options.body), png);
    assert.equal(request.options.headers["X-Agent-Hub-User-Id"], "42");
    assert.equal(request.options.headers["X-Agent-Hub-Attachment-Hash"], createHash("sha256").update(png).digest("hex"));
    assert.equal(
      request.options.headers["X-Agent-Hub-Signature"],
      signMiniAppControlRequest({
        body: png,
        secret,
        pathname: "/api/control/attachment/view/push",
        timestamp: Number(request.options.headers["X-Agent-Hub-Timestamp"]),
      }).signature,
    );
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher polls signed controls and posts their result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-publisher-"));
  const secretFile = path.join(root, "sync.secret");
  const secret = "b".repeat(64);
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce10";
  await writeFile(secretFile, secret);
  const requests = [];
  const handled = [];
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/api/control/pull")) {
        return Response.json({
          commands: [{
            id,
            userId: "42",
            source: "trusted-device",
            action: "message-pin-set",
            params: { streamId: "stream-1", messageKey: "message:v1:answer", pinned: false },
          }],
        });
      }
      return Response.json({ id, status: "completed" });
    },
    controlHandler: async (request) => {
      handled.push(request);
      return { opened: true };
    },
  });
  try {
    assert.equal(await publisher.pollControl(), 1);
    assert.equal(handled.length, 1);
    assert.equal(handled[0].context.source, "trusted-device");
    assert.equal(handled[0].context.transport, "worker");
    assert.equal(handled[0].context.userId, "42");
    assert.equal(handled[0].action, "message-pin-set");
    assert.equal(requests.length, 2);
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      limit: 10,
      waitMs: 0,
      transport: REMOTE_CONTROL_WAKE_PROTOCOL,
    });
    for (const request of requests) {
      const pathname = new URL(request.url).pathname;
      const timestamp = Number(request.options.headers["X-Agent-Hub-Timestamp"]);
      assert.equal(
        request.options.headers["X-Agent-Hub-Signature"],
        signMiniAppControlRequest({
          body: request.options.body,
          secret,
          pathname,
          timestamp,
        }).signature,
      );
    }
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      id,
      userId: "42",
      ok: true,
      result: { opened: true },
    });
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher uses immediate drain without an empty-loop retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-short-poll-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "l".repeat(64));
  let pullCount = 0;
  let pullBody = null;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const publisher = new MiniAppPublisher({
    journalDatabase: memoryJournal(),
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      if (!url.endsWith("/api/control/pull")) return Response.json({ ok: true });
      pullCount += 1;
      pullBody = JSON.parse(options.body);
      markStarted();
      return Response.json({ commands: [] });
    },
    webSocketFactory: () => ({ addEventListener() {}, close() {} }),
    controlHandler: async () => ({ ok: true }),
  });
  try {
    await publisher.start();
    await started;
    await publisher.close();
    assert.equal(pullCount, 1);
    assert.deepEqual(pullBody, {
      limit: 10,
      waitMs: 0,
      transport: REMOTE_CONTROL_WAKE_PROTOCOL,
    });
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher preserves retry guidance from a capacity response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-capacity-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "c".repeat(64));
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async () => Response.json({
      error: "Dashboard bot storage is temporarily unavailable",
      code: "dashboard_bot_storage_unavailable",
    }, { status: 503, headers: { "Retry-After": "60" } }),
    controlHandler: async () => ({ ok: true }),
  });
  try {
    await assert.rejects(publisher.pollControl(), (error) => {
      assert.equal(error.status, 503);
      assert.equal(error.code, "dashboard_bot_storage_unavailable");
      assert.equal(error.retryAfterMs, 60_000);
      return true;
    });
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher relays context compaction allowed by the Worker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-compact-"));
  const secretFile = path.join(root, "sync.secret");
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce12";
  await writeFile(secretFile, "f".repeat(64));
  const handled = [];
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url) => {
      if (url.endsWith("/api/control/pull")) {
        return Response.json({
          commands: [{
            id,
            userId: "42",
            action: "compact-context",
            params: { provider: "codex", threadId: "thread-1" },
          }],
        });
      }
      return Response.json({ ok: true });
    },
    controlHandler: async (request) => {
      handled.push(request);
      return { accepted: true };
    },
  });
  try {
    assert.equal(await publisher.pollControl(), 1);
    assert.equal(handled.length, 1);
    assert.equal(handled[0].action, "compact-context");
    assert.deepEqual(handled[0].params, { provider: "codex", threadId: "thread-1" });
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher rejects remote attachments without invoking the handler", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-attachment-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "c".repeat(64));
  let handled = false;
  let postedResult;
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/control/pull")) {
        return Response.json({
          commands: [{
            id: "018f6c86-3f34-7a31-8f27-16f5b96cce11",
            userId: "42",
            action: "send-message",
            params: { text: "test", attachments: ["remote.png"] },
          }],
        });
      }
      postedResult = JSON.parse(options.body);
      return Response.json({ ok: true });
    },
    controlHandler: async () => {
      handled = true;
    },
  });
  try {
    assert.equal(await publisher.pollControl(), 1);
    assert.equal(handled, false);
    assert.equal(postedResult.ok, false);
    assert.match(postedResult.error, /invalid remote attachments/iu);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher materializes a signed remote Task attachment inside the allowed attachment directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-image-"));
  const secretFile = path.join(root, "sync.secret");
  const attachmentDirectory = path.join(root, "runtime", "attachments");
  const secret = "e".repeat(64);
  const commandId = "018f6c86-3f34-7a31-8f27-16f5b96cce40";
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cce41";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const bodyHash = createHash("sha256").update(png).digest("hex");
  await writeFile(secretFile, secret);
  const handled = [];
  const requests = [];
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    attachmentDirectory,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/api/control/pull")) {
        return Response.json({
          commands: [{
            id: commandId,
            userId: "42",
            action: "board-task-attachment-add",
            params: {
              id: "board-1",
              attachments: [`remote-attachment:${attachmentId}`],
            },
          }],
        });
      }
      if (url.endsWith("/api/control/attachment/pull")) {
        assert.deepEqual(JSON.parse(options.body), {
          id: attachmentId,
          userId: "42",
          commandId,
          mode: "manifest",
          page: 0,
        });
        return new Response(png, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(png.length),
            "X-Agent-Hub-Attachment-Hash": bodyHash,
          },
        });
      }
      return Response.json({ ok: true });
    },
    controlHandler: async (request) => {
      handled.push(request);
      return { accepted: true };
    },
  });
  try {
    assert.equal(await publisher.pollControl(), 1);
    assert.equal(handled.length, 1);
    assert.equal(handled[0].action, "board-task-attachment-add");
    assert.equal(handled[0].params.id, "board-1");
    const [localPath] = handled[0].params.attachments;
    assert.equal(path.dirname(localPath), attachmentDirectory);
    assert.match(path.basename(localPath), new RegExp(`^${commandId}-${attachmentId}--.+\\.png$`, "u"));
    assert.deepEqual(await readFile(localPath), png);
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
      id: commandId,
      userId: "42",
      ok: true,
      result: { accepted: true },
    });
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher executes every claimed command when result delivery is temporarily unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-retry-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "d".repeat(64));
  const commands = [1, 2].map((suffix) => ({
    id: `018f6c86-3f34-7a31-8f27-16f5b96cce2${suffix}`,
    userId: "42",
    action: "status-details",
    params: {},
  }));
  let pullCount = 0;
  let rejectResults = true;
  const delivered = [];
  const handled = [];
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/control/pull")) {
        pullCount += 1;
        return Response.json({ commands: pullCount === 1 ? commands : [] });
      }
      if (rejectResults) return Response.json({ error: "offline" }, { status: 503 });
      delivered.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    controlHandler: async ({ context }) => {
      handled.push(context.commandId);
      return { ok: true };
    },
  });
  try {
    await assert.rejects(() => publisher.pollControl(), /HTTP 503/u);
    assert.deepEqual(handled.toSorted(), commands.map((command) => command.id).toSorted());
    rejectResults = false;
    assert.equal(await publisher.pollControl(), 0);
    assert.deepEqual(
      delivered.map((item) => item.id).toSorted(),
      commands.map((command) => command.id).toSorted(),
    );
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher does not let a slow control block a message command", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-concurrent-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "p".repeat(64));
  const commands = [
    {
      id: "018f6c86-3f34-7a31-8f27-16f5b96cce31",
      userId: "42",
      action: "open-turn",
      params: { provider: "codex", threadId: "thread", turnId: "turn" },
    },
    {
      id: "018f6c86-3f34-7a31-8f27-16f5b96cce32",
      userId: "42",
      action: "send-message",
      params: { provider: "codex", threadId: "thread", text: "now" },
    },
  ];
  let releaseSlow;
  const slow = new Promise((resolve) => { releaseSlow = resolve; });
  let markMessageHandled;
  const messageHandled = new Promise((resolve) => { markMessageHandled = resolve; });
  const publisher = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url) => url.endsWith("/api/control/pull")
      ? Response.json({ commands })
      : Response.json({ ok: true }),
    controlHandler: async ({ action }) => {
      if (action === "open-turn") await slow;
      else markMessageHandled();
      return { accepted: action === "send-message" };
    },
  });
  try {
    const polling = publisher.pollControl();
    await messageHandled;
    releaseSlow();
    assert.equal(await polling, 2);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher reconciles a redelivered command after a crash without repeating its effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-crash-"));
  const secretFile = path.join(root, "sync.secret");
  const receiptFile = path.join(root, "control-receipts.json");
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce61";
  const command = { id, userId: "42", action: "new-task", params: { provider: "codex" } };
  await writeFile(secretFile, "e".repeat(64));
  let sideEffects = 0;
  let effectStarted;
  const started = new Promise((resolve) => { effectStarted = resolve; });
  const fetchImpl = async (url, options) => {
    if (url.endsWith("/api/control/pull")) return Response.json({ commands: [command] });
    return Response.json({ received: JSON.parse(options.body) });
  };
  const first = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    controlReceiptFile: receiptFile,
    fetchImpl,
    controlHandler: async () => {
      sideEffects += 1;
      effectStarted();
      await new Promise(() => {});
    },
  });
  void first.pollControl();
  await started;
  // The hanging handler models a process that crashed. Make the owner in the
  // on-disk receipt correspond to that dead process before reopening it here.
  const receipts = JSON.parse(await readFile(receiptFile, "utf8"));
  receipts.records[0].effectOwner.pid = 999_999;
  await writeFile(receiptFile, `${JSON.stringify(receipts)}\n`);
  const delivered = [];
  const restarted = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    controlReceiptFile: receiptFile,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/control/pull")) return Response.json({ commands: [command] });
      delivered.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    controlHandler: async () => {
      sideEffects += 1;
      return { duplicated: true };
    },
    controlReconciler: async () => ({ resolved: true, result: { taskId: "existing-task" } }),
  });
  try {
    assert.equal(await restarted.pollControl(), 1);
    assert.equal(sideEffects, 1);
    assert.deepEqual(delivered, [{ id, userId: "42", ok: true, result: { taskId: "existing-task" } }]);
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher retains a delivered-result outbox across a crash before receipt cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-result-outbox-crash-"));
  const secretFile = path.join(root, "sync.secret");
  const receiptFile = path.join(root, "control-receipts.json");
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce63";
  const command = { id, userId: "42", action: "new-task", params: { provider: "codex" } };
  await writeFile(secretFile, "g".repeat(64));
  let effects = 0;
  const first = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    controlReceiptFile: receiptFile,
    fetchImpl: async (url) => url.endsWith("/api/control/pull")
      ? Response.json({ commands: [command] })
      : Response.json({ ok: true }),
    controlHandler: async () => ({ taskId: `task-${++effects}` }),
    // This is the state left by a process crash after the Worker accepted its
    // result but before the two local receipt journals were retired.
    onControlResultDelivered: async () => {
      throw new Error("simulated crash before receipt cleanup");
    },
  });
  await assert.rejects(() => first.pollControl(), /simulated crash before receipt cleanup/u);
  const delivered = [];
  const restarted = new MiniAppPublisher({
    dataDirectory: root,
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    controlReceiptFile: receiptFile,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/control/pull")) return Response.json({ commands: [] });
      delivered.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    controlHandler: async () => ({ taskId: `duplicate-${++effects}` }),
  });
  try {
    assert.equal(await restarted.pollControl(), 0);
    assert.equal(effects, 1);
    assert.deepEqual(delivered, [{ id, userId: "42", ok: true, result: { taskId: "task-1" } }]);
  } finally {
    await first.close();
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Worker to publisher to desktop route redelivers a cached mutation result after a crash", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-route-crash-"));
  const secretFile = path.join(root, "sync.secret");
  const publisherReceipts = path.join(root, "publisher-receipts.json");
  const desktopReceipts = path.join(root, "desktop-receipts.json");
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce62";
  const command = { id, userId: "42", action: "new-task", params: { provider: "codex" } };
  await writeFile(secretFile, "f".repeat(64));
  let effects = 0;
  const firstRouter = createDesktopControlRouter({
    handlers: { "new-task": async () => ({ taskId: `task-${++effects}` }) },
    mutationActions: ["new-task"],
    receiptFile: desktopReceipts,
    reconcileMutation: async () => ({ resolved: false, error: "unexpected" }),
  });
  let effectFinished;
  const finished = new Promise((resolve) => { effectFinished = resolve; });
  const first = new MiniAppPublisher({
    dataDirectory: root, publicUrl: "https://hub.example.test", syncSecretFile: secretFile,
    controlReceiptFile: publisherReceipts,
    fetchImpl: async (url) => url.endsWith("/api/control/pull")
      ? Response.json({ commands: [command] }) : Response.json({ ok: true }),
    controlHandler: firstRouter.handleDesktopControl,
    afterControlEffect: async () => {
      effectFinished();
      await new Promise(() => {});
    },
  });
  void first.pollControl();
  await finished;
  const publisherJournal = JSON.parse(await readFile(publisherReceipts, "utf8"));
  publisherJournal.records[0].effectOwner.pid = 999_999;
  await writeFile(publisherReceipts, `${JSON.stringify(publisherJournal)}\n`);
  const restartedRouter = createDesktopControlRouter({
    handlers: { "new-task": async () => ({ taskId: `duplicate-${++effects}` }) },
    mutationActions: ["new-task"],
    receiptFile: desktopReceipts,
    reconcileMutation: async () => ({ resolved: false, error: "unexpected" }),
  });
  const delivered = [];
  const restarted = new MiniAppPublisher({
    dataDirectory: root, publicUrl: "https://hub.example.test", syncSecretFile: secretFile,
    controlReceiptFile: publisherReceipts,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/control/pull")) return Response.json({ commands: [command] });
      delivered.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    controlHandler: restartedRouter.handleDesktopControl,
    controlReconciler: async ({ action, params, context }) => ({
      resolved: true,
      result: await restartedRouter.handleDesktopControl({ action, params, context }),
    }),
  });
  try {
    await restarted.pollControl();
    assert.equal(effects, 1);
    assert.deepEqual(delivered, [{ id, userId: "42", ok: true, result: { taskId: "task-1" } }]);
  } finally {
    await restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

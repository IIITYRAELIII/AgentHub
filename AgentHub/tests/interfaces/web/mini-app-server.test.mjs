import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createJsonResponder,
  extractWorkLogHtml,
  loopbackRequest,
  miniAppMenuButtonRequests,
  MiniAppServer,
  PublicAuthAttemptLimiter,
  validateTelegramInitData,
  workspaceFileRevealAccessError,
} from "../../../src/interfaces/web/mini-app-server.mjs";
import { buildLazyJournalPayload } from "../../../src/interfaces/web/mini-app-journal-data.mjs";
import { createAttachmentStorageName } from "../../../src/domain/attachment-files.mjs";
import { createDesktopControlRouter } from "../../../src/interfaces/desktop/desktop-control-router.mjs";
import { createDesktopApplicationRouter } from "../../../src/interfaces/desktop/desktop-application-router.mjs";
import { createRuntimeHealth } from "../../../src/application/runtime-health.mjs";
import { createLocalWebviewSession } from "../../../src/interfaces/web/local-webview-session.mjs";
import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";

test("resumable upload HTTP authenticates, resumes chunks and streams the completed file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-http-upload-"));
  const secret = "u".repeat(43);
  const server = new MiniAppServer({ port: 0, journalDatabase: memoryJournal(),
    attachmentDirectory: root, localAccessSecret: secret });
  try {
    let address = await server.start();
    let url = `${address.url}api/attachment-upload`;
    const headers = { Authorization: `webview ${createLocalWebviewSession(secret).token}` };
    assert.equal((await fetch(url)).status, 401);
    const capabilities = await (await fetch(url, { headers })).json();
    assert.equal(capabilities.protocol, "agent-hub-attachment-upload-v1");
    const preflight = await fetch(url, { method: "OPTIONS", headers: {
      Origin: "vscode-webview://agent-hub-test", "Access-Control-Request-Method": "PUT" } });
    assert.match(preflight.headers.get("access-control-allow-methods"), /PUT, DELETE/u);
    assert.match(preflight.headers.get("access-control-allow-headers"), /X-Agent-Hub-Chunk-Sha256/u);
    const uploadId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const bytes = Buffer.from("resumable attachment");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId, name: "resume.txt", type: "text/plain", size: bytes.length }) })).status, 200);
    assert.equal((await fetch(`${url}?id=${uploadId}&index=0`, { method: "PUT",
      headers: { ...headers, "X-Agent-Hub-Chunk-Sha256": sha256 }, body: bytes })).status, 200);
    await server.close();
    address = await server.start();
    url = `${address.url}api/attachment-upload`;
    assert.equal((await (await fetch(`${url}?id=${uploadId}`, { headers })).json()).received.length, 1);
    const completed = await (await fetch(`${url}?id=${uploadId}&complete=1`, { method: "POST", headers })).json();
    assert.equal(completed.sha256, sha256);
    const download = await fetch(`${address.url}api/message-attachment/${encodeURIComponent(path.basename(completed.path))}`, { headers });
    assert.equal(download.headers.get("content-length"), String(bytes.length));
    assert.equal(await download.text(), bytes.toString());
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

const LIMITS_HTML = '<div data-work-log-rate-limits data-sampled-at="2026-07-30T02:55:14.512Z">'
  + '<span data-rate-limit-caption>Лимиты</span>'
  + '<span data-rate-limit><span data-rate-limit-name>CODEX</span>'
  + '<span data-rate-limit-value>75.0%</span></span></div>';

const DAY_HTML = [
  '<details data-work-log-day-section open>',
  '<summary data-work-log-day><strong>27.07.2026</strong></summary>',
  '<div data-work-log-table>Пилот</div>',
  "</details>",
].join("");

test("local session trust uses the socket peer and rejects forwarded requests", () => {
  assert.equal(loopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" }, headers: { host: "evil.test" } }), true);
  assert.equal(loopbackRequest({ socket: { remoteAddress: "203.0.113.10" }, headers: { host: "127.0.0.1" } }), false);
  assert.equal(loopbackRequest({
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1", "x-forwarded-for": "203.0.113.10" },
  }), false);
});

test("workspace file reveal access allows trusted devices and separates unavailable runtime", () => {
  assert.equal(workspaceFileRevealAccessError({
    authorizationSource: "trusted-device",
    hasWorkspaceFileRoots: true,
    hasRevealWorkspaceFile: true,
  }), null);
  assert.deepEqual(workspaceFileRevealAccessError({
    authorizationSource: "telegram-mini-app",
    hasWorkspaceFileRoots: true,
    hasRevealWorkspaceFile: true,
  }), {
    status: 403,
    code: "workspace-file-reveal-forbidden",
    error: "Показ файлов доступен только локальному Agent Hub или доверенному устройству.",
  });
  assert.deepEqual(workspaceFileRevealAccessError({
    authorizationSource: "trusted-device",
    hasWorkspaceFileRoots: true,
    hasRevealWorkspaceFile: false,
  }), {
    status: 503,
    code: "workspace-file-reveal-unavailable",
    error: "Показ файлов на стороне runtime недоступен.",
  });
});
const BOT_TOKEN = "123456789:test-token";

test("health exposes the exact identity generated by its Test Contour runtime", async () => {
  const identity = {
    contourId: "contour-1",
    operationId: "operation-1",
    releaseId: "release-1",
    model: "fake-codex",
    expectedPort: 8877,
    runtimeNonce: "nonce-1",
  };
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    health: createRuntimeHealth({ ready: true }),
    testContourRuntimeIdentity: identity,
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}health`);
    const body = await response.json();
    assert.deepEqual(body.testContourRuntime, {
      ...identity,
      pid: process.pid,
      actualPort: address.port,
    });
  } finally {
    await server.close();
  }
});

test("local Web App accepts short-lived VS Code WebView CORS sessions", async () => {
  const secret = "v".repeat(43);
  const origin = "vscode-webview://agent-hub-test";
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
    localAccessSecret: secret,
  });
  try {
    const address = await server.start();
    const preflight = await fetch(`${address.url}api/journal`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

    const session = createLocalWebviewSession(secret);
    const response = await fetch(`${address.url}api/journal`, {
      headers: { Origin: origin, Authorization: `webview ${session.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    const journal = await response.json();
    assert.match(journal.html, /data-lazy-day="27\.07\.2026"/u);
    assert.doesNotMatch(journal.html, /Пилот/u);

    const expired = createLocalWebviewSession(secret, { now: Date.now() - 60_000, ttlSeconds: 30 });
    assert.equal((await fetch(`${address.url}api/journal`, {
      headers: { Origin: origin, Authorization: `webview ${expired.token}` },
    })).status, 401);
  } finally {
    await server.close();
  }
});

test("the local VS Code webview session reaches local-only provider sign-in through the real /api/control authorizer", async () => {
  const secret = "w".repeat(43);
  const code = "Kc0de-AbC_123#sTaTe-456_xyz";
  const calls = [];
  const sources = [];
  const handlers = new Proxy({}, {
    get: (_target, name) => async (params) => {
      calls.push({ handler: String(name), provider: params?.provider });
      return { accepted: true, login: { provider: params?.provider, status: "pending" } };
    },
  });
  const router = createDesktopApplicationRouter({
    handlers,
    commands: { dispatch: async () => ({ accepted: true }), settingTarget: () => ({}) },
  });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    localAccessSecret: secret,
    deviceStore: {
      async resolveSession(token) {
        if (token !== "y".repeat(43)) throw new Error("device session is invalid");
        return { id: "remote-owner", deviceId: "phone" };
      },
    },
    controlHandler: (request) => {
      sources.push(request.context?.source);
      return router.handleDesktopControl(request);
    },
  });
  const post = (address, authorization, action, params) => fetch(`${address.url}api/control`, {
    method: "POST",
    headers: { ...(authorization ? { Authorization: authorization } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ action, params }),
  });
  try {
    const address = await server.start();
    const webview = `webview ${createLocalWebviewSession(secret).token}`;
    for (const [action, params] of [
      ["start-provider-login", { provider: "claude" }],
      ["submit-provider-login-code", { provider: "claude", attemptId: "1", code }],
      ["cancel-provider-login", { provider: "claude" }],
    ]) {
      const response = await post(address, webview, action, params);
      const body = await response.text();
      assert.equal(response.status, 200, `${action}: ${body}`);
      assert.equal(JSON.parse(body).ok, true);
      assert.equal(body.includes("Kc0de"), false, "the manual code is never echoed");

      const expired = createLocalWebviewSession(secret, { now: Date.now() - 60_000, ttlSeconds: 30 });
      assert.equal((await post(address, `webview ${expired.token}`, action, params)).status, 401);
      assert.equal((await post(address, "", action, params)).status, 401);
      const remote = await post(address, `device ${"y".repeat(43)}`, action, params);
      assert.equal(remote.status, 400);
      assert.match((await remote.json()).error, /только локальному Agent Hub/u);
    }
    assert.deepEqual(calls, [
      { handler: "startProviderLogin", provider: "claude" },
      { handler: "submitProviderLoginCode", provider: "claude" },
      { handler: "cancelProviderLogin", provider: "claude" },
    ]);
    // The source is assigned by the authorizer, not by request parameters.
    assert.deepEqual(sources, [
      "local-vscode-webview", "trusted-device",
      "local-vscode-webview", "trusted-device",
      "local-vscode-webview", "trusted-device",
    ]);
  } finally {
    await server.close();
  }
});

test("large snapshot responses use gzip when the client accepts it", async () => {
  const payload = { tasks: [{ id: "large", text: "snapshot".repeat(8_192) }] };
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    controlHandler: async () => payload,
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/snapshot`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.ok(Number(response.headers.get("content-length")) < JSON.stringify(payload).length);
    assert.deepEqual(await response.json(), payload);
  } finally {
    await server.close();
  }
});

test("large snapshot compression leaves a local control command responsive", async () => {
  // The body is deliberately hard to compress. A synchronous gzip blocks the
  // same Hub event loop that must accept unrelated local commands.
  const payload = { text: randomBytes(8 * 1_024 * 1_024).toString("base64") };
  let handlerEntered;
  const entered = new Promise((resolve) => { handlerEntered = resolve; });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    controlHandler: async ({ action }) => {
      if (action !== "snapshot") return { accepted: true };
      handlerEntered();
      return payload;
    },
  });
  try {
    const address = await server.start();
    const snapshot = fetch(`${address.url}api/snapshot`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    await entered;
    const command = fetch(`${address.url}api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "read-status", params: {}, commandId: "latency-probe-1" }),
    });
    const first = await Promise.race([
      snapshot.then(() => "snapshot"),
      command.then(() => "command"),
    ]);
    assert.equal(first, "command");
    assert.deepEqual(await (await command).json(), {
      ok: true,
      result: { accepted: true },
      receiptId: "latency-probe-1",
    });
    assert.deepEqual(await (await snapshot).json(), payload);
  } finally {
    await server.close();
  }
});

test("JSON compression is bounded, abort-safe, and preserves the raw fallback", () => {
  const callbacks = [];
  const json = createJsonResponder({
    maxConcurrentCompressions: 2,
    compress: (_body, callback) => callbacks.push(callback),
  });
  const response = () => ({
    headers: null,
    body: null,
    destroyed: false,
    getHeader: () => undefined,
    writeHead(_status, headers) { this.headers = headers; },
    end(body) { this.body = body; this.writableEnded = true; },
  });
  const value = { text: "x".repeat(20_000) };
  const first = response();
  const second = response();
  const third = response();
  for (const target of [first, second, third]) {
    json(target, 200, value, "GET", { acceptEncoding: "gzip" });
  }
  assert.equal(callbacks.length, 2);
  assert.equal(first.headers, null);
  assert.equal(second.headers, null);
  assert.equal(third.headers["Content-Encoding"], undefined);
  assert.equal(third.headers.Vary, "Accept-Encoding");
  assert.deepEqual(JSON.parse(third.body), value);
  first.destroyed = true;
  callbacks[0](null, Buffer.from("compressed"));
  assert.equal(first.headers, null);
  callbacks[1](new Error("compression failed"));
  assert.equal(second.headers["Content-Encoding"], undefined);
  assert.equal(second.headers.Vary, "Accept-Encoding");
  assert.deepEqual(JSON.parse(second.body), value);
  const fourth = response();
  json(fourth, 200, value, "HEAD", { acceptEncoding: "gzip" });
  assert.equal(callbacks.length, 3);
  callbacks[2](null, Buffer.from("compressed"));
  assert.equal(fourth.headers["Content-Encoding"], "gzip");
  assert.equal(fourth.headers["Content-Length"], "compressed".length.toString());
  assert.equal(fourth.body, "");
  const broken = response();
  broken.writeHead = () => { throw new Error("socket closed"); };
  broken.destroy = () => { broken.destroyed = true; };
  json(broken, 200, value, "GET", { acceptEncoding: "gzip" });
  callbacks[3](null, Buffer.from("compressed"));
  assert.equal(broken.destroyed, true);
  const afterBroken = response();
  json(afterBroken, 200, value, "GET", { acceptEncoding: "gzip" });
  assert.equal(callbacks.length, 5, "a failed socket releases its compression slot");
  callbacks[4](new Error("compression failed"));
  assert.deepEqual(JSON.parse(afterBroken.body), value);

  const throwing = createJsonResponder({ compress: () => { throw new Error("dispatch failed"); } });
  const immediateFallback = response();
  throwing(immediateFallback, 200, value, "GET", { acceptEncoding: "gzip" });
  assert.equal(immediateFallback.headers["Content-Encoding"], undefined);
  assert.deepEqual(JSON.parse(immediateFallback.body), value);
});

test("large lazy journal fragments use gzip without bloating the initial response", async () => {
  const largeDay = DAY_HTML.replace("Пилот", "Журнал".repeat(8_192));
  const journalDatabase = memoryJournal(largeDay);
  journalDatabase.fragments = async () => ({
    "27.07.2026": largeDay,
  });
  journalDatabase.fragmentPage = async () => ({
    fragments: { "27.07.2026": largeDay },
    nextOffset: null,
  });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase,
  });
  try {
    const address = await server.start();
    const journalResponse = await fetch(`${address.url}api/journal`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(journalResponse.status, 200);
    assert.equal(journalResponse.headers.get("content-encoding"), null);
    assert.doesNotMatch((await journalResponse.json()).html, /Журнал/u);

    const daysResponse = await fetch(`${address.url}api/journal/days`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(daysResponse.status, 200);
    assert.equal(daysResponse.headers.get("content-encoding"), "gzip");
    assert.match((await daysResponse.json()).days["27.07.2026"], /Журнал/u);
  } finally {
    await server.close();
  }
});

test("unchanged journal answers from metadata without loading the full payload", async () => {
  let payloadCalls = 0;
  const journalDatabase = {
    metadata: async () => ({
      updatedAt: "2026-09-03T10:00:00.000Z",
      version: "sqlite-v-fast",
      revision: 42,
    }),
    payload: async () => {
      payloadCalls += 1;
      throw new Error("full payload must not be read for a matching ETag");
    },
    subscribe: () => () => {},
    close() {},
  };
  const server = new MiniAppServer({ host: "127.0.0.1", port: 0, journalDatabase });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/journal`, {
      headers: { "If-None-Match": '"sqlite-v-fast"' },
    });
    assert.equal(response.status, 304);
    assert.equal(payloadCalls, 0);
  } finally {
    await server.close();
  }
});

test("journal read checks the shipped account projection before serving metadata", async () => {
  const events = [];
  const journalDatabase = memoryJournal(DAY_HTML);
  const originalMetadata = journalDatabase.metadata;
  journalDatabase.metadata = async () => {
    events.push("metadata");
    return originalMetadata();
  };
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase,
    journalProjectionService: {
      ensureAccountUsageProjectionCurrent: async () => {
        events.push("ensure-projection");
        return { projected: false, projectionRequired: false, reason: "current" };
      },
    },
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/journal`);
    assert.equal(response.status, 200);
    assert.deepEqual(events.slice(0, 2), ["ensure-projection", "metadata"]);
  } finally {
    await server.close();
  }
});

test("journal read exposes mandatory projection failure instead of serving stale HTML", async () => {
  let metadataCalls = 0;
  const journalDatabase = memoryJournal("<main>Устаревшая проекция</main>");
  journalDatabase.metadata = async () => {
    metadataCalls += 1;
    return { updatedAt: "", version: "stale", revision: 1 };
  };
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase,
    journalProjectionService: {
      ensureAccountUsageProjectionCurrent: async () => {
        throw new Error("projection worker unavailable");
      },
    },
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/journal`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /projection worker unavailable/u);
    assert.equal(metadataCalls, 0);
  } finally {
    await server.close();
  }
});

test("Mini App close terminates an incomplete HTTP connection and can restart", async () => {
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
  });
  const address = await server.start();
  const socket = createConnection({ host: address.host, port: address.port });
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  const socketClosed = new Promise((resolve) => socket.once("close", resolve));
  socket.write("GET /api/journal HTTP/1.1\r\nHost: localhost\r\n");

  try {
    await Promise.race([
      server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Mini App close timed out")), 1_000)),
    ]);
    await Promise.race([
      socketClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Mini App socket stayed open")), 1_000)),
    ]);
    assert.equal(socket.destroyed, true);
    const restarted = await server.start();
    assert.equal((await fetch(`${restarted.url}health`)).status, 200);
  } finally {
    socket.destroy();
    await server.close();
  }
});

test("journal payload exposes usage sync status and varies its ETag", async () => {
  let usageSync = {
    serverUrl: "https://sync.example.test/agenthub",
    deviceId: "device-abcdef123456",
    enrolledAt: "2026-08-20T11:00:00.000Z",
    lastPushAt: "2026-08-20T11:03:18.295Z",
    lastPullAt: "2026-08-20T11:03:28.998Z",
    lastResult: { imported: true, added: 6, updated: 0, projected: true, before: 5757, after: 5763 },
  };
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
    usageSyncRemoteConfigStore: {
      load: async () => structuredClone(usageSync),
    },
  });
  try {
    const address = await server.start();
    const first = await fetch(`${address.url}api/journal`);
    assert.equal(first.status, 200);
    const firstEtag = first.headers.get("etag");
    const firstPayload = await first.json();
    assert.equal(firstPayload.usageSync.configured, true);
    assert.equal(firstPayload.usageSync.deviceId, "device-abcdef123456");
    assert.deepEqual(firstPayload.usageSync.lastResult, {
      added: 6,
      updated: 0,
      rejected: 0,
      projected: true,
      imported: true,
      before: 5757,
      after: 5763,
    });

    assert.equal((await fetch(`${address.url}api/journal`, {
      headers: { "If-None-Match": firstEtag },
    })).status, 304);

    usageSync = { ...usageSync, lastPullAt: "2026-08-20T11:08:28.998Z" };
    const changed = await fetch(`${address.url}api/journal`, {
      headers: { "If-None-Match": firstEtag },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), firstEtag);
    assert.equal((await changed.json()).version, firstPayload.version);
  } finally {
    await server.close();
  }
});

test("journal usage sync endpoint runs manual sync and exposes refreshed status", async () => {
  const journal = memoryJournal(DAY_HTML);
  let usageSync = {
    serverUrl: "https://sync.example.test/agenthub",
    deviceId: "device-manual",
    lastPullAt: "",
    lastResult: null,
  };
  let syncCalls = 0;
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: journal,
    usageSyncRemoteConfigStore: {
      load: async () => structuredClone(usageSync),
    },
    usageSyncService: {
      sync: async () => {
        syncCalls += 1;
        usageSync = {
          ...usageSync,
          lastPullAt: "2026-08-20T13:40:00.000Z",
          lastResult: { imported: true, added: 2, updated: 1, projected: true, before: 10, after: 13 },
        };
        journal.replace(`${LIMITS_HTML}\n${DAY_HTML}`);
        return { synced: true, pull: { added: 2, updated: 1, projected: true } };
      },
    },
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/journal/usage-sync`, { method: "POST" });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(syncCalls, 1);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.result, { synced: true, pull: { added: 2, updated: 1, projected: true } });
    assert.equal(payload.usageSync.deviceId, "device-manual");
    assert.equal(payload.usageSync.lastResult.added, 2);
    assert.equal(payload.usageSync.lastResult.updated, 1);
    assert.equal(payload.usageSync.lastResult.projected, true);
    assert.equal(payload.journal.version, "sha256:0000000000000000000000000000000000000000000000000000000000000002");

    const journalResponse = await fetch(`${address.url}api/journal`);
    assert.equal(journalResponse.status, 200);
    const journalPayload = await journalResponse.json();
    assert.match(journalPayload.html, /data-work-log-rate-limits/u);
    assert.equal(journalPayload.usageSync.lastResult.after, 13);
  } finally {
    await server.close();
  }
});

test("journal usage sync invite and enroll endpoints support guided connection", async () => {
  const journal = memoryJournal(DAY_HTML);
  let usageSync = {
    serverUrl: "https://sync.example.test/agenthub",
    deviceId: "",
    enrolledAt: "",
    lastPullAt: "",
    lastResult: null,
  };
  const calls = [];
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: journal,
    usageSyncRemoteConfigStore: {
      load: async () => structuredClone(usageSync),
    },
    usageSyncService: {
      createEnrollmentCode: async ({ ttlSeconds }) => {
        calls.push(["invite", ttlSeconds]);
        return { ok: true, code: "join-code", expiresAtMs: 1780000000000 };
      },
      enroll: async ({ serverUrl, code }) => {
        calls.push(["enroll", serverUrl, code]);
        usageSync = {
          ...usageSync,
          deviceId: "device-new",
          enrolledAt: "2026-08-20T13:45:00.000Z",
          lastPullAt: "2026-08-20T13:45:10.000Z",
          lastResult: { imported: true, added: 1, updated: 0, projected: true, before: 0, after: 1 },
        };
        journal.replace(`${LIMITS_HTML}\n${DAY_HTML}`);
        return { enrolled: true };
      },
    },
  });
  try {
    const address = await server.start();
    const status = await fetch(`${address.url}api/journal`);
    assert.equal((await status.json()).usageSync.configured, false);

    const invite = await fetch(`${address.url}api/journal/usage-sync/invite`, { method: "POST" });
    assert.equal(invite.status, 200);
    assert.equal((await invite.json()).result.code, "join-code");

    const enroll = await fetch(`${address.url}api/journal/usage-sync/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverUrl: "https://sync.example.test/agenthub", code: "join-code" }),
    });
    assert.equal(enroll.status, 200);
    const enrolled = await enroll.json();
    assert.equal(enrolled.usageSync.configured, true);
    assert.equal(enrolled.usageSync.deviceId, "device-new");
    assert.deepEqual(calls, [
      ["invite", 10_800],
      ["enroll", "https://sync.example.test/agenthub", "join-code"],
    ]);
  } finally {
    await server.close();
  }
});

test("journal usage sync device label endpoint supports local Web and mobile Web", async () => {
  const journal = memoryJournal(DAY_HTML);
  const labels = [];
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: journal,
    usageSyncRemoteConfigStore: {
      load: async () => ({
        serverUrl: "https://sync.example.test/agenthub",
        deviceId: "device-label",
        enrolledAt: "2026-08-20T13:45:00.000Z",
        deviceLabel: labels.at(-1) ?? "",
        deviceLabelConfirmed: Boolean(labels.length),
        deviceLabelConfirmedAt: labels.length ? "2026-08-20T13:46:00.000Z" : "",
        deviceLabelPromptRequired: !labels.length,
      }),
    },
    usageSyncService: {
      setDeviceLabel: async (deviceLabel) => {
        labels.push(String(deviceLabel));
        journal.replace(`${LIMITS_HTML}\n${DAY_HTML}`);
        return { updated: true, deviceLabel };
      },
    },
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/journal/usage-sync/device-label`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceLabel: "SidorukSV" }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(labels, ["SidorukSV"]);
    assert.equal(payload.ok, true);
    assert.equal(payload.result.deviceLabel, "SidorukSV");
    assert.equal(payload.usageSync.deviceLabel, "SidorukSV");
    assert.equal(payload.usageSync.deviceLabelConfirmed, true);
    assert.equal(payload.journal.version, "sha256:0000000000000000000000000000000000000000000000000000000000000002");
  } finally {
    await server.close();
  }
});

test("Mini App close does not wait forever for a blocked control handler", async () => {
  let enterHandler;
  let releaseHandler;
  const handlerEntered = new Promise((resolve) => { enterHandler = resolve; });
  const handlerRelease = new Promise((resolve) => { releaseHandler = resolve; });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
    handlerCloseTimeoutMs: 20,
    controlHandler: async () => {
      enterHandler();
      await handlerRelease;
      return { ok: true };
    },
  });
  const address = await server.start();
  const request = fetch(`${address.url}api/snapshot`).catch(() => null);
  await handlerEntered;

  try {
    await Promise.race([
      server.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Mini App close timed out")), 500)),
    ]);
  } finally {
    releaseHandler();
    await request;
    await server.close();
  }
});

function memoryJournal(html = "") {
  let revision = 0;
  let current;
  const listeners = new Set();
  const replace = (nextHtml) => {
    revision += 1;
    current = {
      ...buildLazyJournalPayload(nextHtml),
      updatedAt: new Date(Date.UTC(2026, 6, 27, 12, 0, revision)).toISOString(),
      version: `sha256:${String(revision).padStart(64, "0")}`,
      revision,
    };
    for (const listener of listeners) listener({ type: "revision", revision });
  };
  replace(html);
  return {
    metadata: async () => ({
      updatedAt: current.updatedAt,
      version: current.version,
      revision: current.revision,
    }),
    payload: async () => ({
      html: current.html,
      summary: current.summary,
      updatedAt: current.updatedAt,
      version: current.version,
      revision: current.revision,
    }),
    snapshot: async () => structuredClone(current),
    fragment: async (kind, key) => current[kind === "day" ? "days" : "turns"]?.[key] ?? null,
    fragments: async (kind) => structuredClone(current[kind === "day" ? "days" : "turns"] ?? {}),
    fragmentPage: async (kind, { offset = 0, limit = 7 } = {}) => {
      const entries = Object.entries(current[kind === "day" ? "days" : "turns"] ?? {});
      return {
        fragments: Object.fromEntries(entries.slice(offset, offset + limit)),
        nextOffset: offset + limit < entries.length ? offset + limit : null,
      };
    },
    turnPage: async ({
      expectedVersion = "",
      profileMode = "",
      workspaceId = "",
      streamId = "",
      provider = "",
      threadId = "",
      fromMs = 0,
      toMs = 0,
      offset = 0,
      limit = 20,
    } = {}) => {
      if (expectedVersion && expectedVersion !== current.version) {
        return {
          conflict: true,
          version: current.version,
          turns: [],
          nextOffset: null,
        };
      }
      const filtered = (current.entries ?? []).filter((entry) => (
        (!workspaceId || entry.workspaceId === workspaceId)
        && (!streamId || entry.streamId === streamId)
        && (!provider || entry.provider === provider)
        && (!threadId || entry.threadId === threadId)
        && (!Number(fromMs) || entry.completedAtMs >= Number(fromMs))
        && (!Number(toMs) || entry.completedAtMs < Number(toMs))
      )).sort((left, right) => right.completedAtMs - left.completedAtMs);
      const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 20));
      const turns = filtered.slice(Number(offset) || 0, (Number(offset) || 0) + boundedLimit);
      return {
        conflict: false,
        version: current.version,
        turns: turns.map(({ turnRef, date, html: turnHtml }) => ({
          turnRef,
          date,
          html: turnHtml,
        })),
        nextOffset: filtered.length > (Number(offset) || 0) + turns.length
          ? (Number(offset) || 0) + turns.length
          : null,
        ...(profileMode === "stream" ? { profileSummary: current.summary } : {}),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace,
    close() {},
  };
}

function signedInitData({
  authDate = Math.floor(Date.now() / 1_000),
  user = { id: 42, first_name: "Иван" },
} = {}) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    query_id: "test-query",
    user: JSON.stringify(user),
  });
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

test("Mini App menu button is registered globally and for every allowed chat", () => {
  const requests = miniAppMenuButtonRequests({
    url: "https://journal.example/",
    text: "Журнал",
    chatIds: new Set([42, 84]),
  });
  assert.deepEqual(requests, [
    {
      menu_button: {
        type: "web_app",
        text: "Журнал",
        web_app: { url: "https://journal.example/" },
      },
    },
    {
      chat_id: 42,
      menu_button: {
        type: "web_app",
        text: "Журнал",
        web_app: { url: "https://journal.example/" },
      },
    },
    {
      chat_id: 84,
      menu_button: {
        type: "web_app",
        text: "Журнал",
        web_app: { url: "https://journal.example/" },
      },
    },
  ]);
});

test("extractWorkLogHtml returns generated journal days without the Markdown heading", () => {
  assert.equal(
    extractWorkLogHtml(`# Глобальный журнал работ\n\n${DAY_HTML}\n`),
    DAY_HTML,
  );
});

test("extractWorkLogHtml escapes an unprojected journal", () => {
  assert.equal(
    extractWorkLogHtml("# Глобальный журнал работ\n\n<unsafe>"),
    "<pre data-mini-app-fallback>&lt;unsafe&gt;</pre>",
  );
});

test("Mini App serves only safe persistent message attachment names", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-message-attachment-"));
  const attachments = path.join(directory, "attachments");
  const thumbnail = path.join(directory, "thumbnail.webp");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    attachmentDirectory: attachments,
    attachmentThumbnails: {
      create: async () => ({
        etag: '"thumbnail-test"',
        file: thumbnail,
        type: "image/webp",
      }),
    },
  });
  try {
    await mkdir(attachments, { recursive: true });
    const body = Buffer.alloc(2_784_684);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body);
    await writeFile(path.join(attachments, "message-1.png"), body);
    await writeFile(thumbnail, Buffer.from("small-preview"));
    const address = await server.start();
    const image = await fetch(`${address.url}api/message-attachment/message-1.png`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("content-length"), "2784684");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), body);
    const preview = await fetch(`${address.url}api/message-attachment/message-1.png?preview=1`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/webp");
    assert.equal(preview.headers.get("etag"), '"thumbnail-test"');
    assert.match(preview.headers.get("cache-control"), /immutable/u);
    assert.equal(await preview.text(), "small-preview");
    assert.equal((await fetch(
      `${address.url}api/message-attachment/message-1.png?preview=1`,
      { headers: { "If-None-Match": '"thumbnail-test"' } },
    )).status, 304);
    const documentId = createAttachmentStorageName("Требования.pdf", "01234567-89ab-cdef-0123-456789abcdef");
    await writeFile(path.join(attachments, documentId), Buffer.from("document"));
    const document = await fetch(`${address.url}api/message-attachment/${documentId}`);
    assert.equal(document.status, 200);
    assert.equal(document.headers.get("content-type"), "application/pdf");
    assert.match(document.headers.get("content-disposition"), /attachment;/u);
    assert.match(document.headers.get("content-disposition"), /filename\*=UTF-8''/u);
    assert.equal(document.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      (await fetch(`${address.url}api/message-attachment/..%2Fsecret.png`)).status,
      404,
    );
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App switches published frontend assets without restarting the server", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-static-bundle-"));
  const firstCss = path.join(directory, "first.css");
  const secondCss = path.join(directory, "second.css");
  await writeFile(firstCss, "first-release\n", "utf8");
  await writeFile(secondCss, "second-release\n", "utf8");
  let current = { id: "release-1", assetsDirectory: path.resolve(import.meta.dirname, "../../../assets/web-app"), workLogCssFile: firstCss };
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    workLogCssFile: firstCss,
    assetBundleProvider: async () => current,
    assetBundleRefreshMs: 0,
  });
  try {
    const address = await server.start();
    assert.equal(await (await fetch(`${address.url}work-log.css`)).text(), "first-release\n");
    current = { ...current, id: "release-2", workLogCssFile: secondCss };
    assert.equal(await (await fetch(`${address.url}work-log.css`)).text(), "second-release\n");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("versioned direct shell assets are complete, immutable, and cross-origin readable", async () => {
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}app.js?v=0123456789ab`);
    const body = Buffer.from(await response.arrayBuffer());
    const source = await readFile(path.resolve(import.meta.dirname, "../../../assets/web-app/app.js"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.match(response.headers.get("cache-control"), /immutable/u);
    assert.equal(body.length, source.length);
    assert.equal(createHash("sha256").update(body).digest("hex"), createHash("sha256").update(source).digest("hex"));
  } finally {
    await server.close();
  }
});

test("Telegram Mini App initData is signed, fresh and allowlisted", () => {
  const now = Date.UTC(2026, 6, 27, 12, 0, 0);
  const initData = signedInitData({ authDate: Math.floor(now / 1_000) });
  assert.equal(validateTelegramInitData(initData, {
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    now,
  }).id, 42);
  assert.throws(() => validateTelegramInitData(`${initData}x`, {
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    now,
  }), /hash|signature/u);
  assert.throws(() => validateTelegramInitData(initData, {
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([7]),
    now,
  }), /not allowed/u);
  assert.throws(() => validateTelegramInitData(signedInitData({
    authDate: Math.floor(now / 1_000) - 86_401,
  }), {
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    now,
  }), /expired/u);
});

test("Mini App serves the SQLite journal and announces revision changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-"));
  const journalDatabase = memoryJournal(DAY_HTML);
  const health = createRuntimeHealth({ now: () => 1_000 });
  health.begin({
    operations: [
      { id: "provider", label: "Подключение провайдера", state: "failed", error: "C:/secret/provider.log" },
    ],
  })
    .setCapability("provider", { critical: true, state: "failed", error: "offline" })
    .setCapability("telegram", { critical: false, state: "failed", error: "unavailable" })
    .complete();
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase,
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    health,
  });
  const abort = new AbortController();
  try {
    const address = await server.start();

    const healthResponse = await fetch(`${address.url}health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      ok: true,
      live: true,
      ready: false,
      degraded: true,
      status: "unready",
      // The probe is unauthenticated, so it reports state without the startup
      // error text, which carries local paths and provider messages.
      capabilities: [
        { name: "provider", critical: true, state: "failed" },
        { name: "telegram", critical: false, state: "failed" },
      ],
      startup: {
        startedAtMs: 1_000,
        completedAtMs: 1_000,
        operations: [
          {
            id: "provider",
            label: "Подключение провайдера",
            state: "failed",
            startedAtMs: 1_000,
            completedAtMs: 1_000,
          },
        ],
      },
    });
    assert.equal(healthResponse.headers.get("cache-control"), "no-store");
    assert.match(healthResponse.headers.get("content-security-policy"), /default-src 'self'/);

    const journal = await fetch(`${address.url}api/journal`);
    const payload = await journal.json();
    assert.match(payload.html, /data-lazy-day="27\.07\.2026"/u);
    assert.doesNotMatch(payload.html, /Пилот/u);
    assert.match(payload.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(payload.version, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(journal.headers.get("etag"), `"${payload.version}"`);
    const unchanged = await fetch(`${address.url}api/journal`, {
      headers: { "If-None-Match": `"${payload.version}"` },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");

    const externalHeaders = { "CF-Connecting-IP": "203.0.113.10" };
    assert.equal((await fetch(`${address.url}api/journal`, {
      headers: externalHeaders,
    })).status, 401);
    assert.equal((await fetch(`${address.url}api/journal`, {
      headers: {
        ...externalHeaders,
        Authorization: `tma ${signedInitData()}`,
      },
    })).status, 200);

    const shellSource = await (await fetch(address.url)).text();
    assert.match(shellSource, /data-dialog-settings/u);
    assert.match(shellSource, /data-dialog-agent/u);
    assert.doesNotMatch(shellSource, /data-dialog-options="agent"/u);
    assert.match(shellSource, /data-status-slot/u);
    assert.match(shellSource, /data-browser-auth/u);
    assert.match(shellSource, /src="\/browser-device-auth\.js"/u);
    const shellAssets = [...new Set([...shellSource.matchAll(
      /\b(?:src|href)="(\/(?!\/)[^"?#]+)(?:[?#][^"]*)?"/gu,
    )].map((match) => match[1]))];
    assert.ok(shellAssets.includes("/attachments/interactions.js"));
    for (const pathname of shellAssets) {
      const response = await fetch(new URL(pathname, address.url));
      assert.equal(response.status, 200, `index.html resource ${pathname}`);
      assert.ok((await response.arrayBuffer()).byteLength > 0, pathname);
    }
    const browserAuthSource = await (await fetch(`${address.url}browser-device-auth.js`)).text();
    assert.match(browserAuthSource, /indexedDB\.open\(DATABASE_NAME, 1\)/u);
    assert.match(browserAuthSource, /crypto\.subtle\.generateKey\([\s\S]*false,[\s\S]*\["sign", "verify"\]/u);
    assert.match(browserAuthSource, /\/api\/device\/pair/u);
    assert.match(browserAuthSource, /\/api\/device\/challenge/u);
    assert.match(browserAuthSource, /\/api\/device\/session/u);
    assert.doesNotMatch(browserAuthSource, /localStorage|sessionStorage/u);
    const appSource = await (await fetch(`${address.url}app.js`)).text();
    assert.match(appSource, /setTaskDiff\(taskId, text\)/u);
    assert.match(appSource, /class: "task-diff"/u);
    assert.match(appSource, /emit\("task:new", \{ title, provider \}\)/u);
    assert.match(appSource, /data-dialog-settings-open/u);
    const clientSource = await (await fetch(`${address.url}hub-client.js`)).text();
    assert.match(clientSource, /agentHub\.setTaskDiff\(targetId/u);
    assert.match(clientSource, /control\("new-task", \{[\s\S]*provider: selectedProvider,[\s\S]*workspaceName: title \|\| undefined,[\s\S]*\}\)/u);
    assert.doesNotMatch(clientSource, /agent: "provider"/u);
    assert.doesNotMatch(clientSource, /setStatus\(\{ rows: \[\{ name: "Diff"/u);

    for (const pathname of [
      "",
      "background-motion-preference.js",
      "browser-device-auth.js",
      "message-view-controller.js",
      "chat-surface-preference.js",
      "navigation-tabs-controller.js",
      "approval-form.js",
      "journal-view-controller.js",
      "journal-polling-policy.js",
      "attachments/interactions.js",
      "usage-burn-rate.js",
      "app.js",
      "themes/metropolis/metropolis-glass.js",
      "themes/stormglass/storm-glass.js",
      "themes/metropolis/theme.css",
      "messages/lifecycle.js",
      "messages/projection.js",
      "messages/send-transaction.js",
      "background-http-scheduler.js",
      "hub-client.js",
      "styles.css",
      "work-log.css",
    ]) {
      const response = await fetch(`${address.url}${pathname}`);
      assert.equal(response.status, 200, pathname || "/");
      assert.ok((await response.text()).length > 20);
    }
    /* Фирменный знак относится к оболочке, а не к пакету темы: один immutable
       PNG одинаково обслуживает Web, VS Code и экран доверия браузеру. */
    const appMark = await fetch(`${address.url}agent-hub-mark.png`);
    assert.equal(appMark.status, 200);
    assert.equal(appMark.headers.get("content-type"), "image/png");
    assert.match(appMark.headers.get("cache-control"), /immutable/u);
    assert.ok((await appMark.arrayBuffer()).byteLength > 20_000);
    const blackHole = await fetch(`${address.url}themes/blackhole/blackhole-blue.jpg`);
    assert.equal(blackHole.status, 200);
    assert.equal(blackHole.headers.get("content-type"), "image/jpeg");
    assert.match(blackHole.headers.get("cache-control"), /immutable/u);
    const gothicImage = await fetch(`${address.url}themes/gothic/gothic-khorinis-harbor.jpg`);
    assert.equal(gothicImage.status, 200);
    assert.equal(gothicImage.headers.get("content-type"), "image/jpeg");
    assert.match(gothicImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await gothicImage.arrayBuffer()).byteLength > 100_000);
    const nebulaImage = await fetch(`${address.url}themes/nebula/nebula-veil.jpg`);
    assert.equal(nebulaImage.status, 200);
    assert.equal(nebulaImage.headers.get("content-type"), "image/jpeg");
    assert.match(nebulaImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await nebulaImage.arrayBuffer()).byteLength > 100_000);
    const orbitImage = await fetch(`${address.url}themes/orbit/orbit-cartography.jpg`);
    assert.equal(orbitImage.status, 200);
    assert.equal(orbitImage.headers.get("content-type"), "image/jpeg");
    assert.match(orbitImage.headers.get("cache-control"), /immutable/u);
    assert.ok((await orbitImage.arrayBuffer()).byteLength > 100_000);
    const orbitMark = await fetch(`${address.url}themes/orbit/orbit-mark.png`);
    assert.equal(orbitMark.status, 200);
    assert.equal(orbitMark.headers.get("content-type"), "image/png");
    assert.match(orbitMark.headers.get("cache-control"), /immutable/u);
    assert.ok((await orbitMark.arrayBuffer()).byteLength > 1_000);
    const meadow = await fetch(`${address.url}themes/meadow/meadow-sun.jpg`);
    assert.equal(meadow.status, 200);
    assert.equal(meadow.headers.get("content-type"), "image/jpeg");
    assert.match(meadow.headers.get("cache-control"), /immutable/u);
    assert.ok((await meadow.arrayBuffer()).byteLength > 100_000);
    /* Дополнительные сцены Verdant живут в том же пакете и публикуются
       автоматически вместе с его манифестом. */
    for (const name of ["verdant-canopy.jpg", "verdant-sanctum.jpg"]) {
      const scene = await fetch(`${address.url}themes/verdant/${name}`);
      assert.equal(scene.status, 200, name);
      assert.equal(scene.headers.get("content-type"), "image/jpeg", name);
      assert.match(scene.headers.get("cache-control"), /immutable/u, name);
      assert.ok((await scene.arrayBuffer()).byteLength > 100_000, name);
    }
    /* Эмблема вырезана из согласованного концепта и остаётся ресурсом самой
       темы, поэтому сервер и Worker находят её без общего списка ассетов. */
    const verdantMark = await fetch(`${address.url}themes/verdant/verdant-mark.png`);
    assert.equal(verdantMark.status, 200);
    assert.equal(verdantMark.headers.get("content-type"), "image/png");
    assert.match(verdantMark.headers.get("cache-control"), /immutable/u);
    assert.ok((await verdantMark.arrayBuffer()).byteLength > 100);
    /* Летний кадр и акварель «Озера» остаются JPEG: в PNG они весили бы
       впятеро больше при том же виде. */
    for (const name of [
      "lake-summer.jpg", "lake-watercolor.jpg",
      "gothic-old-camp.jpg", "gothic-swamp-camp.jpg", "gothic-new-camp.jpg",
      "gothic-xardas-tower.jpg", "gothic-sleeper-temple.jpg", "gothic-innos-monastery.jpg",
      "gothic-sun-circle.jpg", "gothic-irdorath.jpg", "gothic-adanos-temple.jpg",
    ]) {
      const theme = name.startsWith("lake-") ? "lake" : "gothic";
      const lake = await fetch(`${address.url}themes/${theme}/${name}`);
      assert.equal(lake.status, 200, name);
      assert.equal(lake.headers.get("content-type"), "image/jpeg", name);
      assert.match(lake.headers.get("cache-control"), /immutable/u, name);
      assert.ok((await lake.arrayBuffer()).byteLength > 100_000, name);
    }
    /* Сцены и палитра темы приходят из одной автоматически найденной папки. */
    const backgrounds = await fetch(`${address.url}themes/lake/theme.css`);
    assert.equal(backgrounds.status, 200);
    assert.match(backgrounds.headers.get("content-type"), /text\/css/u);
    const lakeStyles = await backgrounds.text();
    assert.match(lakeStyles, /\[data-background="lake-summer"\]/u);
    assert.match(lakeStyles, /\[data-background="lake-watercolor"\]/u);
    assert.doesNotMatch(lakeStyles, /lake-oil/u);
    const lakeAfterRain = await fetch(`${address.url}themes/lake/lake-after-rain.jpg`);
    assert.equal(lakeAfterRain.status, 200);
    assert.equal(lakeAfterRain.headers.get("content-type"), "image/jpeg");
    assert.match(lakeAfterRain.headers.get("cache-control"), /immutable/u);
    assert.ok((await lakeAfterRain.arrayBuffer()).byteLength > 100_000);
    const lakeCorners = await fetch(`${address.url}themes/lake/lake-corners.png`);
    assert.equal(lakeCorners.status, 200);
    assert.equal(lakeCorners.headers.get("content-type"), "image/png");
    assert.match(lakeCorners.headers.get("cache-control"), /immutable/u);
    for (const asset of ["lake-mark.png", "lake-settings.png"]) {
      const lakeChrome = await fetch(`${address.url}themes/lake/${asset}`);
      assert.equal(lakeChrome.status, 200);
      assert.equal(lakeChrome.headers.get("content-type"), "image/png");
      assert.match(lakeChrome.headers.get("cache-control"), /immutable/u);
    }
    const verdantStyles = await fetch(`${address.url}themes/verdant/theme.css`);
    assert.equal(verdantStyles.status, 200);
    assert.match(verdantStyles.headers.get("content-type"), /text\/css/u);
    assert.match(await verdantStyles.text(), /\[data-background="verdant-sanctum"\]/u);
    const storm = await fetch(`${address.url}themes/stormglass/storm-sea.jpg`);
    assert.equal(storm.status, 200);
    assert.equal(storm.headers.get("content-type"), "image/jpeg");
    assert.match(storm.headers.get("cache-control"), /immutable/u);
    assert.ok((await storm.arrayBuffer()).byteLength > 100_000);
    const magma = await fetch(`${address.url}themes/magma/magma-lava-well.jpg`);
    assert.equal(magma.status, 200);
    assert.equal(magma.headers.get("content-type"), "image/jpeg");
    assert.match(magma.headers.get("cache-control"), /immutable/u);
    assert.ok((await magma.arrayBuffer()).byteLength > 100_000);
    for (const asset of [
      "kashyyyk-origin-tree.jpg",
      "kashyyyk-canopy-village.jpg",
      "kashyyyk-refinery.jpg",
    ]) {
      const kashyyyk = await fetch(`${address.url}themes/kashyyyk/${asset}`);
      assert.equal(kashyyyk.status, 200, asset);
      assert.equal(kashyyyk.headers.get("content-type"), "image/jpeg", asset);
      assert.match(kashyyyk.headers.get("cache-control"), /immutable/u, asset);
      assert.ok((await kashyyyk.arrayBuffer()).byteLength > 100_000, asset);
    }
    for (const [asset, minimumBytes] of [
      ["kashyyyk-dark-wood.webp", 100_000],
      ["kashyyyk-panel-frame.webp", 30_000],
      ["kashyyyk-side-rail.webp", 100_000],
      ["kashyyyk-panel-moss.webp", 100_000],
    ]) {
      const kashyyykMaterial = await fetch(`${address.url}themes/kashyyyk/${asset}`);
      assert.equal(kashyyykMaterial.status, 200, asset);
      assert.equal(kashyyykMaterial.headers.get("content-type"), "image/webp", asset);
      assert.match(kashyyykMaterial.headers.get("cache-control"), /immutable/u, asset);
      assert.ok((await kashyyykMaterial.arrayBuffer()).byteLength > minimumBytes, asset);
    }
    const magmaFrame = await fetch(`${address.url}themes/magma/magma-forged-frame.png`);
    assert.equal(magmaFrame.status, 200);
    assert.equal(magmaFrame.headers.get("content-type"), "image/png");
    assert.match(magmaFrame.headers.get("cache-control"), /immutable/u);
    assert.ok((await magmaFrame.arrayBuffer()).byteLength > 100_000);
    const magmaStylesResponse = await fetch(`${address.url}themes/magma/theme.css`);
    assert.equal(magmaStylesResponse.status, 200);
    assert.match(magmaStylesResponse.headers.get("content-type"), /text\/css/u);
    const magmaStyles = await magmaStylesResponse.text();
    assert.match(magmaStyles, /url\("\.\/magma-lava-well\.jpg"\)/u);
    assert.match(magmaStyles, /url\("\.\/magma-forged-frame\.png"\)/u);
    assert.match(magmaStyles, /url\("\.\/magma-chat-frame\.png"\)/u);
    assert.match(magmaStyles, /url\("\.\/magma-side-rail\.png"\)/u);
    for (const asset of ["magma-chat-frame.png", "magma-side-rail.png"]) {
      const magmaOrnament = await fetch(`${address.url}themes/magma/${asset}`);
      assert.equal(magmaOrnament.status, 200);
      assert.equal(magmaOrnament.headers.get("content-type"), "image/png");
      assert.match(magmaOrnament.headers.get("cache-control"), /immutable/u);
      assert.ok((await magmaOrnament.arrayBuffer()).byteLength > 80_000);
    }
    const pulsar = await fetch(`${address.url}themes/pulsar/pulsar-aurora.png`);
    assert.equal(pulsar.status, 200);
    assert.equal(pulsar.headers.get("content-type"), "image/png");
    assert.match(pulsar.headers.get("cache-control"), /immutable/u);
    const taiga = await fetch(`${address.url}themes/taiga/rainforest-night.jpg`);
    assert.equal(taiga.status, 200);
    assert.equal(taiga.headers.get("content-type"), "image/jpeg");
    assert.match(taiga.headers.get("cache-control"), /immutable/u);
    const metropolis = await fetch(`${address.url}themes/metropolis/metropolis-night.jpg`);
    assert.equal(metropolis.status, 200);
    assert.equal(metropolis.headers.get("content-type"), "image/jpeg");
    assert.match(metropolis.headers.get("cache-control"), /immutable/u);
    assert.ok((await metropolis.arrayBuffer()).byteLength > 100_000);
    const stormGlass = await fetch(`${address.url}themes/stormglass/storm-sea.jpg`);
    assert.equal(stormGlass.status, 200);
    assert.equal(stormGlass.headers.get("content-type"), "image/jpeg");
    assert.match(stormGlass.headers.get("cache-control"), /immutable/u);
    assert.ok((await stormGlass.arrayBuffer()).byteLength > 100_000);
    const reliquary = await fetch(`${address.url}themes/reliquary/forgotten-waypoint.webp`);
    assert.equal(reliquary.status, 200);
    assert.equal(reliquary.headers.get("content-type"), "image/webp");
    assert.match(reliquary.headers.get("cache-control"), /immutable/u);
    assert.ok((await reliquary.arrayBuffer()).byteLength > 100_000);
    assert.ok((await blackHole.arrayBuffer()).byteLength > 100_000);
    assert.ok((await taiga.arrayBuffer()).byteLength > 100_000);
    assert.ok((await pulsar.arrayBuffer()).byteLength > 100_000);
    const page = await (await fetch(address.url)).text();
    assert.match(page, /data-theme="orbit"/u);
    assert.match(page, /<option value="taiga">Rain<\/option>/u);
    assert.match(page, /data-panel-open="settings"/u);
    assert.match(page, /data-view-button="statistics"/u);
    assert.match(page, /data-comparison-chart/u);
    assert.match(page, /data-comparison-summary/u);
    assert.match(page, /data-usage-unit="pte"/u);
    assert.match(page, /data-toggle="includeClaudeUsage"/u);
    assert.match(page, /data-claude-group-toggle/u);
    assert.match(page, /data-journal-stream-group-toggle/u);
    assert.doesNotMatch(page, /data-token-breakdown-toggle/u);
    assert.match(page, /data-trusted-device-list/u);
    assert.match(page, /data-device-create/u);
    assert.match(page, /<option value="metropolis">Мегаполис<\/option>/u);
    assert.match(page, /data-metropolis-glass/u);
    assert.match(page, /\/themes\/metropolis\/theme\.css/u);
    assert.match(page, /\/themes\/stormglass\/storm-glass\.js/u);
    assert.match(page, /data-theme-catalog/u);
    assert.match(page, /<option value="magma">Магма<\/option>/u);
    assert.match(page, /<option value="kashyyyk">Kashyyyk<\/option>/u);
    assert.match(page, /<option value="stormglass">Storm<\/option>/u);
    assert.match(page, /<option value="meadow">Луг<\/option>/u);
    assert.match(page, /<option value="lake">Озеро<\/option>/u);
    assert.match(page, /data-surface="desktop"/u);
    assert.match(page, /data-theme-select/u);
    assert.match(page, /data-background-motion-toggle/u);
    assert.match(page, /data-collapse-all/u);
    assert.doesNotMatch(page, /data-rate-limits-slot/u);
    assert.equal(page.match(/data-current-limits=/gu)?.length, 2);
    assert.ok(page.indexOf("data-collapse-all") < page.indexOf("data-theme-select"));
    assert.match(page, /data-connection-quality/u);
    assert.doesNotMatch(page, /Автообновление/u);
    assert.match(page, /<option value="graphite">Графит<\/option>/u);
    assert.match(page, /<option value="reliquary">Diablo<\/option>/u);
    assert.match(page, /data-journal-grouping="stream"/u);
    assert.match(page, /data-journal-grouping="workspace"/u);
    assert.match(page, /data-journal-grouping="month"/u);
    assert.match(page, />Орбита</u);
    assert.match(page, />Туманность</u);
    assert.match(page, />Пульсар</u);
    assert.match(page, />Gothic</u);
    assert.match(page, /<img data-app-mark src="\/agent-hub-mark\.png"/u);
    assert.match(page, /<link rel="icon" type="image\/png" href="\/agent-hub-mark\.png">/u);
    for (const icon of [
      "chats-circle",
      "notebook",
      "arrow-clockwise",
      "plus",
      "magnifying-glass",
      "chat-centered-text",
      "caret-left",
      "stop",
      "git-diff",
      "sliders-horizontal",
      "paperclip",
      "paper-plane-right",
      "list-checks",
      "x",
      "arrows-clockwise",
      "corners-out",
    ]) {
      assert.match(page, new RegExp(`data-phosphor-icon="${icon}"`, "u"), icon);
    }
    assert.match(page, /data-action="annotate-selection"/u);
    assert.doesNotMatch(page, /data-action="annotate"/u);
    const script = await (await fetch(`${address.url}app.js`)).text();
    assert.match(script, /agent-hub-theme/u);
    assert.match(script, /function readThemeCatalog/u);
    assert.match(script, /themeCatalog\.map\(\(theme\) => \[theme\.id, theme\.color\]\)/u);
    assert.match(
      script,
      /SERVER_CONFIG_LEFT_KEYS[\s\S]*?"autoApproveOnStart"[\s\S]*?"codexSandboxMode"[\s\S]*?"guardConcurrentRepositoryWrites"/u,
    );
    assert.match(
      script,
      /SERVER_CONFIG_RIGHT_KEYS[\s\S]*?"contextAutomation\.autoCompactAfterTurn"[\s\S]*?"contextAutomation\.autoRotateAfterCompaction"[\s\S]*?"components\.codexContextCleanup"/u,
    );
    assert.match(
      script,
      /SERVER_CONFIG_ADVANCED_COLUMNS[\s\S]*?"codexRolloutContext\.scanIntervalSeconds", "codexRpcTimeoutSeconds"[\s\S]*?"deferredInputTtlHours", "progressStartDelayMs"[\s\S]*?"deliveryRetryIntervalSeconds", "logMaxFiles"/u,
    );
    assert.match(script, /Странные константы, трогать не рекомендую/u);
    assert.match(script, /server-config-switch-control[\s\S]*?switch-track[\s\S]*?switch-text/u);
    assert.match(script, /entry\.presentation === "access-toggle"/u);
    assert.match(script, /input\.checked \? "danger-full-access" : "workspace-write"/u);
    assert.match(script, /background\.particles/u);
    assert.match(page, /"id":"metropolis","name":"Мегаполис","color":"#050b12"/u);
    assert.match(page, /"aliases":\["taiga-drops"\]/u);
    assert.match(script, /agent-hub-grouping/u);
    assert.match(script, /document\.documentElement\.dataset\.theme/u);
    assert.match(script, /document\.documentElement\.dataset\.grouping/u);
    assert.doesNotMatch(script, /agent-hub-token-breakdown/u);
    assert.doesNotMatch(script, /function applyBreakdown/u);
    assert.match(script, /function comparisonSeriesPicker/u);
    assert.match(script, /data-comparison-series-select/u);
    assert.doesNotMatch(page, /data-stream-collapse-toggle/u);
    assert.match(page, /data-journal-grouping="stream"/u);
    assert.match(page, /data-journal-grouping="workspace"/u);
    assert.doesNotMatch(page, /data-workspace-collapse-toggle/u);
    assert.match(script, /agent-hub-collapse-streams/u);
    assert.doesNotMatch(script, /function applyStreamCollapse/u);
    assert.doesNotMatch(script, /function setStreamsCollapsed/u);
    assert.match(script, /function upgradeLegacyWorkspaceGroups/u);
    assert.match(script, /details\[data-work-log-workspace\]\[open\]/u);
    assert.match(script, /details\[data-work-log-stream\]\[open\]/u);
    assert.match(script, /function decorateLegacyStreamTurns/u);
    assert.match(script, /function taskProfile/u);
    assert.match(script, /\.workLogTaskProfile/u);
    assert.match(script, /Профиль задачи/u);
    assert.match(script, /label: "Навыки"/u);
    assert.match(script, /label: "MCP"/u);
    assert.match(script, /workLogTurnMcpCalls/u);
    assert.match(script, /function taskProfileAccordion/u);
    assert.match(script, /workLogTaskProfileDetailContent/u);
    assert.match(script, /\.dataset\.radarTooltip/u);
    assert.match(script, /data-radar-hit/u);
    assert.match(script, /pointerenter/u);
    assert.match(
      script,
      /telegramMode && mobileTelegramPlatforms\.has\(telegramPlatform\)/u,
    );
    assert.match(script, /layoutViewportWidth\(\) < compactSurfaceWidth/u);
    assert.doesNotMatch(script, /return window\.innerWidth < compactSurfaceWidth/u);
    assert.doesNotMatch(script, /if \(!telegramMode\) return "desktop"/u);
    assert.match(script, /class: "task-runtime"/u);
    assert.match(script, /if \(sameData\(state\.live\.get\(taskId\)/u);
    const taskBoard = await fetch(`${address.url}task-board.js`);
    assert.equal(taskBoard.status, 200);
    assert.match(taskBoard.headers.get("content-type"), /text\/javascript/u);
    assert.match(await taskBoard.text(), /window\.AgentHubTaskBoard = Object\.freeze/u);
    const hubClient = await (await fetch(`${address.url}hub-client.js`)).text();
    assert.match(hubClient, /hub: "HUB"/u);
    assert.match(hubClient, /telegram: "HUB"/u);
    assert.match(hubClient, /desktop: "APP"/u);
    assert.match(hubClient, /cli: "CLI"/u);
    assert.match(hubClient, /pendingSelectionId/u);
    assert.match(hubClient, /history\.replaceState/u);
    assert.match(hubClient, /modelLabel: window\.AgentHubStreamTabs\.streamModelLabel\(task, catalogStream, snapshot\.settings\)/u);
    assert.doesNotMatch(hubClient, /location\.hash\s*=/u);
    assert.match(script, /document\.documentElement\.dataset\.surface = surface/u);
    assert.match(script, /telegram\?\.expand\(\)/u);
    assert.match(page, /data-telegram-fullscreen hidden/u);
    assert.match(script, /telegramFullscreenButton\?\.addEventListener\("click"/u);
    assert.match(script, /telegram\?\.requestFullscreen\?\.\(\)/u);
    assert.match(script, /telegram\?\.exitFullscreen\?\.\(\)/u);
    assert.match(script, /headers\["If-None-Match"\]/u);
    assert.match(script, /response\.status === 304/u);
    assert.match(script, /closest\("\[data-work-log-collapse-turns\]"\)/u);
    assert.match(script, /row\?\.querySelector\("details\[data-work-log-previous-turns\]"\)/u);
    assert.match(script, /window\.addEventListener\("resize", syncSurface\)/u);
    assert.match(script, /data-mobile-expanded/u);
    assert.match(script, /data-mobile-open/u);
    assert.match(script, /button\.hidden = hidden/u);
    assert.match(script, /collapse && surface !== "mobile"/u);
    assert.match(script, /journalRendered/u);
    assert.match(script, /details\[data-work-log-day-section\]\[open\]/u);
    assert.match(script, /collapseAllButton\.addEventListener/u);
    assert.match(script, /agent-hub:journal-open-state:v1/u);
    assert.match(script, /localStorage\.setItem\(OPEN_STATE_KEY/u);
    assert.match(script, /localStorage\.getItem\(OPEN_STATE_KEY\)/u);
    assert.match(script, /persistOpenState\(\)/u);
    assert.match(script, /\/api\/journal\/day/u);
    assert.match(script, /\/api\/journal\/turn/u);
    assert.match(script, /data-lazy-day/u);
    assert.match(script, /data-lazy-turn-id/u);
    const themeIds = [
      "orbit", "nebula", "pulsar", "gothic", "blackhole", "taiga", "metropolis",
      "stormglass", "magma", "meadow", "lake", "graphite", "reliquary",
    ];
    const styles = [
      await (await fetch(`${address.url}styles.css`)).text(),
      ...await Promise.all(themeIds.map(async (theme) => (
        (await (await fetch(`${address.url}themes/${theme}/theme.css`)).text())
          .replaceAll('url("./', 'url("/')
      ))),
    ].join("\n");
    assert.match(styles, /html\[data-theme="nebula"\]/u);
    assert.match(styles, /html\[data-theme="pulsar"\]/u);
    assert.match(styles, /html\[data-theme="gothic"\]/u);
    assert.match(styles, /url\("\/blackhole-blue\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="taiga"\]/u);
    assert.match(styles, /html\[data-theme="metropolis"\] body::after/u);
    assert.match(styles, /url\("\/metropolis-night\.jpg"\)/u);
    assert.match(styles, /url\("\/storm-sea\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="stormglass"\]/u);
    const glass = await (await fetch(`${address.url}themes/metropolis/metropolis-glass.js`)).text();
    assert.match(glass, /vec4 rainLayer/u);
    assert.match(glass, /uniform sampler2D uFogImage/u);
    assert.match(glass, /function createFogTexture/u);
    assert.match(styles, /url\("\/pulsar-aurora\.png"\)/u);
    assert.match(styles, /url\("\/magma-lava-well\.jpg"\)/u);
    assert.match(styles, /url\("\/magma-forged-frame\.png"\)/u);
    assert.match(styles, /url\("\/magma-chat-frame\.png"\)/u);
    assert.match(styles, /url\("\/magma-side-rail\.png"\)/u);
    assert.match(styles, /html\[data-theme="magma"\]/u);
    assert.match(styles, /url\("\/meadow-sun\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="meadow"\]/u);
    assert.match(styles, /url\("\/lake-after-rain\.jpg"\)/u);
    assert.match(styles, /html\[data-theme="lake"\]/u);
    assert.match(styles, /url\("\/gothic-khorinis-harbor\.jpg\?v=[a-f0-9]+"\)/u);
    assert.match(styles, /url\("\/nebula-veil\.jpg"\)/u);
    assert.match(styles, /url\("\/orbit-cartography\.jpg"\)/u);
    assert.match(styles, /url\("\/orbit-mark\.png"\)/u);
    assert.match(styles, /html\[data-theme="graphite"\]/u);
    assert.match(styles, /html\[data-theme="reliquary"\]/u);
    assert.match(styles, /\.server-config-primary\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
    assert.match(styles, /\.server-config-column\s*\{[\s\S]*?grid-template-rows: subgrid/u);
    assert.match(styles, /\.server-config-inline-value\s*\{[\s\S]*?padding-left: 2\.97rem/u);
    assert.match(styles, /\.server-config-advanced-grid\s*\{[\s\S]*?grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/u);
    assert.match(styles, /html\[data-surface="mobile"\] \.server-config-primary\s*\{[\s\S]*?display: flex/u);
    assert.match(styles, /html\[data-surface="mobile"\] \.server-config-advanced-grid\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/u);
    assert.match(styles, /url\("\/forgotten-waypoint\.webp"\)/u);
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?html\[data-theme="reliquary"\] body::before/u);
    assert.match(styles, /--ph-mask-caret-right:/u);
    assert.match(styles, /--ph-mask-caret-double-up:/u);
    assert.match(
      styles,
      /\.chat-overlay-actions > \.chip-button \{[\s\S]*?height: 2\.1rem;[\s\S]*?padding-block: 0;/u,
    );
    assert.match(
      styles,
      /html\[data-surface="mobile"\] \.chat-overlay-actions \{[\s\S]*?z-index: 21;/u,
    );
    assert.match(
      styles,
      /html\[data-surface="mobile"\]\[data-theme\] \.dialog-settings \{[\s\S]*?backdrop-filter: none;[\s\S]*?background: var\(--bg\);/u,
    );
    assert.match(
      styles,
      /\.composer-main > \.chip-button \{[\s\S]*?height: 2\.4rem;[\s\S]*?padding-block: 0;/u,
    );
    assert.match(
      styles,
      /:root:is\([\s\S]*?\[data-theme="orbit"\][\s\S]*?\[data-theme="blackhole"\][\s\S]*?\[data-theme="lake"\][\s\S]*?\[data-theme="orange"\][\s\S]*?\[data-theme="zero"\][\s\S]*?\) \.msg-agent,[\s\S]*?:root\[data-chat-surface="transparent"\]:is\([\s\S]*?\) \.msg-live \{[\s\S]*?background: var\(--card-bg\);/u,
    );
    assert.doesNotMatch(styles, /content:\s*"[▶▼▸▾⌃]"/u);
    assert.doesNotMatch(
      styles,
      /html\[data-theme="graphite"\] \.brand-mark svg\s*\{[^}]*display:\s*none/u,
    );
    assert.doesNotMatch(
      styles,
      /html\[data-theme="graphite"\] \.brand-mark::after\s*\{/u,
    );
    assert.match(
      styles,
      /html\[data-theme="graphite"\][\s\S]*?span\[data-kilo-usage\][\s\S]*?background: transparent;[\s\S]*?color: oklch\(0\.88 0\.003 260\) !important;/u,
    );
    assert.match(
      styles,
      /html\[data-theme="graphite"\] \.journal summary\[data-task-usage\] \{[\s\S]*?background: transparent;[\s\S]*?border-color: transparent;[\s\S]*?border-radius: 0;[\s\S]*?color: var\(--text-faint\);/u,
    );
    assert.match(
      styles,
      /summary\[data-task-usage\] > \[data-usage-label\] \{[\s\S]*?font-size: 0\.64rem;[\s\S]*?letter-spacing: var\(--label-spacing\);[\s\S]*?text-transform: var\(--label-transform\);/u,
    );
    assert.match(styles, /url\("\/rain-shelter\.png"\)/u);
    assert.match(styles, /details\[data-work-log-task-group\]/u);
    assert.match(styles, /summary\[data-work-log-workspace-header\]/u);
    assert.match(styles, /grid-template-columns: 1rem 17\.5rem minmax\(0, 1fr\)/u);
    assert.match(styles, /summary\[data-work-log-stream-summary\]/u);
    assert.match(styles, /span\[data-work-log-stream-title\] button\[data-open-task\]/u);
    assert.match(styles, /\[data-work-log-task-duration\]/u);
    assert.match(styles, /\[data-work-log-task-credits\]/u);
    assert.match(styles, /\[data-work-log-task-profile\]/u);
    assert.match(styles, /\[data-work-log-task-profile-detail\]/u);
    assert.match(styles, /\[data-work-log-task-profile-detail-items\]/u);
    assert.match(styles, /\[data-radar-current\]/u);
    assert.match(styles, /\[data-radar-tooltip\]/u);
    assert.match(styles, /html:is\(\[data-grouping="stream"\], \[data-grouping="workspace"\]\)/u);
    assert.match(styles, /html\[data-surface="mobile"\] \.journal div\[data-work-log-row\]/u);
    assert.match(styles, /span\[data-day-usage-table\]\[data-mobile-expanded\]/u);
    assert.match(styles, /div\[data-work-log-row\]\[data-mobile-open\]/u);
    assert.match(styles, /button\[data-work-log-collapse-turns\]/u);
    assert.match(
      styles,
      /\.journal div\[data-work-log-turn-files\]\s*\{\s*display: none;/u,
    );
    assert.match(
      styles,
      /button\[data-work-log-collapse-turns\]\[hidden\][\s\S]*display: none !important/u,
    );
    assert.match(
      styles,
      /grid-template-columns: auto minmax\(3\.15rem, 1fr\) 7\.4ch 5ch/u,
    );
    assert.match(styles, /"Palatino Linotype"/u);
    assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) 8\.6ch 6ch/u);
    assert.equal((await fetch(`${address.url}missing`)).status, 404);
    assert.equal((await fetch(`${address.url}`, { method: "POST" })).status, 405);

    const events = await fetch(`${address.url}events`, { signal: abort.signal });
    assert.equal(events.status, 200);
    const reader = events.body.getReader();
    const decoder = new TextDecoder();
    let stream = "";
    while (!stream.includes("event: ready")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      stream += decoder.decode(chunk.value, { stream: true });
    }

    journalDatabase.replace(`${DAY_HTML}\n<!-- changed -->`);
    const deadline = Date.now() + 2_000;
    while (!stream.includes("event: journal") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("SSE timeout")), 2_000)),
      ]);
      assert.equal(chunk.done, false);
      stream += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(stream, /event: journal/u);
  } finally {
    abort.abort();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App forwards authenticated control commands to Agent Hub", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-control-"));
  const attachmentDirectory = path.join(directory, "attachments");
  const calls = [];
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    attachmentDirectory,
    controlHandler: async (request) => {
      calls.push(request);
      return { generatedAt: "now" };
    },
  });
  try {
    const address = await server.start();
    const local = await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "snapshot",
        params: { refresh: true },
        commandId: "local-command-1",
      }),
    });
    assert.equal(local.status, 200);
    assert.deepEqual(await local.json(), {
      ok: true,
      result: { generatedAt: "now" },
      receiptId: "local-command-1",
    });
    const snapshot = await fetch(`${address.url}api/snapshot?knownVersion=version-1&compactSnapshot=1&snapshotProtocol=4&conversationsVersion=conversations-1&workspacesVersion=workspaces-1&boardTasksVersion=board-1&messageReceiptsVersion=receipts-1&messagePinsVersion=pins-1`);
    assert.equal(snapshot.status, 200);
    assert.deepEqual(await snapshot.json(), { generatedAt: "now" });
    const [{ context: localContext, ...localCall }, snapshotCall] = calls;
    const { transportReceivedAtMs, ...stableLocalContext } = localContext;
    assert.equal(Number.isSafeInteger(transportReceivedAtMs), true);
    assert.ok(transportReceivedAtMs <= Date.now());
    assert.deepEqual([
      { ...localCall, context: stableLocalContext },
      snapshotCall,
    ], [
      {
        action: "snapshot",
        params: { refresh: true },
        context: { source: "local-mini-app", commandId: "local-command-1" },
      },
      {
        action: "snapshot",
        params: {
          knownVersion: "version-1",
          compactSnapshot: true,
          snapshotProtocol: 4,
          conversationsVersion: "conversations-1",
          workspacesVersion: "workspaces-1",
          boardTasksVersion: "board-1",
          messageReceiptsVersion: "receipts-1",
          messagePinsVersion: "pins-1",
        },
        context: { source: "local-mini-app" },
      },
    ]);

    const externalHeaders = {
      "CF-Connecting-IP": "203.0.113.10",
      "Content-Type": "application/json",
    };
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: externalHeaders,
      body: JSON.stringify({ action: "snapshot", params: {} }),
    })).status, 401);
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        ...externalHeaders,
        Authorization: `tma ${signedInitData()}`,
      },
      body: JSON.stringify({ action: "snapshot", params: {} }),
    })).status, 200);
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "GET",
    })).status, 405);

    const imageBody = Buffer.from("fake-png");
    const upload = await fetch(`${address.url}api/attachment`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: imageBody,
    });
    assert.equal(upload.status, 201);
    const uploaded = await upload.json();
    assert.equal(path.dirname(uploaded.path), attachmentDirectory);
    assert.deepEqual(await readFile(uploaded.path), imageBody);
    const documentUpload = await fetch(`${address.url}api/attachment`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "X-Agent-Hub-File-Name": encodeURIComponent("заметки.txt"),
      },
      body: "plain text",
    });
    assert.equal(documentUpload.status, 201);
    const uploadedDocument = await documentUpload.json();
    assert.equal(uploadedDocument.attachment.name, "заметки.txt");
    assert.equal(uploadedDocument.attachment.type, "text/plain");
    assert.deepEqual(await readFile(uploadedDocument.path, "utf8"), "plain text");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App exposes control failures to the guarded diagnostics boundary", async () => {
  const captured = [];
  const failure = new TypeError("broken control invariant");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    controlHandler: async () => { throw failure; },
    reportUnexpectedError: (error, context) => captured.push({ error, context }),
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "snapshot", params: {} }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(captured, [{
      error: failure,
      context: {
        surface: "web",
        kind: "control",
        component: "mini-app-server",
        action: "control",
      },
    }]);
  } finally {
    await server.close();
  }
});

test("Mini App preserves an expected lifecycle conflict as HTTP 409", async () => {
  const captured = [];
  const conflict = Object.assign(new Error("Workspace has an unresolved run admission"), {
    code: "WORKSPACE_LIFECYCLE_CONFLICT",
    statusCode: 409,
  });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    controlHandler: async () => { throw conflict; },
    reportUnexpectedError: (error, context) => captured.push({ error, context }),
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete-archived-workspace", params: {} }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: "Workspace has an unresolved run admission",
    });
    assert.deepEqual(captured, []);
  } finally {
    await server.close();
  }
});

test("local Mini App downloads and copies files only from configured Workspace roots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspace-file-"));
  const workspace = path.join(directory, "workspace");
  const outside = path.join(directory, "outside.txt");
  const target = path.join(workspace, "result.cfe");
  await mkdir(workspace);
  await writeFile(target, "extension", "utf8");
  await writeFile(outside, "secret", "utf8");
  let copied = "";
  let revealed = "";
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    workspaceFileRoots: [workspace],
    copyWorkspaceFile: async (file) => { copied = file; },
    revealWorkspaceFile: async (file) => { revealed = file; },
  });
  try {
    const address = await server.start();
    const download = await fetch(
      `${address.url}api/workspace-file?path=${encodeURIComponent(`${target}:12`)}`,
    );
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /result\.cfe/u);
    assert.equal(await download.text(), "extension");

    const copy = await fetch(`${address.url}api/workspace-file/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    assert.equal(copy.status, 200);
    assert.equal(copied, await realpath(target));

    const reveal = await fetch(`${address.url}api/workspace-file/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `${target}:12` }),
    });
    assert.equal(reveal.status, 200);
    assert.equal(revealed, await realpath(target));

    const denied = await fetch(
      `${address.url}api/workspace-file?path=${encodeURIComponent(outside)}`,
    );
    assert.equal(denied.status, 404);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public Mini App cannot read local Workspace files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-public-workspace-file-"));
  const target = path.join(directory, "result.cfe");
  await writeFile(target, "extension", "utf8");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    requireTelegramAuth: true,
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    workspaceFileRoots: [directory],
    copyWorkspaceFile: async () => {},
  });
  try {
    const address = await server.start();
    const response = await fetch(
      `${address.url}api/workspace-file?path=${encodeURIComponent(target)}`,
      { headers: { Authorization: `tma ${signedInitData()}` } },
    );
    assert.equal(response.status, 403);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted browser receives one-time File Bridge transfer without generic file access", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-file-bridge-"));
  const target = path.join(directory, "result.cfe");
  await writeFile(target, "extension", "utf8");
  let revealed = "";
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    requireTelegramAuth: true,
    deviceStore: {
      resolveSession: async () => ({ id: "session-1", deviceId: "browser-1" }),
    },
    workspaceFileRoots: [directory],
    revealWorkspaceFile: async (file) => { revealed = file; },
  });
  try {
    const address = await server.start();
    const headers = { Authorization: "device trusted-session", "Content-Type": "application/json" };
    const ticketResponse = await fetch(`${address.url}api/workspace-file/transfer-ticket`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: target }),
    });
    const ticket = await ticketResponse.json();
    const direct = await fetch(
      `${address.url}api/workspace-file?path=${encodeURIComponent(target)}`,
      { headers: { Authorization: "device trusted-session" } },
    );
    const installer = await fetch(`${address.url}api/workspace-file/bridge-installer.ps1`, {
      headers: { Authorization: "device trusted-session" },
    });
    const reveal = await fetch(`${address.url}api/workspace-file/reveal`, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: target }),
    });
    const first = await fetch(new URL(ticket.downloadPath, address.url));
    const second = await fetch(new URL(ticket.downloadPath, address.url));

    assert.equal(ticketResponse.status, 200);
    assert.equal(ticket.ok, true);
    assert.match(ticket.downloadPath, /^\/api\/workspace-file\/transfer\/[A-Za-z0-9_-]{43}$/u);
    assert.equal(direct.status, 403);
    assert.equal(installer.status, 200);
    assert.match(await installer.text(), /agenthub-file/u);
    assert.equal(reveal.status, 200);
    assert.equal(revealed, await realpath(target));
    assert.equal(first.status, 200);
    assert.equal(await first.text(), "extension");
    assert.equal(second.status, 404);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local HTTP ACK retires delivered receipts beyond receipt capacity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-local-control-capacity-"));
  const receiptFile = path.join(directory, "receipts.json");
  let effects = 0;
  const router = createDesktopControlRouter({
    handlers: { mutate: async ({ index }) => ({ index, effect: ++effects }) },
    mutationActions: ["mutate"],
    receiptFile,
    receiptOptions: { maxItems: 100 },
  });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    controlHandler: router.handleDesktopControl,
    onControlResultDelivered: ({ id }) => router.forgetDesktopControl(id),
  });
  try {
    const address = await server.start();
    for (let index = 0; index < 110; index += 1) {
      const commandId = `http-command-${index}`;
      const response = await fetch(`${address.url}api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mutate", params: { index }, commandId }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ok: true,
        result: { index, effect: index + 1 },
        receiptId: commandId,
      });
      const acknowledgement = await fetch(`${address.url}api/control/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId }),
      });
      assert.equal(acknowledgement.status, 200);
      assert.deepEqual(await acknowledgement.json(), { ok: true, retired: true });
    }
    assert.equal(effects, 110);
    assert.deepEqual(JSON.parse(await readFile(receiptFile, "utf8")).records, []);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("trusted Android device session is independent of Telegram user ids", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-auth-"));
  const deviceStore = {
    async resolveSession(token) {
      assert.equal(token, "device-session-token");
      return { id: "local-owner", deviceId: "device-id" };
    },
  };
  let receivedContext = null;
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    allowedUserIds: new Set([42]),
    deviceStore,
    controlHandler: async ({ context }) => {
      receivedContext = context;
      return { connected: true };
    },
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        Authorization: "device device-session-token",
        "CF-Connecting-IP": "203.0.113.10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "snapshot", params: {} }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      result: { connected: true },
    });
    assert.deepEqual(receivedContext, {
      source: "trusted-device",
      userId: "local-owner",
      deviceId: "device-id",
    });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public device authentication endpoints are rate limited per client", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-rate-limit-"));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    requireTelegramAuth: true,
    deviceStore: {
      async pair() { throw new Error("invalid pairing code"); },
      async createChallenge() { throw new Error("invalid device id"); },
      async createSession() { throw new Error("invalid device challenge"); },
    },
  });
  try {
    const address = await server.start();
    const request = () => fetch(`${address.url}api/device/pair`, {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "203.0.113.44",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    for (let index = 0; index < 30; index += 1) {
      assert.equal((await request()).status, 400);
    }
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.match(String(limited.headers.get("retry-after")), /^\d+$/u);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("public authentication limiter stays bounded under many distinct client IPs", () => {
  const limiter = new PublicAuthAttemptLimiter({ capacity: 3, limit: 2, windowMs: 60_000 });
  const startedAt = Date.parse("2026-08-02T12:00:00.000Z");
  assert.equal(limiter.consume("203.0.113.1", startedAt).allowed, true);
  assert.equal(limiter.consume("203.0.113.1", startedAt + 1).allowed, true);
  assert.equal(limiter.consume("203.0.113.1", startedAt + 2).allowed, false);

  for (let index = 2; index <= 40; index += 1) {
    assert.equal(limiter.consume(`203.0.113.${index}`, startedAt + index).allowed, true);
    assert.ok(limiter.size <= 3);
  }

  // The original IP was evicted by the fixed-capacity LRU, while each retained
  // client still has its own independent counter.
  assert.equal(limiter.consume("203.0.113.40", startedAt + 100).allowed, true);
  assert.equal(limiter.consume("203.0.113.40", startedAt + 101).allowed, false);
  assert.equal(limiter.consume("203.0.113.1", startedAt + 102).allowed, true);
  assert.equal(limiter.size, 3);

  // Expiry is handled on the touched bucket without scanning the rest of the
  // Map, and starts a new rate-limit window for that address.
  assert.equal(limiter.consume("203.0.113.40", startedAt + 60_100).allowed, true);
  assert.ok(limiter.size <= 3);
});

test("local Mini App requires a protected session and rejects CSRF-shaped control requests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-local-auth-"));
  const localAccessSecret = "a".repeat(43);
  let calls = 0;
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    localAccessSecret,
    controlHandler: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  try {
    const address = await server.start();
    const request = { action: "snapshot", params: {} };
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(request),
    })).status, 401);
    assert.equal(calls, 0);

    const session = await fetch(`${address.url}api/local-session`, {
      method: "POST",
      headers: {
        Authorization: `local ${localAccessSecret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(session.status, 200);
    const cookie = String(session.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.match(cookie, /^agent_hub_local=/u);
    assert.equal((await fetch(`${address.url}api/local-session`, {
      method: "HEAD",
      headers: { Cookie: cookie },
    })).status, 204);
    assert.equal((await fetch(`${address.url}api/local-session`, { method: "HEAD" })).status, 401);

    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(request),
    })).status, 415);
    assert.equal((await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    })).status, 200);
    assert.equal(calls, 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Mini App reloads a rotated access secret without a server restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-local-secret-rotation-"));
  const secretFile = path.join(directory, "local-web.secret");
  const initialSecret = "a".repeat(43);
  const rotatedSecret = "b".repeat(43);
  await writeFile(secretFile, `${initialSecret}\n`, "utf8");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    localAccessSecret: initialSecret,
    localAccessSecretFile: secretFile,
  });
  try {
    const address = await server.start();
    await writeFile(secretFile, `${rotatedSecret}\n`, "utf8");
    const session = await fetch(`${address.url}api/local-session`, {
      method: "POST",
      headers: {
        Authorization: `local ${rotatedSecret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(session.status, 200);
    assert.match(String(session.headers.get("set-cookie") ?? ""), /^agent_hub_local=/u);
    assert.equal((await fetch(`${address.url}api/local-session`, {
      method: "POST",
      headers: {
        Authorization: `local ${initialSecret}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    })).status, 403);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App serves old days and turn bodies through lazy endpoints", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mini-app-lazy-"));
  const days = Array.from({ length: 30 }, (_, index) => {
    const day = String(30 - index).padStart(2, "0");
    const turnId = `turn-${day}`;
    return [
      "<details data-work-log-day-section>",
      `<summary data-work-log-day><strong>${day}.07.2026</strong></summary>`,
      `<div data-work-log-turn-entry data-work-log-turn-id="${turnId}">`,
      "<details data-work-log-turn-details>",
      `<summary>Ход ${turnId}</summary>`,
      `<div data-work-log-turn-expanded><div>Запрос ${turnId}</div><div>Ответ ${turnId}</div></div>`,
      "</details></div></details>",
    ].join("");
  });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(days.join("\n")),
  });
  try {
    const address = await server.start();
    const index = await (await fetch(`${address.url}api/journal`)).json();
    assert.match(index.html, /data-lazy-day="01\.07\.2026"/u);
    assert.doesNotMatch(index.html, /Ответ turn-01/u);

    const dayResponse = await fetch(
      `${address.url}api/journal/day?date=01.07.2026&version=${encodeURIComponent(index.version)}`,
    );
    assert.equal(dayResponse.status, 200);
    const day = await dayResponse.json();
    assert.match(day.html, /Ход turn-01/u);
    assert.doesNotMatch(day.html, /Ответ turn-01/u);

    const daysResponse = await fetch(
      `${address.url}api/journal/days?version=${encodeURIComponent(index.version)}`,
    );
    assert.equal(daysResponse.status, 200);
    const dayFragments = await daysResponse.json();
    assert.equal(dayFragments.version, index.version);
    assert.equal(Object.keys(dayFragments.days).length, 7);
    assert.equal(dayFragments.nextOffset, 7);

    const boundedDaysResponse = await fetch(
      `${address.url}api/journal/days?version=${encodeURIComponent(index.version)}&limit=2`,
    );
    const boundedDays = await boundedDaysResponse.json();
    assert.equal(Object.keys(boundedDays.days).length, 2);
    assert.equal(boundedDays.nextOffset, 2);

    const turnResponse = await fetch(
      `${address.url}api/journal/turn?id=turn-01&version=${encodeURIComponent(index.version)}`,
    );
    assert.equal(turnResponse.status, 200);
    assert.match((await turnResponse.json()).html, /Ответ turn-01/u);

    assert.equal((await fetch(
      `${address.url}api/journal/day?date=01.07.2026&version=old`,
    )).status, 409);
    assert.equal((await fetch(
      `${address.url}api/journal/days?version=old`,
    )).status, 409);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App serves compact totals first and bounded turn shells on demand", async () => {
  const html = [
    '<details data-work-log-day-section><summary data-work-log-day><strong>01.08.2026</strong></summary>',
    '<details data-work-log-workspace data-work-log-workspace-id="workspace-1"',
    ' data-work-log-workspace-kind="catalog"><summary><strong>Agent HUB</strong></summary>',
    '<details data-work-log-stream data-work-log-stream-id="stream-1">',
    '<summary><span data-work-log-stream-title>Release Manager</span></summary>',
    '<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="thread-1"',
    ' data-work-log-workspace-id="workspace-1" data-work-log-stream-id="stream-1">',
    '<div data-work-log-task-content>Задача</div><div data-work-log-turn-list>',
    '<div data-work-log-turn-entry data-work-log-turn-provider="codex"',
    ' data-work-log-turn-thread-id="thread-1" data-work-log-turn-id="turn-1"',
    ' data-work-log-turn-depth="0" data-work-log-turn-credits="42"',
    ' data-work-log-turn-file-count="3" data-work-log-turn-change-lines="12"',
    ' data-work-log-turn-subagent="0" data-work-log-turn-skills="[&quot;journal&quot;]"',
    ' data-work-log-turn-mcp-calls="1" data-work-log-turn-mcp-tools="[&quot;hub/read&quot;]"',
    ' data-work-log-turn-mcp-failures="0"',
    ' data-work-log-turn-duration-seconds="90"',
    ' data-work-log-turn-completed-at="2026-08-01T12:00:00.000Z">',
    '<details data-work-log-turn-details><summary>Ход 1</summary>',
    '<div data-work-log-turn-expanded>Полная детализация</div></details>',
    "</div></div></div></details>",
    '<details data-work-log-stream data-work-log-stream-id="stream-2">',
    '<summary><span data-work-log-stream-title>Review</span></summary>',
    '<div data-work-log-row data-work-log-provider="codex" data-work-log-thread-id="thread-2"',
    ' data-work-log-workspace-id="workspace-1" data-work-log-stream-id="stream-2">',
    '<div data-work-log-task-content>Проверка</div><div data-work-log-turn-list>',
    '<div data-work-log-turn-entry data-work-log-turn-provider="codex"',
    ' data-work-log-turn-thread-id="thread-2" data-work-log-turn-id="turn-2"',
    ' data-work-log-turn-depth="0" data-work-log-turn-credits="10"',
    ' data-work-log-turn-file-count="9" data-work-log-turn-change-lines="3"',
    ' data-work-log-turn-subagent="0" data-work-log-turn-skills="[]"',
    ' data-work-log-turn-mcp-calls="0" data-work-log-turn-mcp-tools="[]"',
    ' data-work-log-turn-mcp-failures="0" data-work-log-turn-duration-seconds="30"',
    ' data-work-log-turn-completed-at="2026-08-01T11:00:00.000Z">',
    '<details data-work-log-turn-details><summary>Ход 2</summary>',
    '<div data-work-log-turn-expanded>Другая детализация</div></details>',
    "</div></div></div></details></details></details>",
  ].join("");
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(html),
  });
  try {
    const address = await server.start();
    const index = await (await fetch(`${address.url}api/journal`)).json();
    assert.equal(index.summary.buckets.length, 2);
    assert.equal(index.summary.buckets[0].credits, 42);
    assert.equal(Object.hasOwn(index.summary.buckets[0], "fileTouches"), false);
    assert.doesNotMatch(index.html, /Ход 1|Полная детализация/u);

    const response = await fetch(
      `${address.url}api/journal/turns?workspaceId=workspace-1&streamId=stream-1`
      + `&profileMode=stream&limit=200&version=${encodeURIComponent(index.version)}`,
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.equal(page.turns.length, 1);
    assert.equal(page.nextOffset, null);
    assert.match(page.turns[0].html, /Ход 1/u);
    assert.doesNotMatch(page.turns[0].html, /Полная детализация/u);
    assert.equal(page.version, index.version);
    assert.equal(page.profileSummary.buckets.length, 2);
    assert.equal(page.profileSummary.buckets[0].fileTouches, 3);
    assert.equal(page.profileSummary.buckets[1].fileTouches, 9);
    assert.deepEqual(page.profileSummary.buckets[0].skillNames, ["journal"]);
    assert.equal((await fetch(
      `${address.url}api/journal/turns?workspaceId=workspace-1&version=old`,
    )).status, 409);
  } finally {
    await server.close();
  }
});

test("Mini App retains every provider profile for an old requested SQLite Stream", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-profile-cohort-"));
  const database = new JournalDatabase(path.join(directory, "journal.sqlite"));
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
  await database.replaceProjection({
    html: "<main></main>",
    summary: { version: 1, buckets: [...peerBuckets, ...requestedBuckets] },
    entries: [{
      turnRef: "turn-required",
      date: "01.01.2020",
      dayMs: Date.UTC(2020, 0, 1),
      workspaceId: "workspace-required",
      streamId: "stream-required",
      provider: "codex",
      threadId: "thread-required",
      turnId: "turn-required",
      completedAtMs: Date.UTC(2020, 0, 1, 12),
      html: '<div data-work-log-turn-entry data-work-log-turn-id="turn-required">Точный ход</div>',
    }],
  });
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: database,
  });
  try {
    const address = await server.start();
    const index = await (await fetch(`${address.url}api/journal`)).json();
    const response = await fetch(
      `${address.url}api/journal/turns?workspaceId=workspace-required&streamId=stream-required`
      + `&profileMode=stream&version=${encodeURIComponent(index.version)}`,
    );
    assert.equal(response.status, 200);
    const page = await response.json();
    assert.deepEqual(page.turns.map((turn) => turn.turnRef), ["turn-required"]);
    const requested = page.profileSummary.buckets.filter((bucket) => (
      bucket.workspaceId === "workspace-required" && bucket.streamId === "stream-required"
    ));
    assert.deepEqual(requested.map((bucket) => bucket.provider).sort(), ["claude", "codex"]);
    assert.equal(new Set(page.profileSummary.buckets.map((bucket) => (
      `${bucket.workspaceId}\u001f${bucket.streamId}\u001f${bucket.provider}`
    ))).size, page.profileSummary.buckets.length);
    assert.equal(page.profileSummary.buckets.length, 2_050);
    assert.equal(page.profileSummary.truncated, true);
  } finally {
    await server.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Mini App can require Telegram authorization on a dedicated public listener", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-public-mini-app-"));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
    botToken: BOT_TOKEN,
    allowedUserIds: new Set([42]),
    requireTelegramAuth: true,
  });
  try {
    const address = await server.start();
    assert.equal((await fetch(`${address.url}health`)).status, 200);
    assert.equal((await fetch(`${address.url}api/journal`)).status, 401);
    assert.equal((await fetch(`${address.url}api/journal`, {
      headers: { Authorization: `tma ${signedInitData()}` },
    })).status, 200);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate-limit summary is served apart from the lazy journal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-limits-mini-app-"));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(`${LIMITS_HTML}\n${DAY_HTML}`),
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/rate-limits`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.html, /data-work-log-rate-limits/u);
    assert.match(payload.html, /CODEX/u);
    assert.equal(payload.sampledAt, "2026-07-30T02:55:14.512Z");
    // шапке нужен только блок: полный журнал весит на три порядка больше
    assert.ok(payload.html.length < 1_000);
    assert.doesNotMatch(payload.html, /data-work-log-day-section/u);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rate-limit endpoint answers with an empty summary when the journal has none", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-no-limits-mini-app-"));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
  });
  try {
    const address = await server.start();
    const payload = await (await fetch(`${address.url}api/rate-limits`)).json();
    assert.equal(payload.html, "");
    assert.equal(payload.sampledAt, "");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Android update manifest and APK are served from one bounded runtime artifact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mobile-update-"));
  const updateDirectory = path.join(directory, "mobile");
  const apk = Buffer.from("signed-apk-fixture");
  const sha256 = createHash("sha256").update(apk).digest("hex");
  await mkdir(updateDirectory, { recursive: true });
  await writeFile(path.join(updateDirectory, "AgentHub-Mobile.apk"), apk);
  await writeFile(path.join(updateDirectory, "update.json"), JSON.stringify({
    versionCode: 2,
    versionName: "0.2.0",
    sha256,
    bytes: apk.length,
  }));
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(DAY_HTML),
    mobileUpdateDirectory: updateDirectory,
  });
  try {
    const address = await server.start();
    const manifestResponse = await fetch(`${address.url}api/mobile/update`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("cache-control"), /no-store/u);
    assert.deepEqual(await manifestResponse.json(), {
      versionCode: 2,
      versionName: "0.2.0",
      sha256,
      bytes: apk.length,
      downloadUrl: "/api/mobile/update.apk",
    });
    const apkResponse = await fetch(`${address.url}api/mobile/update.apk`);
    assert.equal(apkResponse.status, 200);
    assert.equal(apkResponse.headers.get("content-type"), "application/vnd.android.package-archive");
    assert.deepEqual(Buffer.from(await apkResponse.arrayBuffer()), apk);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("device challenge is bound to the served origin and the session becomes a cookie", async () => {
  const challenges = [];
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    requireTelegramAuth: true,
    deviceStore: {
      async createChallenge(payload) {
        challenges.push(payload);
        return { challengeId: "challenge-id", challenge: "value", expiresAt: Date.now() + 60_000 };
      },
      async createSession() {
        return {
          token: "z".repeat(43),
          expiresAt: Date.now() + 3_600_000,
          device: { id: "device-id" },
        };
      },
    },
  });
  try {
    const address = await server.start();
    await fetch(`${address.url}api/device/challenge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.9",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ deviceId: "device-id", origin: "https://relay.example" }),
    });
    // The client cannot choose the verifier name it will have to sign: the server
    // uses the host and scheme of the request it actually served.
    assert.equal(challenges[0].origin, `https://${new URL(address.url).host}`);

    const session = await fetch(`${address.url}api/device/session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.9",
        "X-Forwarded-Proto": "https",
      },
      body: JSON.stringify({ deviceId: "device-id", challengeId: "challenge-id", signature: "s" }),
    });
    assert.equal(session.status, 200);
    assert.match(
      String(session.headers.get("set-cookie")),
      /^agent_hub_device=z{43}; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Strict; Secure$/u,
    );
  } finally {
    await server.close();
  }
});

test("trusted device authenticates with the HttpOnly session cookie", async () => {
  let receivedContext = null;
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    deviceStore: {
      async resolveSession(token) {
        if (token !== "y".repeat(43)) throw new Error("device session is invalid");
        return { id: "local-owner", deviceId: "device-id" };
      },
    },
    controlHandler: async ({ context }) => {
      receivedContext = context;
      return { connected: true };
    },
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        Cookie: `agent_hub_device=${"y".repeat(43)}`,
        "CF-Connecting-IP": "203.0.113.10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "snapshot", params: {} }),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedContext.source, "trusted-device");
    assert.equal(receivedContext.userId, "local-owner");
  } finally {
    await server.close();
  }
});

test("trusted device cookie authenticates on protected loopback Web", async () => {
  let receivedContext = null;
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    localAccessSecret: "a".repeat(43),
    deviceStore: {
      async resolveSession(token) {
        if (token !== "y".repeat(43)) throw new Error("device session is invalid");
        return { id: "local-owner", deviceId: "device-id" };
      },
    },
    controlHandler: async ({ context }) => {
      receivedContext = context;
      return { connected: true };
    },
  });
  try {
    const address = await server.start();
    const response = await fetch(`${address.url}api/control`, {
      method: "POST",
      headers: {
        Cookie: `agent_hub_device=${"y".repeat(43)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "snapshot", params: {} }),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedContext.source, "trusted-device");
    assert.equal(receivedContext.userId, "local-owner");
  } finally {
    await server.close();
  }
});

test("local Web is served without the third-party Telegram runtime", async () => {
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    allowedUserIds: new Set([42]),
  });
  try {
    const address = await server.start();
    const local = await fetch(address.url);
    const localBody = await local.text();
    assert.doesNotMatch(localBody, /telegram\.org/u);
    assert.doesNotMatch(localBody, /telegram-runtime-bootstrap/u);
    assert.match(local.headers.get("content-security-policy"), /script-src 'self';/u);

    // A request that arrived through the public edge may still be a Mini App.
    const publicPage = await fetch(address.url, {
      headers: { Host: "hub.example", "X-Forwarded-For": "203.0.113.9" },
    });
    const publicBody = await publicPage.text();
    assert.doesNotMatch(publicBody, /telegram\.org/u);
    assert.match(publicBody, /telegram-runtime-bootstrap\.js/u);
    assert.match(
      publicPage.headers.get("content-security-policy"),
      /script-src 'self' https:\/\/telegram\.org/u,
    );
  } finally {
    await server.close();
  }
});

test("a deployment without Telegram never serves the Telegram runtime", async () => {
  const server = new MiniAppServer({
    host: "127.0.0.1",
    port: 0,
    journalDatabase: memoryJournal(),
    telegramRuntime: false,
  });
  try {
    const address = await server.start();
    const response = await fetch(address.url, {
      headers: { Host: "hub.example", "X-Forwarded-For": "203.0.113.9" },
    });
    const body = await response.text();
    assert.doesNotMatch(body, /telegram\.org/u);
    assert.doesNotMatch(body, /telegram-runtime-bootstrap/u);
    assert.match(response.headers.get("content-security-policy"), /script-src 'self';/u);
  } finally {
    await server.close();
  }
});


test("client performance batch uses authenticated bounded common trace ingestion", async () => {
  const spans = []; const secret = "t".repeat(43);
  const server = new MiniAppServer({ host: "127.0.0.1", port: 0,
    journalDatabase: memoryJournal(), localAccessSecret: secret,
    recordCommandTrace: (span) => spans.push(span) });
  try {
    const { url } = await server.start();
    const endpoint = `${url}api/command-trace/client-events`;
    const body = { events: [{ commandId: "ui-test-1", stage: "ui-control", outcome: "succeeded",
      observedAtMs: Date.now(), monotonicDurationMs: 15, metadata: { action: "snapshot", text: "private" } }] };
    const request = (cookie, payload) => fetch(endpoint, { method: "POST",
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(payload) });
    assert.equal((await request(null, body)).status, 401);
    const auth = await fetch(`${url}api/local-session`, { method: "POST",
      headers: { Authorization: `local ${secret}`, "Content-Type": "application/json" }, body: "{}" });
    const cookie = auth.headers.get("set-cookie").split(";", 1)[0];
    assert.equal((await request(cookie, body)).status, 200);
    assert.equal(spans.length, 1); assert.deepEqual(spans[0].metadata, { action: "snapshot" });
    assert.equal((await request(cookie, { events: Array(33).fill(body.events[0]) })).status, 400);
    assert.equal((await request(cookie, { events: [], padding: "x".repeat(33000) })).status, 400);
    assert.equal(spans.length, 1);
  } finally { await server.close(); }
});

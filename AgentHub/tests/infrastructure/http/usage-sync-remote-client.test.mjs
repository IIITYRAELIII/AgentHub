import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalUsageSyncJson,
  normalizeServerUrl,
  usageSyncPushChunks,
  UsageSyncRemoteClient,
} from "../../../src/infrastructure/http/usage-sync-remote-client.mjs";

function response(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

function identityStore() {
  const signed = [];
  return {
    deviceId: "4d500d12-dd09-46ba-bf49-14bce403bfd8",
    toPublic: () => ({
      deviceId: "4d500d12-dd09-46ba-bf49-14bce403bfd8",
      label: "local",
      platform: "win32",
      publicKey: "public",
      createdAt: "2026-08-20T03:28:11.201Z",
    }),
    sign: (message) => {
      signed.push(Buffer.from(message).toString("utf8"));
      return `sig-${signed.length}`;
    },
    signed,
  };
}

test("canonicalUsageSyncJson sorts nested object keys for enrollment signatures", () => {
  assert.equal(
    canonicalUsageSyncJson({ z: 1, a: { d: 2, b: 3 } }),
    '{"a":{"b":3,"d":2},"z":1}',
  );
});

test("normalizeServerUrl accepts only http(s) and removes request-only parts", () => {
  assert.equal(normalizeServerUrl("https://sync.example.test/path/?x=1#fragment"), "https://sync.example.test/path");
  assert.throws(() => normalizeServerUrl("file:///tmp/sync"), /http or https/u);
});

test("enroll signs canonical enrollment payload and posts to the server", async () => {
  const identity = identityStore();
  const calls = [];
  const client = new UsageSyncRemoteClient({
    serverUrl: "https://sync.example.test/",
    identityStore: identity,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ ok: true, deviceId: identity.deviceId });
    },
  });

  const result = await client.enroll("code-1");

  assert.deepEqual(result, { ok: true, deviceId: identity.deviceId });
  assert.equal(calls[0].url, "https://sync.example.test/api/enroll");
  assert.equal(identity.signed[0], canonicalUsageSyncJson({
    code: "code-1",
    identity: identity.toPublic(),
  }));
  assert.equal(JSON.parse(calls[0].options.body).signature, "sig-1");
});

test("push and pull sign the exact transmitted body bytes", async () => {
  const identity = identityStore();
  const calls = [];
  const client = new UsageSyncRemoteClient({
    serverUrl: "http://127.0.0.1:9198",
    identityStore: identity,
    now: () => new Date("2026-08-20T04:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(url.endsWith("/api/snapshot")
        ? { version: 1, events: [] }
        : { ok: true, added: 1 });
    },
  });

  await client.push({ version: 1, deviceId: identity.deviceId, events: [] });
  await client.pull();

  assert.equal(calls[0].url, "http://127.0.0.1:9198/api/usage");
  assert.equal(calls[0].options.headers["X-AgentHub-Device-Id"], identity.deviceId);
  assert.equal(calls[0].options.headers["X-AgentHub-Signature"], "sig-1");
  assert.equal(identity.signed[0], Buffer.from(calls[0].options.body).toString("utf8"));

  assert.equal(calls[1].url, "http://127.0.0.1:9198/api/snapshot");
  assert.equal(calls[1].options.headers["X-AgentHub-Signature"], "sig-2");
  assert.equal(identity.signed[1], Buffer.from(calls[1].options.body).toString("utf8"));
});

test("large usage snapshots are sent as bounded signed idempotent chunks", async () => {
  const identity = identityStore();
  const calls = [];
  const stored = new Set();
  const events = Array.from({ length: 12 }, (_, index) => ({
    eventId: `usage:${String(index).padStart(4, "0")}`,
    deviceId: identity.deviceId,
    payload: "x".repeat(90),
  }));
  const snapshot = { version: 1, deviceId: identity.deviceId, exportedAt: "2026-08-28T09:00:00.000Z", events };
  const maxPushBodyBytes = 420;
  const expectedChunks = usageSyncPushChunks(snapshot, { maxBodyBytes: maxPushBodyBytes });
  let failSecondRequest = true;
  const client = new UsageSyncRemoteClient({
    serverUrl: "https://sync.example.test",
    identityStore: identity,
    maxPushBodyBytes,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (failSecondRequest && calls.length === 2) {
        failSecondRequest = false;
        return response({ error: "temporary" }, { status: 503 });
      }
      let added = 0;
      let unchanged = 0;
      for (const event of JSON.parse(options.body).events) {
        if (stored.has(event.eventId)) unchanged += 1;
        else {
          stored.add(event.eventId);
          added += 1;
        }
      }
      return response({
        ok: true,
        deviceId: identity.deviceId,
        added,
        updated: 0,
        unchanged,
        rejected: 0,
        usageFactSchemaVersion: 2,
      });
    },
  });

  await assert.rejects(client.push(snapshot), /temporary/u);
  const result = await client.push(snapshot);

  assert.ok(expectedChunks.length > 1);
  assert.equal(result.requests, expectedChunks.length);
  assert.equal(result.usageFactSchemaVersion, 2);
  assert.equal(result.added + result.unchanged, events.length);
  assert.deepEqual([...stored], events.map((event) => event.eventId));
  for (const call of calls) {
    assert.equal(call.url, "https://sync.example.test/api/usage");
    assert.ok(Buffer.byteLength(call.options.body) <= maxPushBodyBytes);
  }
  assert.deepEqual(identity.signed, calls.map((call) => Buffer.from(call.options.body).toString("utf8")));
});

test("usage sync rejects one event that cannot fit in a bounded request", () => {
  assert.throws(
    () => usageSyncPushChunks({ version: 1, deviceId: "device", events: [{ payload: "x".repeat(500) }] }, {
      maxBodyBytes: 300,
    }),
    /event exceeds 300 bytes/u,
  );
});

test("incremental pull posts a signed changes request with a revision cursor", async () => {
  const identity = identityStore();
  const calls = [];
  const client = new UsageSyncRemoteClient({
    serverUrl: "http://127.0.0.1:9198",
    identityStore: identity,
    now: () => new Date("2026-08-20T04:10:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ version: 1, serverRevision: 8, events: [] });
    },
  });

  await client.pull({ sinceRevision: 7 });

  assert.equal(calls[0].url, "http://127.0.0.1:9198/api/changes");
  assert.equal(calls[0].options.headers["X-AgentHub-Device-Id"], identity.deviceId);
  assert.equal(calls[0].options.headers["X-AgentHub-Signature"], "sig-1");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    deviceId: identity.deviceId,
    requestedAt: "2026-08-20T04:10:00.000Z",
    sinceRevision: 7,
  });
});

test("incremental pull falls back to a full snapshot against old servers", async () => {
  const identity = identityStore();
  const calls = [];
  const client = new UsageSyncRemoteClient({
    serverUrl: "http://127.0.0.1:9198",
    identityStore: identity,
    now: () => new Date("2026-08-20T04:10:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/changes")) return response({ ok: false, error: "not-found" }, { status: 404 });
      return response({ version: 1, serverRevision: 9, events: [{ eventId: "usage:a" }] });
    },
  });

  const result = await client.pull({ sinceRevision: 7 });

  assert.equal(result.serverRevision, 9);
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), ["/api/changes", "/api/snapshot"]);
  assert.equal(calls[0].options.headers["X-AgentHub-Signature"], "sig-1");
  assert.equal(calls[1].options.headers["X-AgentHub-Signature"], "sig-2");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    deviceId: identity.deviceId,
    requestedAt: "2026-08-20T04:10:00.000Z",
  });
});

test("summary pull requests only dataset metadata", async () => {
  const identity = identityStore();
  const calls = [];
  const client = new UsageSyncRemoteClient({
    serverUrl: "http://127.0.0.1:9198",
    identityStore: identity,
    now: () => new Date("2026-09-07T15:30:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({
        version: 1,
        usageFactSchemaVersion: 2,
        datasetGeneration: "server-generation",
        serverRevision: 8,
        factSummary: { version: 1, count: 3, digest: "sha256:" + "1".repeat(64) },
        events: [],
      });
    },
  });

  const result = await client.summary();

  assert.equal(result.datasetGeneration, "server-generation");
  assert.equal(calls[0].url, "http://127.0.0.1:9198/api/snapshot");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    deviceId: identity.deviceId,
    requestedAt: "2026-09-07T15:30:00.000Z",
    summaryOnly: true,
  });
});

test("createEnrollmentCode signs invite request for enrolled devices", async () => {
  const identity = identityStore();
  const calls = [];
  const client = new UsageSyncRemoteClient({
    serverUrl: "https://sync.example.test",
    identityStore: identity,
    now: () => new Date("2026-08-20T05:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response({ ok: true, code: "invite-code", expiresAtMs: 1780000000000 });
    },
  });

  const result = await client.createEnrollmentCode({ ttlSeconds: 120 });

  assert.equal(result.code, "invite-code");
  assert.equal(calls[0].url, "https://sync.example.test/api/enrollment-code");
  assert.equal(calls[0].options.headers["X-AgentHub-Device-Id"], identity.deviceId);
  assert.equal(calls[0].options.headers["X-AgentHub-Signature"], "sig-1");
  assert.equal(identity.signed[0], Buffer.from(calls[0].options.body).toString("utf8"));
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    deviceId: identity.deviceId,
    requestedAt: "2026-08-20T05:00:00.000Z",
    ttlSeconds: 120,
  });
});

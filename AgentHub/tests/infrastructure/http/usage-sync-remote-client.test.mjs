import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalUsageSyncJson,
  normalizeServerUrl,
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

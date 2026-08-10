import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TrustedDeviceStore } from "../../../src/infrastructure/persistence/trusted-device-store.mjs";

function message({ deviceId, challengeId, challenge }) {
  return ["agent-hub-device-session-v1", deviceId, challengeId, challenge].join("\n");
}

test("trusted device store pairs, authorizes, persists and revokes an Android key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-"));
  const filePath = path.join(directory, "devices.json");
  let now = Date.now();
  const store = new TrustedDeviceStore({ filePath, now: () => now });
  await store.load();
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey("spki", keyPair.publicKey))
    .toString("base64url");
  const pairing = await store.createPairing("42");
  const paired = await store.pair({
    code: pairing.code,
    name: "Test phone",
    platform: "Android",
    publicKey,
  });
  const challenge = await store.createChallenge({ deviceId: paired.device.id });
  const signature = Buffer.from(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    Buffer.from(message({ deviceId: paired.device.id, ...challenge })),
  )).toString("base64url");
  const session = await store.createSession({
    deviceId: paired.device.id,
    challengeId: challenge.challengeId,
    signature,
  });
  assert.equal((await store.resolveSession(session.token)).id, "42");
  assert.equal((await store.list("42")).devices[0].name, "Test phone");
  assert.deepEqual((await store.exportActiveDevices()).map((device) => device.id), [paired.device.id]);

  const restored = new TrustedDeviceStore({ filePath, now: () => now });
  await restored.load();
  assert.equal((await restored.resolveSession(session.token)).deviceId, paired.device.id);
  await restored.revoke("42", paired.device.id);
  assert.deepEqual(await restored.exportActiveDevices(), []);
  await assert.rejects(() => restored.resolveSession(session.token), /invalid|trusted/);
  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.devices[paired.device.id].revokedAt, now);

  now += 1;
});

test("trusted device store removes only revoked legacy diagnostic devices", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-cleanup-"));
  const filePath = path.join(directory, "devices.json");
  const activeId = "018f6c86-3f34-7a31-8f27-16f5b96cce19";
  const revokedId = "018f6c86-3f34-7a31-8f27-16f5b96cce20";
  await writeFile(filePath, JSON.stringify({
    version: 1,
    pairings: {},
    challenges: {},
    sessions: {},
    devices: {
      [activeId]: {
        id: activeId,
        userId: "42",
        name: "Diagnostic temporary device",
        platform: "Browser",
        createdAt: 1,
        revokedAt: null,
      },
      [revokedId]: {
        id: revokedId,
        userId: "42",
        name: "Diagnostic temporary device",
        platform: "Browser",
        createdAt: 1,
        revokedAt: 2,
      },
    },
  }));
  const store = new TrustedDeviceStore({ filePath, now: () => 3 });
  await store.load();
  assert.deepEqual((await store.list("42")).devices.map((device) => device.id), [activeId]);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(filePath, "utf8")).devices), [activeId]);
});

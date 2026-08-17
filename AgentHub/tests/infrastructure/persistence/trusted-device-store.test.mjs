import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TrustedDeviceStore } from "../../../src/infrastructure/persistence/trusted-device-store.mjs";

const ORIGIN = "https://hub.example";

function message({ origin = ORIGIN, deviceId, challengeId, challenge }) {
  return ["agent-hub-device-session-v2", origin, deviceId, challengeId, challenge].join("\n");
}

function legacyMessage({ deviceId, challengeId, challenge }) {
  return ["agent-hub-device-session-v1", deviceId, challengeId, challenge].join("\n");
}

async function signWith(privateKey, value) {
  return Buffer.from(await webcrypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    Buffer.from(value),
  )).toString("base64url");
}

async function pairedDevice(store, { userId = "42" } = {}) {
  const keyPair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey("spki", keyPair.publicKey))
    .toString("base64url");
  const pairing = await store.createPairing(userId);
  const paired = await store.pair({
    code: pairing.code,
    name: "Test phone",
    platform: "Android",
    publicKey,
  });
  return { keyPair, device: paired.device };
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
  const pairing = await store.createPairing("42", { code: "ABCDE-FGHIJ-KLMNO-PQRST" });
  assert.equal(pairing.code, "ABCDE-FGHIJ-KLMNO-PQRST");
  const paired = await store.pair({
    code: pairing.code,
    name: "Test phone",
    platform: "Android",
    publicKey,
  });
  const challenge = await store.createChallenge({ deviceId: paired.device.id, origin: ORIGIN });
  const signature = await signWith(
    keyPair.privateKey,
    message({ deviceId: paired.device.id, ...challenge }),
  );
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

test("device session signature is bound to the verifier origin", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-origin-"));
  const store = new TrustedDeviceStore({ filePath: path.join(directory, "devices.json") });
  await store.load();
  const { keyPair, device } = await pairedDevice(store);

  // A signature made for another endpoint must not open a session here, which is
  // exactly what a relaying verifier would present.
  const relayed = await store.createChallenge({ deviceId: device.id, origin: ORIGIN });
  const relayedSignature = await signWith(
    keyPair.privateKey,
    message({ origin: "https://relay.example", deviceId: device.id, ...relayed }),
  );
  await assert.rejects(() => store.createSession({
    deviceId: device.id,
    challengeId: relayed.challengeId,
    signature: relayedSignature,
  }), /invalid device signature/u);

  // The legacy statement carries no origin at all and is refused by default.
  const legacy = await store.createChallenge({ deviceId: device.id, origin: ORIGIN });
  const legacySignature = await signWith(
    keyPair.privateKey,
    legacyMessage({ deviceId: device.id, ...legacy }),
  );
  await assert.rejects(() => store.createSession({
    deviceId: device.id,
    challengeId: legacy.challengeId,
    signature: legacySignature,
  }), /invalid device signature/u);

  const matching = await store.createChallenge({ deviceId: device.id, origin: ORIGIN });
  const session = await store.createSession({
    deviceId: device.id,
    challengeId: matching.challengeId,
    signature: await signWith(keyPair.privateKey, message({ deviceId: device.id, ...matching })),
  });
  assert.equal((await store.resolveSession(session.token)).deviceId, device.id);
});

test("legacy device sessions are accepted only when the operator allows them", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-legacy-"));
  const store = new TrustedDeviceStore({
    filePath: path.join(directory, "devices.json"),
    allowLegacySessions: true,
  });
  await store.load();
  const { keyPair, device } = await pairedDevice(store);
  const challenge = await store.createChallenge({ deviceId: device.id, origin: ORIGIN });
  const session = await store.createSession({
    deviceId: device.id,
    challengeId: challenge.challengeId,
    signature: await signWith(keyPair.privateKey, legacyMessage({ deviceId: device.id, ...challenge })),
  });
  assert.equal((await store.resolveSession(session.token)).deviceId, device.id);
});

test("local revocation stays queued until a federated store confirms it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-device-revoke-"));
  const filePath = path.join(directory, "devices.json");
  const store = new TrustedDeviceStore({ filePath });
  await store.load();
  const { device } = await pairedDevice(store);
  await store.revoke("42", device.id);
  assert.deepEqual(await store.exportPendingRevocations(), [{ id: device.id, userId: "42" }]);

  // The mark survives a restart, so a Worker that was offline during the revoke
  // is still corrected on the next attach.
  const restored = new TrustedDeviceStore({ filePath });
  await restored.load();
  assert.deepEqual(await restored.exportPendingRevocations(), [{ id: device.id, userId: "42" }]);
  assert.deepEqual(await restored.confirmFederatedRevocation(device.id), { confirmed: true });
  assert.deepEqual(await restored.exportPendingRevocations(), []);
  assert.equal(
    JSON.parse(await readFile(filePath, "utf8")).devices[device.id].federatedRevokePending,
    undefined,
  );
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
  assert.deepEqual(Object.keys(JSON.parse(await readFile(`${filePath}.bak`, "utf8")).devices), [activeId]);
});

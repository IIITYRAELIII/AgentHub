import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
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

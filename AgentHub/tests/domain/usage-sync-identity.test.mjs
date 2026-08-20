import assert from "node:assert/strict";
import test from "node:test";

import {
  isUsageSyncDeviceId,
  legacyUsageSyncDeviceId,
  normalizeDeviceLabel,
  normalizeUsageSyncIdentity,
  publicUsageSyncIdentity,
} from "../../src/domain/usage-sync-identity.mjs";

const validIdentity = {
  deviceId: "7e1d0c0a-2b3c-4d5e-8f90-a1b2c3d4e5f6",
  label: "Основной компьютер",
  platform: "win32",
  publicKey: "MCowBQYDK2VwAyEAabc",
  privateKey: "MC4CAQAwBQYDK2VwBCIEIabc",
  createdAt: "2026-08-20T05:00:00.000Z",
};

test("legacy device id changes when the host or data directory changes", () => {
  const base = legacyUsageSyncDeviceId({ hostname: "WORK-PC", dataDir: "C:/AgentHub/data" });
  assert.equal(base, legacyUsageSyncDeviceId({ hostname: "work-pc", dataDir: "c:/agenthub/data" }));
  assert.notEqual(base, legacyUsageSyncDeviceId({ hostname: "work-pc-2", dataDir: "c:/agenthub/data" }));
  assert.notEqual(base, legacyUsageSyncDeviceId({ hostname: "work-pc", dataDir: "d:/agenthub/data" }));
});

test("device labels stay printable and bounded", () => {
  assert.equal(normalizeDeviceLabel("  Ярик,\tкомпьютер \n"), "Ярик, компьютер");
  assert.equal(normalizeDeviceLabel("сброс\u0000строки"), "сброс строки");
  assert.equal(normalizeDeviceLabel("x".repeat(200)).length, 80);
  assert.equal(normalizeDeviceLabel(null), "");
});

test("identity normalization accepts a complete record", () => {
  const identity = normalizeUsageSyncIdentity(validIdentity);
  assert.equal(identity.deviceId, validIdentity.deviceId);
  assert.equal(identity.label, "Основной компьютер");
  assert.equal(identity.updatedAt, validIdentity.createdAt);
  assert.deepEqual(identity.legacyDeviceIds, []);
});

test("identity normalization rejects records that cannot identify a device", () => {
  assert.equal(normalizeUsageSyncIdentity(null), null);
  assert.equal(normalizeUsageSyncIdentity({ ...validIdentity, deviceId: "agent-hub:0123456789abcdef" }), null);
  assert.equal(normalizeUsageSyncIdentity({ ...validIdentity, publicKey: "" }), null);
  assert.equal(normalizeUsageSyncIdentity({ ...validIdentity, privateKey: "not base64url!" }), null);
});

test("legacy device ids are deduplicated and sorted", () => {
  const identity = normalizeUsageSyncIdentity({
    ...validIdentity,
    legacyDeviceIds: ["agent-hub:bbbb", "agent-hub:aaaa", "agent-hub:bbbb", "  "],
  });
  assert.deepEqual(identity.legacyDeviceIds, ["agent-hub:aaaa", "agent-hub:bbbb"]);
});

test("public identity never exposes the private key", () => {
  const identity = normalizeUsageSyncIdentity(validIdentity);
  const shared = publicUsageSyncIdentity(identity);
  assert.ok(!("privateKey" in shared));
  assert.equal(shared.publicKey, validIdentity.publicKey);
  assert.ok(isUsageSyncDeviceId(shared.deviceId));
});

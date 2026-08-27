import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isUsageSyncDeviceId, legacyUsageSyncDeviceId } from "../../../src/domain/usage-sync-identity.mjs";
import { UsageSyncIdentityStore } from "../../../src/infrastructure/persistence/usage-sync-identity-store.mjs";

async function temporaryRoot() {
  return mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-identity-"));
}

test("identity is issued once and survives reload", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-identity.json");
  try {
    const first = new UsageSyncIdentityStore({ file, dataDir: root, hostname: "work-pc" });
    await first.load();
    const issuedId = first.deviceId;
    assert.ok(isUsageSyncDeviceId(issuedId));
    assert.equal(first.label, "work-pc");
    assert.deepEqual(first.legacyDeviceIds, [
      legacyUsageSyncDeviceId({ hostname: "work-pc", dataDir: root }),
    ]);

    const second = new UsageSyncIdentityStore({ file, dataDir: root, hostname: "renamed-pc" });
    await second.load();
    assert.equal(second.deviceId, issuedId, "renaming the host must not change the device id");
    assert.equal(second.publicKey, first.publicKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupted identity file yields a new identity instead of a derived one", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-identity.json");
  try {
    await writeFile(file, "{ not json", "utf8");
    const store = new UsageSyncIdentityStore({ file, dataDir: root, hostname: "work-pc" });
    await store.load();
    assert.ok(isUsageSyncDeviceId(store.deviceId));
    assert.notEqual(store.deviceId, legacyUsageSyncDeviceId({ hostname: "work-pc", dataDir: root }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device label is editable and persisted without touching the device id", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-identity.json");
  try {
    const store = new UsageSyncIdentityStore({ file, dataDir: root, hostname: "work-pc" });
    await store.load();
    const deviceId = store.deviceId;
    await store.setLabel("  Ярик,\tкомпьютер ");
    assert.equal(store.label, "Ярик, компьютер");

    const reloaded = new UsageSyncIdentityStore({ file, dataDir: root, hostname: "work-pc" });
    await reloaded.load();
    assert.equal(reloaded.label, "Ярик, компьютер");
    assert.equal(reloaded.deviceId, deviceId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device label confirmation is persisted separately from automatic label updates", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-identity.json");
  try {
    const store = new UsageSyncIdentityStore({
      file,
      dataDir: root,
      hostname: "work-pc",
      now: () => new Date("2026-08-21T07:00:00.000Z"),
    });
    await store.load();
    await store.setLabel("suggested-login");
    assert.equal(store.label, "suggested-login");
    assert.equal(store.labelConfirmedAt, "");

    await store.setLabel("SidorukSV", { confirmed: true });
    assert.equal(store.label, "SidorukSV");
    assert.equal(store.labelConfirmedAt, "2026-08-21T07:00:00.000Z");

    const reloaded = new UsageSyncIdentityStore({ file, dataDir: root, hostname: "work-pc" });
    await reloaded.load();
    assert.equal(reloaded.label, "SidorukSV");
    assert.equal(reloaded.labelConfirmedAt, "2026-08-21T07:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("signatures verify against the published public key and the private key stays local", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-identity.json");
  try {
    const store = new UsageSyncIdentityStore({ file, dataDir: root, hostname: "work-pc" });
    await store.load();
    const message = Buffer.from("1755600000000\nPOST\n/api/usage/report\nabc", "utf8");
    const signature = Buffer.from(store.sign(message), "base64url");

    assert.equal(verify(null, message, store.verificationKey(), signature), true);
    assert.equal(
      verify(null, Buffer.from("tampered", "utf8"), store.verificationKey(), signature),
      false,
    );
    assert.ok(!Object.hasOwn(store.toPublic(), "privateKey"));

    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.ok(persisted.privateKey, "the private key is stored locally");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

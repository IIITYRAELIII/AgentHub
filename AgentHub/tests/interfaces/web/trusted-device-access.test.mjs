import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createTrustedDeviceManager,
  createWorkerTrustedDeviceStore,
  resolveTrustedDeviceUserId,
  TrustedDeviceRegistry,
} from "../../../src/interfaces/web/trusted-device-access.mjs";

test("public browser pairing clears stale errors and submits a complete pasted code", () => {
  const auth = readFileSync(new URL("../../../assets/web-app/browser-device-auth.js", import.meta.url), "utf8");
  assert.match(auth, /querySelector\("\.browser-auth\[data-browser-auth\]"\)/u);
  assert.doesNotMatch(auth, /querySelector\("\[data-browser-auth\]"\)/u);
  assert.match(auth, /setStatus\(""\);/u);
  assert.match(auth, /code\.value\.replace\(\/-\/gu, ""\)\.length === PAIRING_CODE_LENGTH/u);
  assert.match(auth, /form\.requestSubmit\(\);/u);
  assert.match(auth, /const REQUEST_TIMEOUT_MS = 15_000;/u);
  assert.match(auth, /signal: controller\.signal/u);
  assert.match(auth, /controller\.signal\.aborted/u);
  assert.match(auth, /Сохраняем ключ в браузере/u);
  assert.match(auth, /Создаём защищённую сессию/u);
  assert.match(auth, /withTimeout\(\s*storeCredential\(credential\)/u);
});

test("Windows Hub prefers IPv4 for Worker calls when IPv6 is unavailable", () => {
  const server = readFileSync(
    new URL("../../../src/composition/agent-hub-composition.mjs", import.meta.url),
    "utf8",
  );
  assert.match(server, /process\.platform === "win32"/u);
  assert.match(server, /dns\.setDefaultResultOrder\("ipv4first"\)/u);
});

test("trusted device user resolution accepts the configured Set", () => {
  const allowed = new Set([42, 84]);
  assert.equal(resolveTrustedDeviceUserId(allowed), "42");
  assert.equal(resolveTrustedDeviceUserId(allowed, { userId: "84" }), "84");
  assert.throws(
    () => resolveTrustedDeviceUserId(allowed, { userId: "99" }),
    /не разрешён/u,
  );
});

test("Android-only Hub uses an isolated local device owner", () => {
  assert.equal(resolveTrustedDeviceUserId(new Set(), null, "local"), "local");
  assert.equal(
    resolveTrustedDeviceUserId(new Set(), { userId: "local" }, "local"),
    "local",
  );
  assert.throws(
    () => resolveTrustedDeviceUserId(new Set(), { userId: "99" }, "local"),
    /не разрешён/u,
  );
});

test("trusted device registry federates management while direct auth stays local", async () => {
  const calls = [];
  const localDevice = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce10",
    userId: "42",
    name: "Direct browser",
    createdAt: 1,
  };
  const workerDevice = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce11",
    name: "Worker browser",
    createdAt: 2,
  };
  const publisher = {
    trustedDevices: async (userId) => {
      calls.push(["worker-list", userId]);
      return { devices: [workerDevice] };
    },
    createDevicePairing: async (userId, options) => {
      calls.push(["worker-pair", userId, options.code]);
      return { code: options.code };
    },
    revokeDevice: async (userId, deviceId) => {
      calls.push(["worker-revoke", userId, deviceId]);
      return { device: workerDevice };
    },
    importDevices: async (userId, devices) => {
      calls.push(["worker-import", userId, devices.map((device) => device.id)]);
      return { imported: devices.length };
    },
  };
  const localStore = {
    list: async (userId) => {
      calls.push(["local-list", userId]);
      return { devices: [localDevice] };
    },
    createPairing: async (userId) => {
      calls.push(["local-pair", userId]);
      return { code: "AAAAA-BBBBB-CCCCC-DDDDD", expiresAt: 3 };
    },
    revoke: async (userId, deviceId) => {
      calls.push(["local-revoke", userId, deviceId]);
      throw new Error("device not found");
    },
    pair: async () => {
      calls.push(["local-auth-pair"]);
      return { device: localDevice };
    },
    exportActiveDevices: async () => [localDevice],
  };
  const registry = new TrustedDeviceRegistry(localStore);
  const manager = createTrustedDeviceManager({ localStore: registry });
  assert.deepEqual(await registry.use(createWorkerTrustedDeviceStore(publisher)), { migrated: 1 });
  assert.deepEqual((await manager.list("42")).devices.map((device) => device.id), [
    workerDevice.id,
    localDevice.id,
  ]);
  assert.equal((await manager.createPairing("42")).workerAvailable, true);
  await manager.revoke("42", workerDevice.id);
  await registry.pair({ code: "AAAAA-BBBBB-CCCCC-DDDDD" });
  assert.deepEqual(calls, [
    ["worker-import", "42", [localDevice.id]],
    ["local-list", "42"],
    ["worker-list", "42"],
    ["local-pair", "42"],
    ["worker-pair", "42", "AAAAA-BBBBB-CCCCC-DDDDD"],
    ["local-revoke", "42", workerDevice.id],
    ["worker-revoke", "42", workerDevice.id],
    ["local-auth-pair"],
  ]);
});

test("trusted device registry keeps local pairing available when Worker is offline", async () => {
  const calls = [];
  const localStore = {
    exportActiveDevices: async () => [{ id: "local-device", userId: "42" }],
    list: async () => {
      calls.push("local-list");
      return { devices: [] };
    },
    createPairing: async () => ({ code: "AAAAA-BBBBB-CCCCC-DDDDD", expiresAt: 1 }),
  };
  const registry = new TrustedDeviceRegistry(localStore);
  const migration = await registry.use({
    importDevices: async () => { throw new Error("offline"); },
    list: async () => { throw new Error("offline"); },
    createPairing: async () => { throw new Error("offline"); },
  });
  assert.equal(migration.migrated, 0);
  assert.match(migration.warning, /offline/u);
  assert.equal((await registry.list("42")).partial, true);
  assert.equal((await registry.createPairing("42")).workerAvailable, false);
  assert.deepEqual(calls, ["local-list"]);
});

test("revoking with an unreachable Worker succeeds locally and replays later", async () => {
  const deviceId = "018f6c86-3f34-7a31-8f27-16f5b96cce12";
  const calls = [];
  let workerOnline = false;
  let pending = [{ id: deviceId, userId: "42" }];
  const localStore = {
    list: async () => ({ devices: [] }),
    revoke: async (userId, id) => {
      calls.push(["local-revoke", userId, id]);
      return { device: { id, revokedAt: 7 } };
    },
    exportActiveDevices: async () => [],
    exportPendingRevocations: async () => pending,
    confirmFederatedRevocation: async (id) => {
      calls.push(["confirm", id]);
      pending = pending.filter((device) => device.id !== id);
      return { confirmed: true };
    },
  };
  const workerStore = {
    importDevices: async () => ({ imported: 0 }),
    list: async () => ({ devices: [] }),
    revoke: async (userId, id) => {
      calls.push(["worker-revoke", userId, id]);
      if (!workerOnline) throw new Error("fetch failed");
      return { device: { id } };
    },
  };
  const registry = new TrustedDeviceRegistry(localStore);
  await registry.use(workerStore);

  // The local store is authoritative, so an unreachable Worker must not turn a
  // completed revocation into a failure the operator would retry by hand.
  const result = await registry.revoke("42", deviceId);
  assert.equal(result.workerPending, true);
  assert.deepEqual(pending, [{ id: deviceId, userId: "42" }]);

  workerOnline = true;
  await registry.list("42");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(pending, []);
  assert.deepEqual(calls.filter(([name]) => name === "confirm"), [["confirm", deviceId]]);
});

test("a device the Worker never learned about is not left queued forever", async () => {
  let pending = [{ id: "018f6c86-3f34-7a31-8f27-16f5b96cce13", userId: "42" }];
  const registry = new TrustedDeviceRegistry({
    list: async () => ({ devices: [] }),
    exportActiveDevices: async () => [],
    exportPendingRevocations: async () => pending,
    confirmFederatedRevocation: async (id) => {
      pending = pending.filter((device) => device.id !== id);
      return { confirmed: true };
    },
  });
  await registry.use({
    importDevices: async () => ({ imported: 0 }),
    list: async () => ({ devices: [] }),
    revoke: async () => {
      throw new Error("device not found");
    },
  });
  assert.deepEqual(pending, []);
});

test("enrollment and revocation are announced out of band", async () => {
  const announced = [];
  const device = { id: "018f6c86-3f34-7a31-8f27-16f5b96cce14", name: "Pixel", platform: "Android 15" };
  const registry = new TrustedDeviceRegistry({
    pair: async () => ({ device }),
    revoke: async () => ({ device }),
    confirmFederatedRevocation: async () => ({ confirmed: true }),
  });
  registry.useNotifier((event) => announced.push(event));

  await registry.pair({ code: "AAAAA-BBBBB-CCCCC-DDDDD" });
  await registry.revoke("42", device.id);
  assert.deepEqual(announced.map(({ event }) => event), ["paired", "revoked"]);
  assert.equal(announced[0].device.name, "Pixel");
  assert.equal(announced[1].userId, "42");
});

test("a failing notifier never breaks device management", async () => {
  const device = { id: "018f6c86-3f34-7a31-8f27-16f5b96cce15", name: "Pixel" };
  const registry = new TrustedDeviceRegistry({
    pair: async () => ({ device }),
    revoke: async () => ({ device }),
  });
  registry.useNotifier(() => {
    throw new Error("Telegram unreachable");
  });
  assert.deepEqual((await registry.pair({})).device.id, device.id);

  registry.useNotifier(async () => {
    throw new Error("Telegram unreachable");
  });
  assert.deepEqual((await registry.revoke("42", device.id)).device.id, device.id);
});

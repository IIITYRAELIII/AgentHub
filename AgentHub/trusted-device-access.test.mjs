import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTrustedDeviceManager, resolveTrustedDeviceUserId } from "./trusted-device-access.mjs";

test("public browser pairing clears stale errors and submits a complete pasted code", () => {
  const auth = readFileSync(new URL("./assets/mini-app/browser-device-auth.js", import.meta.url), "utf8");
  assert.match(auth, /setStatus\(""\);/u);
  assert.match(auth, /code\.value\.replace\(\/-\/gu, ""\)\.length === PAIRING_CODE_LENGTH/u);
  assert.match(auth, /form\.requestSubmit\(\);/u);
});

test("Windows Hub prefers IPv4 for Worker calls when IPv6 is unavailable", () => {
  const server = readFileSync(new URL("./agent-hub-server.mjs", import.meta.url), "utf8");
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

test("trusted device management follows the public Worker when it is enabled", async () => {
  const calls = [];
  const publisher = {
    trustedDevices: async (userId) => calls.push(["worker-list", userId]),
    createDevicePairing: async (userId) => calls.push(["worker-pair", userId]),
    revokeDevice: async (userId, deviceId) => calls.push(["worker-revoke", userId, deviceId]),
  };
  const localStore = {
    list: async (userId) => calls.push(["local-list", userId]),
    createPairing: async (userId) => calls.push(["local-pair", userId]),
    revoke: async (userId, deviceId) => calls.push(["local-revoke", userId, deviceId]),
  };
  const remote = createTrustedDeviceManager({ workerEnabled: true, publisher, localStore });
  await remote.list("42");
  await remote.createPairing("42");
  await remote.revoke("42", "device");
  const local = createTrustedDeviceManager({ localStore });
  await local.list("local");
  assert.deepEqual(calls, [
    ["worker-list", "42"],
    ["worker-pair", "42"],
    ["worker-revoke", "42", "device"],
    ["local-list", "local"],
  ]);
});

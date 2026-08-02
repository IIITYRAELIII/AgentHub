import assert from "node:assert/strict";
import test from "node:test";

import { resolveTrustedDeviceUserId } from "./trusted-device-access.mjs";

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

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

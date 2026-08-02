import assert from "node:assert/strict";
import test from "node:test";

import { e2eTimeoutMs } from "./telegram-harness.mjs";

test("E2E timeout keeps normal platforms unchanged and gives Windows process tests headroom", () => {
  assert.equal(e2eTimeoutMs(8_000, { platform: "linux", environment: {} }), 8_000);
  assert.equal(e2eTimeoutMs(8_000, { platform: "win32", environment: {} }), 24_000);
});

test("E2E timeout multiplier can be overridden for slow or fast environments", () => {
  assert.equal(e2eTimeoutMs(8_000, {
    platform: "win32",
    environment: { TELEGRAM_E2E_TIMEOUT_MULTIPLIER: "1.5" },
  }), 12_000);
  assert.equal(e2eTimeoutMs(8_000, {
    platform: "linux",
    environment: { TELEGRAM_E2E_TIMEOUT_MULTIPLIER: "invalid" },
  }), 8_000);
});

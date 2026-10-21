import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_USAGE_SYNC_SERVER_URL, defaultUsageSyncServerUrl, normalizeUsageSyncServerUrl }
  from "../../src/domain/default-usage-sync-server.mjs";

test("public sync default is unconfigured; explicit environment selects a normalized endpoint", () => {
  assert.equal(DEFAULT_USAGE_SYNC_SERVER_URL, "");
  assert.equal(defaultUsageSyncServerUrl({}), "");
  assert.equal(defaultUsageSyncServerUrl({ AGENT_HUB_USAGE_SYNC_SERVER_URL: " https://sync.example.invalid/journal/ " }),
    "https://sync.example.invalid/journal");
});

test("editable sync URL refuses credentials and non-endpoint inputs without echoing them", () => {
  for (const value of [null, 5, "file:///private", "https://user:secret@example.invalid", "https://example.invalid/?token=secret",
    "https://example.invalid/#secret", "https://example.invalid/\nsecret", "https://example.invalid/\\secret", "x".repeat(2049)]) {
    assert.throws(() => normalizeUsageSyncServerUrl(value), error => !error.message.includes("secret"));
  }
  assert.equal(normalizeUsageSyncServerUrl(""), "");
  assert.equal(normalizeUsageSyncServerUrl("http://localhost:8787/sync"), "http://localhost:8787/sync");
});

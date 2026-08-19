import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalWebviewSession,
  validLocalWebviewSession,
} from "../../../src/interfaces/web/local-webview-session.mjs";

test("VS Code WebView session is short-lived and bound to the local secret", () => {
  const secret = "s".repeat(43);
  const now = Date.UTC(2026, 7, 20, 10, 0, 0);
  const session = createLocalWebviewSession(secret, { now, ttlSeconds: 300 });

  assert.equal(validLocalWebviewSession(session.token, secret, { now: now + 299_000 }), true);
  assert.equal(validLocalWebviewSession(session.token, secret, { now: now + 301_000 }), false);
  assert.equal(validLocalWebviewSession(session.token, "x".repeat(43), { now }), false);
  assert.equal(validLocalWebviewSession(`${session.token.slice(0, -1)}x`, secret, { now }), false);
});

test("VS Code WebView session cannot exceed the maximum lifetime", () => {
  const secret = "s".repeat(43);
  const now = Date.UTC(2026, 7, 20, 10, 0, 0);
  const session = createLocalWebviewSession(secret, { now, ttlSeconds: 86_400 });

  assert.equal(session.expiresAt, now + 15 * 60_000);
  assert.equal(validLocalWebviewSession(session.token, secret, { now: now + 14 * 60_000 }), true);
});

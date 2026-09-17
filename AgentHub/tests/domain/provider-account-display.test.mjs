import assert from "node:assert/strict";
import test from "node:test";
import { providerAccountDisplay, publicAccountDisplay } from "../../src/domain/provider-account-display.mjs";

test("provider status maps to account display without inferring sign-out from missing data", () => {
  assert.deepEqual(providerAccountDisplay("codex", { account: null, requiresOpenaiAuth: true }), { state: "signed-out" });
  assert.deepEqual(providerAccountDisplay("codex", { account: null, requiresOpenaiAuth: false }), { state: "unknown" });
  assert.deepEqual(providerAccountDisplay("claude", { loggedIn: false }), { state: "signed-out" });
  for (const provider of ["codex", "claude"]) assert.deepEqual(providerAccountDisplay(provider, {}), { state: "unknown" });
  assert.deepEqual(providerAccountDisplay("codex", { account: { type: "apiKey", apiKey: "private" } }),
    { state: "signed-in", email: null, method: "apiKey" });
  assert.deepEqual(providerAccountDisplay("claude", { loggedIn: true, email: "me@example.test", authMethod: "claude.ai", orgId: "private" }),
    { state: "signed-in", email: "me@example.test", method: "claude.ai" });
  assert.deepEqual(publicAccountDisplay({ state: "unknown", email: "old@example.test", token: "private" }), { state: "unknown" });
  assert.deepEqual(publicAccountDisplay({ state: "signed-in", email: "bad\nemail", method: "private", token: "private" }),
    { state: "signed-in", email: null, method: null });
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  probeCodexAppServer,
  probeTelegramConnectivity,
  requiresTelegramChecks,
} from "./src/infrastructure/process/doctor-probes.mjs";

const FAKE_CODEX = path.join(import.meta.dirname, "e2e", "fake-codex-app-server.mjs");

test("doctor skips Telegram checks when the component is disabled", () => {
  assert.equal(requiresTelegramChecks({ telegramEnabled: false }), false);
  assert.equal(requiresTelegramChecks({ telegramEnabled: true }), true);
});

test("doctor Telegram probe performs getMe and validates the bot identity", async () => {
  let requestedUrl = "";
  const result = await probeTelegramConnectivity({
    token: "123:test",
    apiBaseUrl: "http://127.0.0.1:8081",
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ ok: true, result: { id: 42, username: "test_bot" } }));
    },
  });
  assert.deepEqual(result, { id: 42, username: "test_bot" });
  assert.equal(requestedUrl, "http://127.0.0.1:8081/bot123:test/getMe");
});

test("doctor Codex probe completes initialize and thread/list handshake", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-doctor-codex-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await probeCodexAppServer({
    command: process.execPath,
    prefixArgs: [FAKE_CODEX, "--state", path.join(directory, "state.json")],
    cwd: directory,
    timeoutMs: 5_000,
  });
  assert.equal(result.userAgent, "fake-codex-e2e");
  assert.equal(result.threadCount, 0);
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSharedDashboardBotPairing } from "../../shared-dashboard-bot-pair.mjs";
import { configureSharedDashboardBotWebhook } from "../../shared-dashboard-bot-webhook.mjs";

test("pairing CLI prints the command returned by the shared bot registry", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-pair-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "secret.txt");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  let output = "";
  const pairing = await createSharedDashboardBotPairing({
    config: {
      sharedDashboardBot: {
        enabled: true,
        publicUrl: "https://hub.example.com/",
        hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce71",
        hubName: "Hub",
        secretFile,
      },
    },
    fetchImpl: async () => Response.json({
      paired: false,
      code: "ABCD-2345",
      expiresAt: Date.now() + 60_000,
    }),
    stdout: { write(value) { output += value; } },
  });
  assert.equal(pairing.code, "ABCD-2345");
  assert.match(output, /\/link ABCD-2345/u);
  assert.equal(output.includes("s".repeat(32)), false);
});

test("webhook CLI reads credentials from files and configures Telegram without returning secrets", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-webhook-cli-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const token = `123456:${"A".repeat(30)}`;
  const webhookSecret = "w".repeat(64);
  const tokenFile = path.join(directory, "token.txt");
  const webhookSecretFile = path.join(directory, "webhook-secret.txt");
  await writeFile(tokenFile, token, "utf8");
  await writeFile(webhookSecretFile, webhookSecret, "utf8");
  const requests = [];

  const result = await configureSharedDashboardBotWebhook({
    publicUrl: "https://hub.example.com",
    tokenFile,
    webhookSecretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return Response.json({ ok: true, result: true });
    },
  });

  assert.deepEqual(result, {
    ok: true,
    webhookUrl: "https://hub.example.com/api/dashboard-bot/webhook",
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /^https:\/\/api\.telegram\.org\/bot\d+:.+\/setWebhook$/u);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    url: result.webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  assert.match(requests[1].url, /\/setMyCommands$/u);
  const commands = JSON.parse(requests[1].options.body).commands;
  assert.equal(commands.length, 6);
  assert.ok(commands.some((command) => command.command === "separate"));
  assert.equal(commands.some((command) => command.command === "undo"), false);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(webhookSecret), false);
});

import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SharedDashboardBotClient,
  signSharedDashboardBotRequest,
} from "../../../src/interfaces/web/shared-dashboard-bot-client.mjs";

test("shared Dashboard bot signs requests, dispatches a Task, and reports its result", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secret = "s".repeat(64);
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  const requests = [];
  const handled = [];
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce60",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Проверить общий бот",
      sourceKey: "shared-dashboard:123",
      sourceDetails: { chatId: "42", messageId: "7" },
    },
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/register")) return Response.json({ paired: false, code: "ABCD-2345" });
    if (url.endsWith("/pull")) return Response.json({ commands: [command] });
    if (url.endsWith("/result")) return Response.json({ ok: true });
    return Response.json({ error: "unexpected request" }, { status: 500 });
  };
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com/",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce61",
    hubName: "Командный Hub",
    secretFile,
    fetchImpl,
    handler: async (request) => {
      handled.push(request);
      return { taskId: "task-1" };
    },
  });

  assert.deepEqual(await client.createPairing(), { paired: false, code: "ABCD-2345" });
  assert.equal(await client.poll(), 1);
  assert.equal(handled.length, 1);
  assert.equal(handled[0].action, "board-task-ingest");
  assert.equal(handled[0].context.source, "shared-dashboard-bot");
  assert.equal(handled[0].params.text, "Проверить общий бот");

  const registration = JSON.parse(requests[0].options.body);
  assert.equal(registration.secret, secret);
  assert.equal(registration.name, "Командный Hub");
  const pull = requests[1];
  const pullBody = pull.options.body;
  assert.deepEqual(JSON.parse(pullBody), { limit: 10, waitMs: 0 });
  const pullTimestamp = pull.options.headers["X-Agent-Hub-Timestamp"];
  const expectedSignature = createHmac("sha256", secret)
    .update([
      pullTimestamp,
      "POST",
      "/api/dashboard-bot/pull",
      createHash("sha256").update(pullBody).digest("hex"),
    ].join("\n"))
    .digest("hex");
  assert.equal(pull.options.headers["X-Agent-Hub-Signature"], expectedSignature);
  assert.equal(pull.options.headers["X-Agent-Hub-Dashboard-Id"], "018f6c86-3f34-7a31-8f27-16f5b96cce61");
  assert.deepEqual(JSON.parse(requests[2].options.body), {
    id: command.id,
    userId: "42",
    ok: true,
    result: { taskId: "task-1" },
  });
});

test("shared Dashboard bot request signature is stable for an explicit timestamp", () => {
  assert.deepEqual(signSharedDashboardBotRequest({
    body: "{}",
    secret: "secret",
    pathname: "/api/dashboard-bot/pull",
    timestamp: 1_700_000_000,
  }), {
    timestamp: 1_700_000_000,
    signature: createHmac("sha256", "secret")
      .update(`1700000000\nPOST\n/api/dashboard-bot/pull\n${createHash("sha256").update("{}").digest("hex")}`)
      .digest("hex"),
  });
});

test("shared Dashboard bot pauses after an empty short poll", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-idle-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  let pulls = 0;
  let firstPull;
  const firstPullSeen = new Promise((resolve) => { firstPull = resolve; });
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce66",
    secretFile,
    retrySeconds: 1,
    fetchImpl: async (url) => {
      if (url.endsWith("/api/dashboard-bot/register")) return Response.json({ paired: true });
      if (url.endsWith("/api/dashboard-bot/pull")) {
        pulls += 1;
        firstPull();
        return Response.json({ commands: [] });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async () => null,
  });
  await client.start();
  await firstPullSeen;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pulls, 1);
  await client.close();
});

test("shared Dashboard bot downloads a screenshot reply before augmenting the Task", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-image-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cce62";
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce63",
    userId: "42",
    action: "board-task-ingest",
    params: {
      replyMessageId: 7,
      sourceDetails: { chatId: 42, userId: 42, messageId: 8 },
      attachments: [`remote-attachment:${attachmentId}`],
    },
  };
  const handled = [];
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce65",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) {
        return new Response(image, {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": String(image.length),
            "X-Agent-Hub-Attachment-Hash": createHash("sha256").update(image).digest("hex"),
            "X-Agent-Hub-File-Name": encodeURIComponent("screenshot.jpg"),
          },
        });
      }
      if (url.endsWith("/api/dashboard-bot/result")) return Response.json({ ok: true });
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async (request) => {
      handled.push(request);
      return { taskId: "task-image" };
    },
  });

  assert.equal(await client.poll(), 1);
  assert.equal(handled[0].params.replyMessageId, 7);
  assert.equal(handled[0].params.attachments.length, 1);
  assert.deepEqual(await readFile(handled[0].params.attachments[0]), image);
});

test("shared Dashboard bot accepts a text reply clarification without a source key", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-reply-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const handled = [];
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce66",
    userId: "42",
    action: "board-task-ingest",
    params: {
      replyMessageId: 7,
      text: "надо сдать..",
      sourceDetails: { chatId: 42, userId: 42, messageId: 8, replyToMessageId: 7 },
    },
  };
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce67",
    secretFile,
    fetchImpl: async (url) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/result")) return Response.json({ ok: true });
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async (request) => { handled.push(request); return { taskId: "task-1" }; },
  });

  assert.equal(await client.poll(), 1);
  assert.equal(handled[0].params.replyMessageId, 7);
  assert.equal(handled[0].params.text, "надо сдать..");
  assert.equal(handled[0].params.sourceKey, undefined);
});

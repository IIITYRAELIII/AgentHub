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

function attachmentChunkTransport(body, {
  contentType = "application/octet-stream",
  hashOverride = "",
  id,
  name = "attachment.bin",
  reorder = false,
} = {}) {
  const chunks = Array.from({ length: Math.ceil(body.length / (16 * 1024)) }, (_, index) => {
    const value = body.subarray(index * 16 * 1024, Math.min(body.length, (index + 1) * 16 * 1024));
    return { index, size: value.length, hash: createHash("sha256").update(value).digest("hex"), value };
  });
  const hash = hashOverride || createHash("sha256").update(body).digest("hex");
  return ({ mode, index }) => {
    if (mode === "manifest") {
      const descriptors = chunks.map(({ value: _value, ...descriptor }) => descriptor);
      return Response.json({
        protocol: "agent-hub-attachment-chunks-v1",
        id,
        size: body.length,
        hash,
        count: chunks.length,
        chunkBytes: 16 * 1024,
        page: 0,
        pageCount: 1,
        contentType,
        name,
        chunks: reorder ? descriptors.toReversed() : descriptors,
      });
    }
    const chunk = chunks[index];
    return new Response(chunk?.value ?? "missing", {
      status: chunk ? 200 : 404,
      headers: chunk ? {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(chunk.size),
        "X-Agent-Hub-Attachment-Protocol": "agent-hub-attachment-chunks-v1",
        "X-Agent-Hub-Attachment-Id": id,
        "X-Agent-Hub-Attachment-Hash": hash,
        "X-Agent-Hub-Chunk-Index": String(chunk.index),
        "X-Agent-Hub-Chunk-Count": String(chunks.length),
        "X-Agent-Hub-Chunk-Hash": chunk.hash,
      } : {},
    });
  };
}

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

test("shared Dashboard bot reports the exact route for a timed out pull", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-timeout-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce69",
    secretFile,
    fetchImpl: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
    handler: async () => null,
  });

  await assert.rejects(
    client.poll(),
    /request \/api\/dashboard-bot\/pull failed: The operation was aborted due to timeout/u,
  );
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

test("shared Dashboard bot close aborts an in-flight result request", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-close-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  let resultStarted;
  const resultSeen = new Promise((resolve) => { resultStarted = resolve; });
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce68",
    secretFile,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/dashboard-bot/register")) return Response.json({ paired: true });
      if (url.endsWith("/api/dashboard-bot/pull")) {
        return Response.json({ commands: [{
          id: "018f6c86-3f34-7a31-8f27-16f5b96cce69",
          userId: "42",
          action: "board-task-ingest",
          params: { text: "Проверить остановку", sourceKey: "shared-dashboard:123" },
        }] });
      }
      if (url.endsWith("/api/dashboard-bot/result")) {
        resultStarted();
        return new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async () => ({ taskId: "task-close" }),
  });

  await client.start();
  await resultSeen;
  await Promise.race([
    client.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 100)),
  ]);
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

test("shared Dashboard bot assembles ordered bounded chunks and verifies the final hash", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-chunks-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cce76";
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce77",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Сохранить большую запись",
      sourceKey: "shared-dashboard:018f6c86-3f34-7a31-8f27-16f5b96cce77",
      attachments: [`remote-attachment:${attachmentId}`],
    },
  };
  const body = Buffer.from(Uint8Array.from({ length: 128 * 1024 + 37 }, (_, index) => index % 251));
  const transport = attachmentChunkTransport(body, { id: attachmentId, name: "voice.oga", contentType: "audio/ogg" });
  const handled = [];
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce78",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) return transport(JSON.parse(options.body));
      if (url.endsWith("/api/dashboard-bot/result")) return Response.json({ ok: true });
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async (request) => { handled.push(request); return { taskId: "task-chunked" }; },
  });

  assert.equal(await client.poll(), 1);
  assert.deepEqual(await readFile(handled[0].params.attachments[0]), body);
});

test("shared Dashboard bot rejects an unordered chunk manifest before any side effect", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-unordered-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cce79";
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce7a",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Повреждённая пачка",
      sourceKey: "shared-dashboard:018f6c86-3f34-7a31-8f27-16f5b96cce7a",
      attachments: [`remote-attachment:${attachmentId}`],
    },
  };
  const transport = attachmentChunkTransport(Buffer.alloc(32 * 1024, 7), { id: attachmentId, reorder: true });
  let handled = 0;
  const results = [];
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce7b",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) return transport(JSON.parse(options.body));
      if (url.endsWith("/api/dashboard-bot/result")) results.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    handler: async () => { handled += 1; return {}; },
  });

  assert.equal(await client.poll(), 1);
  assert.equal(handled, 0);
  assert.equal(results.length, 1);
  assert.match(results[0].error, /unordered attachment chunks/u);
});

test("shared Dashboard bot rejects a chunk set with a false final SHA-256", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-final-hash-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cce7c";
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce7d",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Проверить hash",
      sourceKey: "shared-dashboard:018f6c86-3f34-7a31-8f27-16f5b96cce7d",
      attachments: [`remote-attachment:${attachmentId}`],
    },
  };
  const transport = attachmentChunkTransport(Buffer.alloc(20 * 1024, 9), {
    hashOverride: "0".repeat(64),
    id: attachmentId,
  });
  let handled = 0;
  const results = [];
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce7e",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) return transport(JSON.parse(options.body));
      if (url.endsWith("/api/dashboard-bot/result")) results.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    handler: async () => { handled += 1; return {}; },
  });

  assert.equal(await client.poll(), 1);
  assert.equal(handled, 0);
  assert.equal(results.length, 1);
  assert.match(results[0].error, /damaged attachment/u);
});

test("shared Dashboard bot leaves a timed out screenshot for the next idempotent poll", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-image-retry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cce72";
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce73",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Сохранить задачу со скриншотом",
      sourceKey: "shared-dashboard:456",
      sourceDetails: { chatId: 42, userId: 42, messageId: 9 },
      attachments: [`remote-attachment:${attachmentId}`],
    },
  };
  let attachmentPulls = 0;
  const results = [];
  let handled = 0;
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce75",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) {
        attachmentPulls += 1;
        if (attachmentPulls === 1) {
          const timeout = new Error("The operation was aborted due to timeout");
          timeout.name = "TimeoutError";
          return new Response(new ReadableStream({ start: (controller) => controller.error(timeout) }), {
            headers: {
              "Content-Type": "image/jpeg",
              "Content-Length": String(image.length),
              "X-Agent-Hub-Attachment-Hash": createHash("sha256").update(image).digest("hex"),
              "X-Agent-Hub-File-Name": encodeURIComponent("screenshot.jpg"),
            },
          });
        }
        return new Response(image, {
          headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": String(image.length),
            "X-Agent-Hub-Attachment-Hash": createHash("sha256").update(image).digest("hex"),
            "X-Agent-Hub-File-Name": encodeURIComponent("screenshot.jpg"),
          },
        });
      }
      if (url.endsWith("/api/dashboard-bot/result")) {
        results.push(JSON.parse(options.body));
        return Response.json({ ok: true });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async () => { handled += 1; return { taskId: "task-image-retry" }; },
  });

  await assert.rejects(client.poll(), /command will be retried/u);
  assert.equal(attachmentPulls, 1);
  assert.equal(handled, 0);
  assert.deepEqual(results, []);
});

test("shared Dashboard bot downloads bundle attachments concurrently and preserves their order", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-parallel-attachments-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const attachmentIds = [
    "018f6c86-3f34-7a31-8f27-16f5b96cce92",
    "018f6c86-3f34-7a31-8f27-16f5b96cce93",
  ];
  const bodies = new Map([
    [attachmentIds[0], Buffer.from("first voice")],
    [attachmentIds[1], Buffer.from("second voice")],
  ]);
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce94",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Сохранить пачку с голосовыми",
      sourceKey: "shared-dashboard:123456",
      sourceDetails: { chatId: 42, userId: 42, messageId: 11 },
      attachments: attachmentIds.map((id) => `remote-attachment:${id}`),
    },
  };
  let releaseFirst;
  let releaseSecond;
  let bothStartedResolve;
  const firstResponse = new Promise((resolve) => { releaseFirst = resolve; });
  const secondResponse = new Promise((resolve) => { releaseSecond = resolve; });
  const bothStarted = new Promise((resolve) => { bothStartedResolve = resolve; });
  const started = [];
  const handled = [];
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce95",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) {
        const { id } = JSON.parse(options.body);
        started.push(id);
        if (started.length === attachmentIds.length) bothStartedResolve();
        await (id === attachmentIds[0] ? firstResponse : secondResponse);
        const body = bodies.get(id);
        return new Response(body, {
          headers: {
            "Content-Type": "audio/ogg",
            "Content-Length": String(body.length),
            "X-Agent-Hub-Attachment-Hash": createHash("sha256").update(body).digest("hex"),
            "X-Agent-Hub-File-Name": encodeURIComponent(`${id}.ogg`),
          },
        });
      }
      if (url.endsWith("/api/dashboard-bot/result")) return Response.json({ ok: true });
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async (request) => {
      handled.push(request);
      return { taskId: "task-parallel-attachments" };
    },
  });

  const polling = client.poll();
  let concurrencyTimer;
  try {
    await Promise.race([
      bothStarted,
      new Promise((_, reject) => {
        concurrencyTimer = setTimeout(
          () => reject(new Error("attachment downloads did not start concurrently")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(concurrencyTimer);
  }
  assert.deepEqual(started, attachmentIds);
  releaseSecond();
  await Promise.resolve();
  assert.equal(handled.length, 0);
  releaseFirst();
  assert.equal(await polling, 1);
  assert.deepEqual(
    await Promise.all(handled[0].params.attachments.map((file) => readFile(file, "utf8"))),
    ["first voice", "second voice"],
  );
});

test("shared Dashboard bot does not hold text Tasks behind a stalled attachment", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-lanes-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96ccea2";
  const attachmentCommand = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96ccea3",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Задача со старым вложением",
      sourceKey: "shared-dashboard:100",
      attachments: [`remote-attachment:${attachmentId}`],
    },
  };
  const textCommand = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96ccea4",
    userId: "42",
    action: "board-task-ingest",
    params: { text: "Свежая текстовая задача", sourceKey: "shared-dashboard:101" },
  };
  let releaseAttachment;
  let textHandled;
  const attachmentGate = new Promise((resolve) => { releaseAttachment = resolve; });
  const textHandledPromise = new Promise((resolve) => { textHandled = resolve; });
  const handled = [];
  const body = Buffer.from("attachment");
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96ccea5",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url) => {
      if (url.endsWith("/api/dashboard-bot/pull")) {
        return Response.json({ commands: [attachmentCommand, textCommand] });
      }
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) {
        await attachmentGate;
        return new Response(body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(body.length),
            "X-Agent-Hub-Attachment-Hash": createHash("sha256").update(body).digest("hex"),
            "X-Agent-Hub-File-Name": encodeURIComponent("attachment.bin"),
          },
        });
      }
      if (url.endsWith("/api/dashboard-bot/result")) return Response.json({ ok: true });
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async (request) => {
      handled.push(request.context.commandId);
      if (request.context.commandId === textCommand.id) textHandled();
      return { taskId: `task-${request.context.commandId}` };
    },
  });

  const polling = client.poll();
  await textHandledPromise;
  assert.deepEqual(handled, [textCommand.id]);
  releaseAttachment();
  assert.equal(await polling, 2);
  assert.deepEqual(handled, [textCommand.id, attachmentCommand.id]);
});

test("shared Dashboard bot does not hold attachment Tasks behind another stalled attachment", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-attachment-lanes-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const stalledAttachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cceb2";
  const readyAttachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cceb3";
  const stalledCommand = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cceb4",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Старая голосовая пачка",
      sourceKey: "shared-dashboard:200",
      attachments: [`remote-attachment:${stalledAttachmentId}`],
    },
  };
  const readyCommand = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cceb5",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Свежая пачка со скриншотом",
      sourceKey: "shared-dashboard:201",
      attachments: [`remote-attachment:${readyAttachmentId}`],
    },
  };
  let releaseStalledAttachment;
  let readyHandled;
  const stalledGate = new Promise((resolve) => { releaseStalledAttachment = resolve; });
  const readyHandledPromise = new Promise((resolve) => { readyHandled = resolve; });
  const handled = [];
  const bodies = new Map([
    [stalledAttachmentId, Buffer.from("stalled")],
    [readyAttachmentId, Buffer.from("ready")],
  ]);
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cceb6",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/dashboard-bot/pull")) {
        return Response.json({ commands: [stalledCommand, readyCommand] });
      }
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) {
        const { id } = JSON.parse(options.body);
        if (id === stalledAttachmentId) await stalledGate;
        const body = bodies.get(id);
        return new Response(body, {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(body.length),
            "X-Agent-Hub-Attachment-Hash": createHash("sha256").update(body).digest("hex"),
            "X-Agent-Hub-File-Name": encodeURIComponent(`${id}.bin`),
          },
        });
      }
      if (url.endsWith("/api/dashboard-bot/result")) return Response.json({ ok: true });
      return Response.json({ error: "unexpected request" }, { status: 500 });
    },
    handler: async (request) => {
      handled.push(request.context.commandId);
      if (request.context.commandId === readyCommand.id) readyHandled();
      return { taskId: `task-${request.context.commandId}` };
    },
  });

  const polling = client.poll();
  await readyHandledPromise;
  assert.deepEqual(handled, [readyCommand.id]);
  releaseStalledAttachment();
  assert.equal(await polling, 2);
  assert.deepEqual(handled, [readyCommand.id, stalledCommand.id]);
});

test("shared Dashboard bot leaves an exhausted transient command available for retry", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-image-deferred-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce83",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Не потерять задачу при сетевом сбое",
      sourceKey: "shared-dashboard:789",
      sourceDetails: { chatId: 42, userId: 42, messageId: 10 },
      attachments: ["remote-attachment:018f6c86-3f34-7a31-8f27-16f5b96cce82"],
    },
  };
  let resultRequests = 0;
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce85",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    fetchImpl: async (url) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) {
        const timeout = new Error("The operation was aborted due to timeout");
        timeout.name = "TimeoutError";
        throw timeout;
      }
      if (url.endsWith("/api/dashboard-bot/result")) resultRequests += 1;
      return Response.json({ ok: true });
    },
    handler: async () => ({ taskId: "must-not-run" }),
  });

  await assert.rejects(client.poll(), /command will be retried/u);
  assert.equal(resultRequests, 0);
});

test("shared Dashboard bot bounds one stalled attachment body without an internal retry loop", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-shared-bot-stalled-body-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const secretFile = path.join(directory, "shared-dashboard-bot.secret");
  await writeFile(secretFile, "s".repeat(64), "utf8");
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cce92";
  const command = {
    id: "018f6c86-3f34-7a31-8f27-16f5b96cce93",
    userId: "42",
    action: "board-task-ingest",
    params: {
      text: "Не потерять пакет после VPN-сбоя",
      sourceKey: "shared-dashboard:790",
      sourceDetails: { chatId: 42, userId: 42, messageId: 11 },
      attachments: [`remote-attachment:${attachmentId}`],
    },
  };
  let attachmentPulls = 0;
  let cancelledBodies = 0;
  let handled = 0;
  let resultRequests = 0;
  const client = new SharedDashboardBotClient({
    publicUrl: "https://hub.example.com",
    hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce94",
    secretFile,
    attachmentDirectory: path.join(directory, "attachments"),
    attachmentTimeoutMs: 20,
    fetchImpl: async (url) => {
      if (url.endsWith("/api/dashboard-bot/pull")) return Response.json({ commands: [command] });
      if (url.endsWith("/api/dashboard-bot/attachment/pull")) {
        attachmentPulls += 1;
        return new Response(new ReadableStream({
          cancel() {
            cancelledBodies += 1;
          },
        }), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "1",
            "X-Agent-Hub-Attachment-Hash": "a".repeat(64),
            "X-Agent-Hub-File-Name": encodeURIComponent("stalled.bin"),
          },
        });
      }
      if (url.endsWith("/api/dashboard-bot/result")) resultRequests += 1;
      return Response.json({ ok: true });
    },
    handler: async () => {
      handled += 1;
      return { taskId: "must-not-run" };
    },
  });

  await assert.rejects(client.poll(), /command will be retried/u);
  assert.equal(attachmentPulls, 1);
  assert.equal(cancelledBodies, 1);
  assert.equal(handled, 0);
  assert.equal(resultRequests, 0);
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

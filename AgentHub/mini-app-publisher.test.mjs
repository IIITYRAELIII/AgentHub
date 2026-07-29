import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  compressedJournalChunks,
  MiniAppPublisher,
  signMiniAppControlRequest,
  signMiniAppSyncChunk,
} from "./mini-app-publisher.mjs";

test("Mini App publisher signs and sends the current journal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publisher-"));
  const workLogFile = path.join(root, "WORK_LOG.md");
  const secretFile = path.join(root, "sync.secret");
  const secret = "a".repeat(64);
  await writeFile(workLogFile, "# Глобальный журнал работ\n\n<details open><summary>28.07.2026</summary></details>\n");
  await writeFile(secretFile, secret);
  const requests = [];
  const published = [];
  const publisher = new MiniAppPublisher({
    workLogFile,
    publicUrl: "https://hub.example.test/",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    onPublished: async (url) => published.push(url),
  });
  try {
    assert.equal(await publisher.sync(), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://hub.example.test/api/sync/chunk");
    const body = requests[0].options.body;
    const headers = requests[0].options.headers;
    const timestamp = Number(headers["X-Agent-Hub-Timestamp"]);
    assert.equal(headers["X-Agent-Hub-Encoding"], "gzip");
    assert.deepEqual(headers["X-Agent-Hub-Signature"], signMiniAppSyncChunk({
      body,
      secret,
      syncId: headers["X-Agent-Hub-Sync-Id"],
      index: Number(headers["X-Agent-Hub-Chunk-Index"]),
      count: Number(headers["X-Agent-Hub-Chunk-Count"]),
      encoding: headers["X-Agent-Hub-Encoding"],
      version: headers["X-Agent-Hub-Journal-Version"],
      updatedAt: headers["X-Agent-Hub-Journal-Updated-At"],
      timestamp,
    }).signature);
    const payload = JSON.parse(gunzipSync(body).toString("utf8"));
    assert.match(payload.html, /28\.07\.2026/u);
    assert.equal(published.length, 1);
    await publisher.sync();
    assert.equal(published.length, 1);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher splits a large compressed journal without losing data", async () => {
  const payload = {
    html: Array.from({ length: 10_000 }, (_, index) => `${index}:${"история".repeat(12)}`).join("\n"),
    updatedAt: "2026-07-29T08:00:00.000Z",
    version: "large",
  };
  const { syncId, chunks } = await compressedJournalChunks(payload, {
    chunkBytes: 4_096,
    syncId: "fixed-sync",
  });
  assert.equal(syncId, "fixed-sync");
  assert.ok(chunks.length > 1);
  assert.deepEqual(
    JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8")),
    payload,
  );
});

test("Mini App publisher polls signed controls and posts their result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-publisher-"));
  const secretFile = path.join(root, "sync.secret");
  const secret = "b".repeat(64);
  const id = "018f6c86-3f34-7a31-8f27-16f5b96cce10";
  await writeFile(secretFile, secret);
  const requests = [];
  const handled = [];
  const publisher = new MiniAppPublisher({
    workLogFile: path.join(root, "WORK_LOG.md"),
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/api/control/pull")) {
        return Response.json({
          commands: [{
            id,
            userId: "42",
            action: "open-turn",
            params: { provider: "codex", taskThreadId: "thread", turnId: "turn" },
          }],
        });
      }
      return Response.json({ id, status: "completed" });
    },
    controlHandler: async (request) => {
      handled.push(request);
      return { opened: true };
    },
  });
  try {
    assert.equal(await publisher.pollControl(), 1);
    assert.equal(handled.length, 1);
    assert.equal(handled[0].context.source, "telegram-mini-app");
    assert.equal(handled[0].context.userId, "42");
    assert.equal(requests.length, 2);
    for (const request of requests) {
      const pathname = new URL(request.url).pathname;
      const timestamp = Number(request.options.headers["X-Agent-Hub-Timestamp"]);
      assert.equal(
        request.options.headers["X-Agent-Hub-Signature"],
        signMiniAppControlRequest({
          body: request.options.body,
          secret,
          pathname,
          timestamp,
        }).signature,
      );
    }
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      id,
      userId: "42",
      ok: true,
      result: { opened: true },
    });
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher rejects remote attachments without invoking the handler", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-attachment-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "c".repeat(64));
  let handled = false;
  let postedResult;
  const publisher = new MiniAppPublisher({
    workLogFile: path.join(root, "WORK_LOG.md"),
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/control/pull")) {
        return Response.json({
          commands: [{
            id: "018f6c86-3f34-7a31-8f27-16f5b96cce11",
            userId: "42",
            action: "send-message",
            params: { text: "test", attachments: ["remote.png"] },
          }],
        });
      }
      postedResult = JSON.parse(options.body);
      return Response.json({ ok: true });
    },
    controlHandler: async () => {
      handled = true;
    },
  });
  try {
    assert.equal(await publisher.pollControl(), 1);
    assert.equal(handled, false);
    assert.equal(postedResult.ok, false);
    assert.match(postedResult.error, /invalid remote attachments/iu);
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher materializes a signed remote image inside the allowed attachment directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-image-"));
  const secretFile = path.join(root, "sync.secret");
  const attachmentDirectory = path.join(root, "runtime", "DesktopApp", "attachments");
  const secret = "e".repeat(64);
  const commandId = "018f6c86-3f34-7a31-8f27-16f5b96cce40";
  const attachmentId = "018f6c86-3f34-7a31-8f27-16f5b96cce41";
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const bodyHash = createHash("sha256").update(png).digest("hex");
  await writeFile(secretFile, secret);
  const handled = [];
  const requests = [];
  const publisher = new MiniAppPublisher({
    workLogFile: path.join(root, "WORK_LOG.md"),
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    attachmentDirectory,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/api/control/pull")) {
        return Response.json({
          commands: [{
            id: commandId,
            userId: "42",
            action: "send-message",
            params: {
              text: "Посмотри",
              attachments: [`remote-attachment:${attachmentId}`],
            },
          }],
        });
      }
      if (url.endsWith("/api/control/attachment/pull")) {
        assert.deepEqual(JSON.parse(options.body), {
          id: attachmentId,
          userId: "42",
          commandId,
        });
        return new Response(png, {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(png.length),
            "X-Agent-Hub-Attachment-Hash": bodyHash,
          },
        });
      }
      return Response.json({ ok: true });
    },
    controlHandler: async (request) => {
      handled.push(request);
      return { accepted: true };
    },
  });
  try {
    assert.equal(await publisher.pollControl(), 1);
    assert.equal(handled.length, 1);
    const [localPath] = handled[0].params.attachments;
    assert.equal(path.dirname(localPath), attachmentDirectory);
    assert.equal(path.basename(localPath), `${commandId}-${attachmentId}.png`);
    assert.deepEqual(await readFile(localPath), png);
    assert.deepEqual(JSON.parse(requests.at(-1).options.body), {
      id: commandId,
      userId: "42",
      ok: true,
      result: { accepted: true },
    });
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App publisher executes every claimed command when result delivery is temporarily unavailable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-control-retry-"));
  const secretFile = path.join(root, "sync.secret");
  await writeFile(secretFile, "d".repeat(64));
  const commands = [1, 2].map((suffix) => ({
    id: `018f6c86-3f34-7a31-8f27-16f5b96cce2${suffix}`,
    userId: "42",
    action: "status-details",
    params: {},
  }));
  let pullCount = 0;
  let rejectResults = true;
  const delivered = [];
  const handled = [];
  const publisher = new MiniAppPublisher({
    workLogFile: path.join(root, "WORK_LOG.md"),
    publicUrl: "https://hub.example.test",
    syncSecretFile: secretFile,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/api/control/pull")) {
        pullCount += 1;
        return Response.json({ commands: pullCount === 1 ? commands : [] });
      }
      if (rejectResults) return Response.json({ error: "offline" }, { status: 503 });
      delivered.push(JSON.parse(options.body));
      return Response.json({ ok: true });
    },
    controlHandler: async ({ context }) => {
      handled.push(context.commandId);
      return { ok: true };
    },
  });
  try {
    await assert.rejects(() => publisher.pollControl(), /HTTP 503/u);
    assert.deepEqual(handled, commands.map((command) => command.id));
    rejectResults = false;
    assert.equal(await publisher.pollControl(), 0);
    assert.deepEqual(delivered.map((item) => item.id), commands.map((command) => command.id));
  } finally {
    await publisher.close();
    await rm(root, { recursive: true, force: true });
  }
});

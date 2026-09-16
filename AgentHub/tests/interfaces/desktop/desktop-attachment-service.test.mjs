import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopAttachmentService } from "../../../src/interfaces/desktop/desktop-attachment-service.mjs";
import { createCodexAssistantAttachmentImporter } from "../../../src/providers/codex/codex-assistant-attachments.mjs";
import { createHash, randomUUID } from "node:crypto";
import { acquireAttachmentUploadService } from "../../../src/infrastructure/filesystem/attachment-upload-service.mjs";
import { DesktopControlServer, callDesktopControl } from "../../../src/infrastructure/process/desktop-control.mjs";

test("desktop-only authenticated IPC uploads full parts and shares HTTP upload receipts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-ipc-upload-"));
  const desktop = new DesktopAttachmentService({ runtimeCommandRoot: root, projectRoot: root });
  const server = new DesktopControlServer({ runtimeRoot: root, protectSecret: async () => {},
    handler: ({ params, context }) => desktop.upload(params, context),
  });
  let http;
  try {
    await server.start();
    const request = async (params) => {
      const result = await callDesktopControl("attachment-upload", params, { runtimeRoot: root });
      return { httpStatus: result.status, ...JSON.parse(result.body) };
    };
    const route = "/api/attachment-upload";
    const caps = await request({ path: route });
    assert.equal(caps.protocol, "agent-hub-attachment-upload-v1");
    const bytes = Buffer.alloc(caps.chunkBytes, 65);
    const metadata = { uploadId: randomUUID(), name: "large.txt", type: "text/plain", size: bytes.length + 1 };
    assert.equal((await request({ method: "POST", path: route, body: JSON.stringify(metadata) })).ok, true);
    const part = { method: "PUT", path: `${route}?id=${metadata.uploadId}&index=0`,
      body: bytes.toString("base64"), bodyEncoding: "base64",
      headers: { "X-Agent-Hub-Chunk-Sha256": createHash("sha256").update(bytes).digest("hex") },
    };
    assert.equal((await request(part)).ok, true);
    assert.equal((await request(part)).ok, true);
    // The HTTP listener acquires the same runtime owner, including its queue.
    http = await acquireAttachmentUploadService({ attachmentDirectory: path.join(root, "attachments") });
    assert.deepEqual((await http.service.status("local", metadata.uploadId)).received.map((p) => p.index), [0]);
    const tail = Buffer.from("!");
    await http.service.putChunk("local", metadata.uploadId, 1, tail, createHash("sha256").update(tail).digest("hex"));
    const complete = await request({ method: "POST", path: `${route}?id=${metadata.uploadId}&complete=1` });
    assert.equal(complete.status, "ready");
    assert.deepEqual(await readFile(complete.path), Buffer.concat([bytes, tail]));
    assert.equal((await request({ method: "POST", path: `${route}?id=${metadata.uploadId}&complete=1` })).path, complete.path);
    assert.equal((await request({ path: `${route}?id=${randomUUID()}` })).httpStatus, 404);
    const cancelled = { ...metadata, uploadId: randomUUID() };
    await request({ method: "POST", path: route, body: JSON.stringify(cancelled) });
    assert.equal((await request({ method: "DELETE", path: `${route}?id=${cancelled.uploadId}` })).ok, true);
    assert.equal((await desktop.upload(part, { source: "trusted-device" })).status, 403);
    assert.equal((await desktop.upload({ ...part, body: "a".repeat(4 * Math.ceil(bytes.length / 3) + 4) }, { source: "desktop-control" })).status, 413);
    assert.equal((await desktop.upload({ ...part, body: "!bad" }, { source: "desktop-control" })).status, 400);
    await assert.rejects(callDesktopControl("send-message", { text: "x".repeat(512 * 1024) }, { runtimeRoot: root }), /too large/u);
    await desktop.close();
    assert.equal((await http.service.status("local", metadata.uploadId)).path, complete.path);
  } finally {
    await server.close();
    await desktop.close();
    await http?.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop attachment service validates, describes and opens local images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-attachments-"));
  try {
    const directory = path.join(root, "attachments");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "image-1.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    const service = new DesktopAttachmentService({
      runtimeCommandRoot: root,
      projectRoot: root,
      projectRoots: [root],
    });
    assert.deepEqual(await service.paths([file]), [file]);
    assert.deepEqual(service.descriptors([file]), [{
      id: "image-1.png", name: "image-1.png", type: "image/png", isImage: true,
    }]);
    assert.equal((await service.open({ id: "image-1.png" })).url, "/api/message-attachment/image-1.png");
    assert.equal(service.isLegacyFile(file), true);
    await assert.rejects(() => service.paths([path.join(root, "outside.png")]), /вне каталога/u);
    await assert.rejects(
      () => service.open({ id: "missing.png" }),
      (error) => error.message === "Файл вложения недоступен" && !error.message.includes(root),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop attachment service accepts documents and preserves their names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-attachments-"));
  try {
    const directory = path.join(root, "attachments");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "0123456789abcdef--0J7RgtGH0ZHRgi5wZGY.pdf");
    await writeFile(file, Buffer.from("PDF"));
    const service = new DesktopAttachmentService({
      runtimeCommandRoot: root,
      projectRoot: root,
      projectRoots: [root],
    });
    assert.deepEqual(service.descriptors([file]), [{
      id: path.basename(file),
      name: "Отчёт.pdf",
      type: "application/pdf",
      isImage: false,
    }]);
    assert.equal((await service.open({ id: path.basename(file) })).url, `/api/message-attachment/${path.basename(file)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Desktop attachment service imports generated images from the configured Codex home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-attachments-"));
  try {
    const codexHome = path.join(root, "isolated-codex-home");
    const generated = path.join(codexHome, "generated_images", "thread-1", "exec-1.png");
    await mkdir(path.dirname(generated), { recursive: true });
    await writeFile(generated, Buffer.from("terra-image"));
    const service = new DesktopAttachmentService({
      runtimeCommandRoot: root,
      codexHome,
      projectRoot: root,
      projectRoots: [root],
      assistantAttachmentImporterFactory: createCodexAssistantAttachmentImporter,
    });

    const [attachment] = await service.importCodex([{ type: "generated-path", value: generated }]);

    assert.match(attachment.id, /^codex-generated-[0-9a-f]{64}\.png$/u);
    assert.equal(attachment.name, "Изображение");
    assert.equal(
      (await readFile(path.join(root, "attachments", attachment.id))).toString(),
      "terra-image",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App attachment opening delegates to its authenticated publisher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-attachments-"));
  try {
    const directory = path.join(root, "attachments");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "image-2.jpg");
    const preview = path.join(directory, ".thumbnails", "preview.webp");
    await writeFile(file, Buffer.from([1]));
    const service = new DesktopAttachmentService({
      runtimeCommandRoot: root,
      projectRoot: root,
      workerEnabled: true,
      trustedUserId: () => "user-1",
      publisher: () => ({ publishAttachmentView: (userId, target) => ({ userId, target }) }),
      attachmentThumbnails: { create: async () => ({ file: preview }) },
    });
    assert.deepEqual(await service.open({ id: "image-2.jpg" }, { source: "telegram-mini-app" }), {
      userId: "user-1", target: file,
    });
    assert.deepEqual(await service.open(
      { id: "image-2.jpg", preview: true },
      { source: "telegram-mini-app" },
    ), {
      userId: "user-1", target: preview,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

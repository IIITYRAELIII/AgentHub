import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopAttachmentService } from "../../../src/interfaces/desktop/desktop-attachment-service.mjs";
import { createCodexAssistantAttachmentImporter } from "../../../src/providers/codex/codex-assistant-attachments.mjs";

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

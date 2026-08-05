import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopAttachmentService } from "./src/interfaces/desktop/desktop-attachment-service.mjs";

test("Desktop attachment service validates, describes and opens local images", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-attachments-"));
  try {
    const directory = path.join(root, "DesktopApp", "attachments");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "image-1.png");
    await writeFile(file, Buffer.from([1, 2, 3]));
    const service = new DesktopAttachmentService({
      runtimeCommandRoot: root,
      projectRoot: root,
      projectRoots: [root],
    });
    assert.deepEqual(await service.paths([file]), [file]);
    assert.deepEqual(service.descriptors([file]), [{ id: "image-1.png", name: "image-1.png", type: "image/png" }]);
    assert.equal((await service.open({ id: "image-1.png" })).url, "/api/message-attachment/image-1.png");
    assert.equal(service.isLegacyFile(file), true);
    await assert.rejects(() => service.paths([path.join(root, "outside.png")]), /вне каталога/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Mini App attachment opening delegates to its authenticated publisher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-attachments-"));
  try {
    const directory = path.join(root, "DesktopApp", "attachments");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, "image-2.jpg");
    await writeFile(file, Buffer.from([1]));
    const service = new DesktopAttachmentService({
      runtimeCommandRoot: root,
      projectRoot: root,
      workerEnabled: true,
      trustedUserId: () => "user-1",
      publisher: () => ({ publishAttachmentView: (userId, target) => ({ userId, target }) }),
    });
    assert.deepEqual(await service.open({ id: "image-2.jpg" }, { source: "telegram-mini-app" }), {
      userId: "user-1", target: file,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

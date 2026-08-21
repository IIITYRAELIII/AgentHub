import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AttachmentThumbnailService } from "../../src/infrastructure/media/attachment-thumbnail-service.mjs";

test("Attachment thumbnails are generated once and reused from the disk cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-thumbnail-"));
  try {
    const attachments = path.join(root, "attachments");
    const source = path.join(attachments, "image-1.png");
    await mkdir(attachments, { recursive: true });
    await writeFile(source, Buffer.from("original-image"));
    let generations = 0;
    const service = new AttachmentThumbnailService({
      attachmentRoot: attachments,
      generateThumbnail: async ({ target }) => {
        generations += 1;
        await writeFile(target, Buffer.from("small-webp"));
      },
    });
    const [first, concurrent] = await Promise.all([
      service.create(source),
      service.create(source),
    ]);
    const cached = await service.create(source);
    assert.equal(generations, 1);
    assert.equal(first.file, concurrent.file);
    assert.equal(first.file, cached.file);
    assert.equal(first.type, "image/webp");
    assert.match(first.etag, /^"thumbnail-[a-f0-9]{32}"$/u);
    assert.equal(path.dirname(first.file), path.join(attachments, ".thumbnails"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  attachmentMetadataFromId,
  createAttachmentStorageName,
  messageInputWithAttachments,
} from "../../src/domain/attachment-files.mjs";

test("attachment storage keeps a safe opaque id and a Unicode display name", () => {
  const id = createAttachmentStorageName("Отчёт за июль.pdf", "01234567-89ab-cdef-0123-456789abcdef");
  assert.equal(path.basename(id), id);
  assert.deepEqual(attachmentMetadataFromId(id), {
    id,
    name: "Отчёт за июль.pdf",
    type: "application/pdf",
    isImage: false,
  });
});

test("attachment storage names stay below the portable filesystem limit", () => {
  const id = createAttachmentStorageName(`${"Очень-длинное-имя-".repeat(40)}.docx`, "a".repeat(100));
  assert.ok(Buffer.byteLength(id, "utf8") <= 240);
  assert.equal(attachmentMetadataFromId(id)?.type,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("document inputs reach the agent as paths without exposing binary data", () => {
  const file = path.resolve("fixtures", "Требования.pdf");
  const input = messageInputWithAttachments("Проверь файл", [file], [{
    name: "Требования.pdf",
    type: "application/pdf",
  }]);
  assert.match(input[0].text, /# Files mentioned by the user:/u);
  assert.match(input[0].text, /## Требования\.pdf:/u);
  assert.match(input[0].text, /Проверь файл/u);
  assert.deepEqual(input[1], { type: "localFile", path: file });
});

test("image inputs retain the native Codex localImage contract", () => {
  const file = path.resolve("fixtures", "screen.png");
  assert.deepEqual(messageInputWithAttachments("Проверь", [file], [{
    name: "screen.png",
    type: "image/png",
  }]), [
    { type: "text", text: "Проверь" },
    { type: "localImage", path: file },
  ]);
});

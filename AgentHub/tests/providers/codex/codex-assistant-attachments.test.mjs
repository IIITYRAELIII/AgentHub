import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAssistantAttachmentImporter } from "../../../src/providers/codex/codex-assistant-attachments.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-assistant-images-"));
  const generated = path.join(root, "generated");
  const viewed = path.join(root, "viewed");
  const clipboard = path.join(root, "clipboard");
  const attachments = path.join(root, "attachments");
  await Promise.all([generated, viewed, clipboard, attachments].map((directory) => (
    mkdir(directory, { recursive: true })
  )));
  return {
    root,
    generated,
    viewed,
    clipboard,
    attachments,
    importer: createCodexAssistantAttachmentImporter({
      attachmentRoot: attachments,
      temporaryRoot: clipboard,
      generatedImageRoot: generated,
      viewImageRoots: [viewed],
    }),
  };
}

test("assistant image importer creates durable opaque copies for generated, displayed and viewed images", async () => {
  const state = await fixture();
  try {
    const generatedFile = path.join(state.generated, "generation.png");
    const displayedFile = path.join(state.viewed, "displayed.webp");
    const viewedFile = path.join(state.viewed, "preview.jpg");
    await writeFile(generatedFile, Buffer.from("generated"));
    await writeFile(displayedFile, Buffer.from("displayed"));
    await writeFile(viewedFile, Buffer.from("viewed"));

    const result = await state.importer([
      { type: "generated-path", value: generatedFile },
      { type: "display-path", value: displayedFile },
      { type: "view-path", value: viewedFile },
    ]);

    assert.equal(result.length, 3);
    assert.equal(result[0].name, "Изображение");
    assert.equal(result[0].type, "image/png");
    assert.match(result[0].id, /^codex-generated-[0-9a-f]{64}\.png$/u);
    assert.equal(result[1].type, "image/webp");
    assert.match(result[1].id, /^codex-displayed-[0-9a-f]{64}\.webp$/u);
    assert.equal(result[2].type, "image/jpeg");
    assert.match(result[2].id, /^codex-viewed-[0-9a-f]{64}\.jpg$/u);
    assert.equal((await readFile(path.join(state.attachments, result[0].id))).toString(), "generated");
    assert.equal((await readFile(path.join(state.attachments, result[1].id))).toString(), "displayed");
    assert.equal((await readFile(path.join(state.attachments, result[2].id))).toString(), "viewed");
    assert.equal(JSON.stringify(result).includes(generatedFile), false);
    assert.equal(JSON.stringify(result).includes(viewedFile), false);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("assistant image importer materializes a data URL without returning it to the client", async () => {
  const state = await fixture();
  try {
    const dataUrl = `data:image/png;base64,${Buffer.from("inline").toString("base64")}`;
    const [result] = await state.importer([{ type: "data", value: dataUrl }]);

    assert.match(result.id, /^codex-inline-[0-9a-f]{64}\.png$/u);
    assert.equal(result.name, "Изображение");
    assert.equal((await readFile(path.join(state.attachments, result.id))).toString(), "inline");
    assert.doesNotMatch(JSON.stringify(result), /data:image|base64/iu);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("assistant image importer returns a safe placeholder for a missing private image", async () => {
  const state = await fixture();
  try {
    const missing = path.join(state.viewed, "missing.png");
    const [result] = await state.importer([{ type: "view-path", value: missing }]);

    assert.equal(result.missing, true);
    assert.equal(result.name, "Изображение");
    assert.match(result.id, /^codex-viewed-[0-9a-f]{64}\.png$/u);
    assert.doesNotMatch(JSON.stringify(result), /missing\.png|viewed[\\/]/iu);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("assistant image importer keeps a safe generated-output placeholder when its source is missing", async () => {
  const state = await fixture();
  try {
    const missing = path.join(state.generated, "missing-output.png");
    const [result] = await state.importer([{ type: "generated-path", value: missing }]);

    assert.equal(result.missing, true);
    assert.equal(result.name, "Изображение");
    assert.match(result.id, /^codex-generated-[0-9a-f]{64}\.png$/u);
    assert.doesNotMatch(JSON.stringify(result), /missing-output\.png|generated[\\/]/iu);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("assistant image importer reuses its durable copy after the source disappears", async () => {
  const state = await fixture();
  try {
    const source = path.join(state.generated, "generated.png");
    await writeFile(source, Buffer.from("generated"));
    const first = await state.importer([{ type: "generated-path", value: source }]);
    await unlink(source);
    const restored = await state.importer([{ type: "generated-path", value: source }]);
    assert.deepEqual(restored, first);
    assert.equal(restored[0].missing, undefined);
    assert.equal((await readFile(path.join(state.attachments, restored[0].id))).toString(), "generated");
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

test("assistant image importer rejects a service path outside its allowlist", async () => {
  const state = await fixture();
  try {
    const outside = path.join(state.root, "outside.png");
    await writeFile(outside, Buffer.from("outside"));
    assert.deepEqual(await state.importer([{ type: "view-path", value: outside }]), []);
  } finally {
    await rm(state.root, { recursive: true, force: true });
  }
});

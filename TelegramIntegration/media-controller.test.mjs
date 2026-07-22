import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MediaController } from "./media-controller.mjs";

function controller(dataDir, overrides = {}) {
  return new MediaController({
    config: {
      dataDir,
      ttsEnabled: true,
      ttsButtonMinChars: 4,
      ...overrides,
    },
    token: "test",
    integrationRoot: dataDir,
    telegram: async () => ({}),
    sendMessage: async () => {},
    startTurn: async () => {},
    activeProjectRoot: () => dataDir,
    stopProcessTree: async () => {},
  });
}

test("speech text store persists and reloads buttons", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "media-controller-"));
  const first = controller(dataDir);
  const id = first.rememberSpeechText("Привет, мир");
  await first.waitForWrites();
  assert.equal(first.speechText(id), "Привет, мир");
  assert.match(await readFile(path.join(dataDir, "speech-texts.json"), "utf8"), /Привет, мир/);

  const second = controller(dataDir);
  await second.load();
  assert.equal(second.speechText(id), "Привет, мир");
});

test("speech button policy rejects disabled and short text", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "media-controller-policy-"));
  assert.equal(controller(dataDir).rememberSpeechText("abc"), null);
  assert.equal(controller(dataDir, { ttsEnabled: false }).rememberSpeechText("long enough"), null);
});

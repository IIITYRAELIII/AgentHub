import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FailedTelegramUpdateStore } from "../../../src/infrastructure/persistence/failed-update-store.mjs";

test("failed Telegram updates are durable and deduplicated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "failed-telegram-updates-"));
  try {
    const store = new FailedTelegramUpdateStore({ directoryPath: root, now: () => 1_000 });
    await store.add({ update_id: 7, message: { text: "hello" } }, new Error("boom"));
    await store.add({ update_id: 7, message: { text: "hello" } }, new Error("again"));
    const restored = new FailedTelegramUpdateStore({ directoryPath: root });
    assert.equal(await restored.load(), 1);
    assert.equal(restored.values()[0].error, "boom");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt failed updates are quarantined", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "failed-telegram-updates-corrupt-"));
  try {
    await writeFile(path.join(root, "bad.json"), "{broken", "utf8");
    const store = new FailedTelegramUpdateStore({ directoryPath: root, now: () => 2_000 });
    assert.equal(await store.load(), 0);
    assert.equal((await readdir(root)).some((name) => name.includes(".invalid-2000")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

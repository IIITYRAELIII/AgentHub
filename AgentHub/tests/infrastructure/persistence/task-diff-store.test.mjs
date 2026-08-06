import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskDiffStore } from "../../../src/infrastructure/persistence/task-diff-store.mjs";

test("task diffs survive restart and evict the oldest entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-store-"));
  const filePath = path.join(root, "task-diffs.json");
  try {
    const first = new TaskDiffStore({ filePath, limit: 2 });
    await first.load();
    await first.set("one", "diff 1");
    await first.set("two", "diff 2");
    await first.set("three", "diff 3");

    const restored = new TaskDiffStore({ filePath, limit: 2 });
    await restored.load();
    assert.equal(restored.get("one"), undefined);
    assert.equal(restored.get("two"), "diff 2");
    assert.equal(restored.get("three"), "diff 3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt optional diff cache does not prevent startup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "telegram-task-diff-store-corrupt-"));
  const filePath = path.join(root, "task-diffs.json");
  try {
    await writeFile(filePath, "{broken", "utf8");
    const store = new TaskDiffStore({ filePath });
    await store.load();
    assert.equal(store.get("missing"), undefined);
    store.remember("live", "temporary");
    assert.equal(store.get("live"), "temporary");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

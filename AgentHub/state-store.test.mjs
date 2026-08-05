import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJsonWithBackup, writeTextAtomic } from "./src/infrastructure/persistence/state-store.mjs";

test("writeTextAtomic replaces the file and removes its temporary file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-state-"));
  const filePath = path.join(directory, "state.json");
  const temporaryFile = path.join(directory, "state.tmp");
  try {
    await writeFile(filePath, "old", "utf8");
    await writeTextAtomic(filePath, "new", { temporaryFile });
    assert.equal(await readFile(filePath, "utf8"), "new");
    await assert.rejects(readFile(temporaryFile, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writeTextAtomic uses distinct default temporary files for concurrent writers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-state-concurrent-"));
  const filePath = path.join(directory, "state.json");
  try {
    await Promise.all(Array.from({ length: 10 }, (_, index) => (
      writeTextAtomic(filePath, `value-${index}`)
    )));
    assert.match(await readFile(filePath, "utf8"), /^value-\d+$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writeTextAtomic retries transient Windows sharing violations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-state-retry-"));
  const filePath = path.join(directory, "state.json");
  const temporaryFile = path.join(directory, "state.tmp");
  let attempts = 0;
  try {
    await writeTextAtomic(filePath, "new", {
      temporaryFile,
      retryDelaysMs: [0, 0],
      renameImpl: async (source, target) => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
        const { rename } = await import("node:fs/promises");
        await rename(source, target);
      },
    });
    assert.equal(attempts, 3);
    assert.equal(await readFile(filePath, "utf8"), "new");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("writeTextAtomic syncs content before rename and the parent after rename", async () => {
  const events = [];
  await writeTextAtomic("C:\\state\\state.json", "new", {
    temporaryFile: "C:\\state\\state.tmp",
    writeAndSyncImpl: async (target, content) => events.push(["write-sync", target, content]),
    renameImpl: async (source, target) => events.push(["rename", source, target]),
    syncParentDirectoryImpl: async (target) => events.push(["directory-sync", target]),
  });
  assert.deepEqual(events, [
    ["write-sync", "C:\\state\\state.tmp", "new"],
    ["rename", "C:\\state\\state.tmp", "C:\\state\\state.json"],
    ["directory-sync", "C:\\state\\state.json"],
  ]);
});

test("readJsonWithBackup recovers a corrupt primary state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-state-backup-"));
  const filePath = path.join(directory, "state.json");
  try {
    await writeFile(filePath, "{broken", "utf8");
    await writeFile(`${filePath}.bak`, JSON.stringify({ activeRuns: [{ id: "saved" }] }), "utf8");
    const loaded = await readJsonWithBackup(filePath);
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.value.activeRuns[0].id, "saved");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

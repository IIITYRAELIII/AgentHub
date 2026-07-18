import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeTextAtomic } from "./state-store.mjs";

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

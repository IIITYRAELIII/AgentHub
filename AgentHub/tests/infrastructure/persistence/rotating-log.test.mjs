import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendRotatingLog } from "../../../src/infrastructure/persistence/rotating-log.mjs";

test("appendRotatingLog bounds the current log and numbered backups", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-log-"));
  const logPath = path.join(directory, "bot.log");
  try {
    for (const value of ["first\n", "second\n", "third\n", "fourth\n"]) {
      appendRotatingLog(logPath, value, { maxBytes: 12, maxFiles: 2 });
    }
    assert.equal(await readFile(logPath, "utf8"), "fourth\n");
    assert.equal(await readFile(path.join(directory, "bot.1.log"), "utf8"), "third\n");
    assert.equal(await readFile(path.join(directory, "bot.2.log"), "utf8"), "second\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

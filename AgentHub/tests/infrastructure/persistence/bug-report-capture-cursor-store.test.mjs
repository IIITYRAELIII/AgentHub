import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BugReportCaptureCursorStore } from "../../../src/infrastructure/persistence/bug-report-capture-cursor-store.mjs";

test("bug report capture cursor is local, persistent, and tolerates invalid state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-bug-cursor-"));
  const filePath = path.join(root, "nested", "bug-report-capture.json");
  try {
    const store = new BugReportCaptureCursorStore({ filePath });
    assert.equal(await store.load(), "");
    await store.save("a".repeat(40));
    assert.equal(await new BugReportCaptureCursorStore({ filePath }).load(), "a".repeat(40));
    await writeFile(filePath, `${JSON.stringify({ version: 1, revision: "b".repeat(40) })}\n`, "utf8");
    assert.equal(await store.load(), "");
    await writeFile(filePath, "not-json", "utf8");
    assert.equal(await store.load(), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

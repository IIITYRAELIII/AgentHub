import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { withPublicationLock } from "../../../src/infrastructure/process/publication-lock.mjs";

test("publication lock serializes deployments from concurrent worktrees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-"));
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all(Array.from({ length: 4 }, () => withPublicationLock(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    }, {
      environment: {},
      lockTarget: path.join(root, "publication"),
      timeoutMs: 1_000,
    })));
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested publication steps reuse the owning publication session", async () => {
  const environment = { AGENT_HUB_PUBLICATION_SESSION: "parent" };
  let lockCalls = 0;
  const result = await withPublicationLock(async () => "done", {
    environment,
    lock: async () => { lockCalls += 1; },
  });
  assert.equal(result, "done");
  assert.equal(lockCalls, 0);
});

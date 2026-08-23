import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_HUB_VERSION,
  readAgentHubPackage,
  readAgentHubVersion,
} from "../../../src/infrastructure/filesystem/agent-hub-package.mjs";

test("Agent Hub package metadata is the canonical product version", () => {
  assert.equal(readAgentHubVersion(), AGENT_HUB_VERSION);
  assert.equal(readAgentHubPackage().name, "agent-hub");
});

test("Agent Hub package metadata rejects missing and invalid versions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-package-"));
  const packageFile = path.join(root, "package.json");
  try {
    await writeFile(packageFile, JSON.stringify({ name: "agent-hub" }), "utf8");
    assert.throws(() => readAgentHubVersion({ packageFile }), /invalid version/u);
    await writeFile(packageFile, JSON.stringify({ name: "another-package", version: "1.2.3" }), "utf8");
    assert.throws(() => readAgentHubVersion({ packageFile }), /unexpected name/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

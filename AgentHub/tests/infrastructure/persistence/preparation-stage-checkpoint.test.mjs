import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-prepare-stage-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const store = new WorkspaceCatalogStore({ databaseFile }); await store.load();
  const { workspace, stream } = store.createWorkspaceWithStream({ name: "Preparation" });
  const identity = { workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "original-thread",
    argumentsHash: "a".repeat(64) };
  store.beginMcpOperation({ ...identity, requestId: "original", toolName: "hub_release_prepare" });
  const state = { schemaVersion: 1, revision: 1, ownerId: "original-owner", phase: "checking",
    envelope: { immutable: "original" }, sourceRoot: root, sourceRootIdentity: "volume:file" };
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, identity, state, databaseFile };
}

test("preparation owner checkpoints use atomic original identity, revision and legal phase CAS", async t => {
  const { store, identity, state } = await fixture(t);
  const write = (next, options = {}) => store.checkpointMcpPreparation("original", {
    identity, expectedRevision: next.revision - 1, state: next, ...options });
  write(state);
  const before = store.mcpOperation("original");
  for (const key of ["workspaceId", "streamId", "provider", "threadId", "argumentsHash"]) {
    assert.throws(() => write({ ...state, revision: 2, phase: "paused" },
      { identity: { ...identity, [key]: "foreign" } }), /identity\/revision CAS/u);
  }
  assert.throws(() => write({ ...state, revision: 2, phase: "paused", ownerId: "foreign" }), /owner\/transition/u);
  assert.throws(() => write({ ...state, revision: 2, phase: "terminal-intent" }), /owner\/transition/u);
  assert.deepEqual(store.mcpOperation("original"), before);
  write({ ...state, revision: 2, phase: "paused", originalError: "actual dev ancestry refusal" });
  store.markMcpOperationUnknown("original", new Error("original outcome unknown"));
  const paused = store.mcpOperation("original");
  assert.throws(() => write({ ...state, revision: 3 }), /cannot checkpoint/u);
  write({ ...paused.preparationState, revision: 3, phase: "checking", ownerId: "resuming-owner" }, { resume: true });
  assert.equal(store.mcpOperation("original").receiptState, "reconciling");
  assert.throws(() => write({ ...paused.preparationState, revision: 3, phase: "checking", ownerId: "second-owner" },
    { resume: true }), /identity\/revision CAS/u);
  const active = store.mcpOperation("original").preparationState;
  write({ ...active, revision: 4, phase: "composing" });
  store.markMcpOperationUnknown("original", new Error("possible candidate effect"));
  assert.throws(() => write({ ...active, revision: 5, phase: "checking" }, { resume: true }), /resumable owner stage/u);
  assert.equal(store.mcpOperation("original").status, "unknown");
});

test("preparation recovery cannot substitute original envelope or retained source custody", async t => {
  const { store, identity, state } = await fixture(t);
  store.checkpointMcpPreparation("original", { identity, expectedRevision: 0, state });
  store.markMcpOperationUnknown("original", new Error("lost owner reply before compose"));
  const before = store.mcpOperation("original");
  for (const field of ["envelope", "sourceRoot", "sourceRootIdentity"]) {
    assert.throws(() => store.checkpointMcpPreparation("original", { identity, expectedRevision: 1, resume: true,
      state: { ...state, revision: 2, ownerId: "new-owner", [field]: field === "envelope" ? { foreign: true } : "foreign" } }),
    /owner\/transition/u);
  }
  assert.deepEqual(store.mcpOperation("original"), before);
});

test("preparation schema migration keeps legacy UNKNOWN without invented owner evidence", async t => {
  const f = await fixture(t);
  f.store.markMcpOperationUnknown("original", new Error("legacy generic refusal after audit"));
  const before = f.store.mcpOperation("original");
  f.store.close();
  const legacy = new DatabaseSync(f.databaseFile);
  legacy.exec("ALTER TABLE hub_mcp_operations DROP COLUMN preparation_state_json"); legacy.close();
  const reopened = new WorkspaceCatalogStore({ databaseFile: f.databaseFile }); await reopened.load();
  try {
    assert.deepEqual(reopened.mcpOperation("original"), before);
    assert.throws(() => reopened.checkpointMcpPreparation("original", { identity: f.identity,
      expectedRevision: 0, state: f.state, resume: true }), /resumable owner stage/u);
    assert.deepEqual(reopened.mcpOperation("original"), before);
  } finally { reopened.close(); }
});

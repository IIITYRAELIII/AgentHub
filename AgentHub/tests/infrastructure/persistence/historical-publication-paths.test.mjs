import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicationRunPaths } from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { verifyLocalPublicationReceiptBaseline } from "../../../src/infrastructure/persistence/local-publication-receipt-baseline.mjs";

test("historical Task publication paths retain platform priority and home fallback", () => {
  const first = path.join(os.tmpdir(), "first-state"), second = path.join(os.tmpdir(), "second-state");
  assert.deepEqual(publicationRunPaths({ LOCALAPPDATA: first, XDG_STATE_HOME: second }), {
    statusFile: path.join(first, "AgentHub", "publication-status.json"),
    logDirectory: path.join(first, "AgentHub", "publication-runs"),
  });
  assert.equal(publicationRunPaths({ XDG_STATE_HOME: second }).statusFile,
    path.join(second, "AgentHub", "publication-status.json"));
  assert.equal(publicationRunPaths({}).statusFile,
    path.join(os.homedir(), ".local", "state", "AgentHub", "publication-status.json"));
});

test("retained Task baseline consumer resolves its default status path before read-only evidence validation", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-baseline-path-"));
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const sentinel = new Error("read-only evidence boundary");
  let observed;
  await assert.rejects(verifyLocalPublicationReceiptBaseline({
    projectRoot: directory, workspaceId: "workspace", runId: "archived-run", expectedRevision: "a".repeat(40),
    expectedGeneration: "archived-generation", expectedPublishedAt: "2026-01-01T00:00:00Z",
    expectedStateSha256: "b".repeat(64), expectedReceiptSha256: "c".repeat(64), expectedReleaseId: "old-body",
    expectedOriginUrl: "https://github.com/example/project.git", expectedOriginMainCommit: "d".repeat(40),
    requestId: "read-archive",
  }, { readEvidence: async input => { observed = input; throw sentinel; } }), error => error === sentinel);
  assert.equal(observed.statusFile, path.join(directory, "AgentHub", "publication-status.json"));
  assert.deepEqual(await readdir(directory), [], "location resolution and evidence read create no release state");
});

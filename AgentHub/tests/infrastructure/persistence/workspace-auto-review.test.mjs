import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { AUTO_REVIEW_DEVELOPER_RULES, TEAM_LEAD_DEVELOPER_RULES } from "../../../src/domain/workspace-release-workflow.mjs";

test("auto-review persists independently and reaches all Stream contexts across restart and rotation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-auto-review-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let store = new WorkspaceCatalogStore({ databaseFile });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.load();
  const workspace = store.createWorkspace({ name: "Review", settings: { releaseWorkflowEnabled: false } });
  const executor = store.createStream({ workspaceId: workspace.id, name: "Executor" });
  const reviewer = store.createStream({ workspaceId: workspace.id, name: "Reviewer" });
  store.updateWorkspaceDeveloperRules(workspace.id, "Authored rules");
  assert.equal(store.developerRulesForStream(executor.id).workspace.content, "Authored rules");
  store.updateWorkspaceSettings(workspace.id, { autoReviewEnabled: true });
  store.bindThread({ provider: "codex", threadId: "old-thread", streamId: executor.id });
  store.bindThread({ provider: "claude", threadId: "review-thread", streamId: reviewer.id });
  for (const identity of [{ provider: "codex", threadId: "old-thread" }, { provider: "claude", threadId: "review-thread" }]) {
    assert.equal(store.developerRulesForThread(identity).workspace.content, `${AUTO_REVIEW_DEVELOPER_RULES}\n\nAuthored rules`);
  }
  store.updateWorkspaceSettings(workspace.id, { workingDirectory: "project" });
  assert.equal(store.workspace(workspace.id).settings.autoReviewEnabled, true);
  assert.equal(store.workspace(workspace.id).settings.releaseWorkflowEnabled, false);
  store.close();
  store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  store.bindThread({ provider: "codex", threadId: "new-thread", streamId: executor.id });
  assert.equal(store.developerRulesForThread({ provider: "codex", threadId: "new-thread" }).workspace.content,
    `${AUTO_REVIEW_DEVELOPER_RULES}\n\nAuthored rules`);
  assert.equal(store.workspaceDeveloperRules(workspace.id).content, "Authored rules");
  store.updateWorkspaceSettings(workspace.id, { releaseWorkflowEnabled: true, autoReviewEnabled: false });
  store.updateStreamSettings(executor.id, { teamLead: true });
  const disabled = store.developerRulesForStream(executor.id);
  assert.equal(disabled.workspace.content.includes(AUTO_REVIEW_DEVELOPER_RULES), false);
  assert.equal(disabled.stream.content, TEAM_LEAD_DEVELOPER_RULES);
  store.updateWorkspaceSettings(workspace.id, { releaseWorkflowEnabled: false });
  assert.equal(store.developerRulesForStream(executor.id).workspace.content, "Authored rules");
  const created = store.createWorkspace({ name: "Review from creation", settings: { autoReviewEnabled: true } });
  const stream = store.createStream({ workspaceId: created.id, name: "New" });
  assert.equal(store.developerRulesForStream(stream.id).workspace.content, AUTO_REVIEW_DEVELOPER_RULES);
});

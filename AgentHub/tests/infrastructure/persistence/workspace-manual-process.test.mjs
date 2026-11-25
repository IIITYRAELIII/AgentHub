import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as policy from "../../../src/domain/workspace-task-workflow.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

const titleRule = "Keep the Task title concise and outcome-oriented. Aim to fit it within 36 characters; use a longer title only when the Task's meaning cannot be preserved within 36 characters. Preserve the user's original request in its description; do not copy it verbatim into the title unless explicitly requested.";
const publishedBoundary = "Changes or corrections after an already published release belong to a later release; preserve the published source, assets and original outcomes.";

test("manual process restores complete Task requirements and publication identity boundary", () => {
  const workspace = policy.effectiveWorkspaceDeveloperRules("raw workspace", { releaseWorkflowEnabled: true });
  const manager = policy.effectiveStreamDeveloperRules("raw stream", { releaseManager: true });
  assert.ok(workspace.includes(titleRule));
  assert.ok(workspace.includes("dependency_mode=ensure; use verify for suspected damage"));
  assert.ok(workspace.includes("inspect ALL existing Tasks"));
  assert.ok(workspace.includes("open, Done and archived Tasks"));
  assert.ok(workspace.includes("Continue and supplement a matching unfinished Task"));
  for (const rules of [workspace, manager]) {
    assert.ok(rules.includes(publishedBoundary));
    assert.match(rules, /directly in PreRelease/u);
    assert.match(rules, /install.*from.*installer/iu);
    assert.match(rules, /synchroniz.*main into dev/u);
    assert.match(rules, /GitHub Release/u);
    assert.ok(rules.includes("Publish a GitHub Release with the checked files and consolidated notes only when the Workspace rules require it."));
    assert.doesNotMatch(rules, /hub_release_(?:run|get|continue)|Run the Workspace-prescribed release pipeline/u);
  }
  assert.equal(policy.effectiveWorkspaceDeveloperRules("raw", { releaseWorkflowEnabled: false }), "raw");
  assert.equal(policy.effectiveWorkspaceDeveloperRules("raw", { releaseWorkflowEnabled: "true" }), "raw");
  assert.equal(policy.effectiveStreamDeveloperRules("raw", { releaseManager: false }), "raw");
});

test("canonical catalog injects independent settings across rotation and restart without changing raw rules", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-manual-process-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let store = new WorkspaceCatalogStore({ databaseFile });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  await store.load();
  const workspace = store.createWorkspace({ name: "Policy", settings: { releaseWorkflowEnabled: false } });
  const executor = store.createStream({ workspaceId: workspace.id, name: "Executor" });
  const manager = store.createStream({ workspaceId: workspace.id, name: "Manager", settings: { releaseManager: true, teamLead: true } });
  const otherWorkspace = store.createWorkspace({ name: "Other" });
  const other = store.createStream({ workspaceId: otherWorkspace.id, name: "Other" });
  const rawWorkspace = "raw workspace\n\nDo not normalize this content.\n";
  const rawStream = "raw stream\n";
  store.updateWorkspaceDeveloperRules(workspace.id, rawWorkspace);
  store.updateStreamDeveloperRules(manager.id, rawStream);
  assert.equal(store.developerRulesForStream(executor.id).workspace.content, rawWorkspace);
  store.updateWorkspaceSettings(workspace.id, { releaseWorkflowEnabled: true, autoReviewEnabled: true });
  store.bindThread({ provider: "codex", threadId: "old-policy-thread", streamId: manager.id });
  const assertContext = context => {
    assert.equal(context.workspace.content, `${policy.RELEASE_WORKFLOW_DEVELOPER_RULES}\n\n${policy.AUTO_REVIEW_DEVELOPER_RULES}\n\n${rawWorkspace}`);
    assert.equal(context.stream.content, `${policy.RELEASE_MANAGER_RELEASE_DEVELOPER_RULES}\n\n${policy.TEAM_LEAD_DEVELOPER_RULES}\n\n${rawStream}`);
    assert.ok(context.workspace.content.includes(titleRule));
    assert.ok(context.stream.content.includes(publishedBoundary));
  };
  assertContext(store.developerRulesForThread({ provider: "codex", threadId: "old-policy-thread" }));
  assert.equal(store.developerRulesForStream(other.id).workspace?.content ?? "", "");
  assert.equal(store.developerRulesForStream(other.id).stream?.content ?? "", "");
  assert.equal(store.workspaceDeveloperRules(workspace.id).content, rawWorkspace);
  assert.equal(store.streamDeveloperRules(manager.id).content, rawStream);
  store.close();
  store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  store.bindThread({ provider: "codex", threadId: "new-policy-thread", streamId: manager.id });
  assertContext(store.developerRulesForThread({ provider: "codex", threadId: "new-policy-thread" }));
  store.updateWorkspaceSettings(workspace.id, { releaseWorkflowEnabled: false });
  assert.equal(store.developerRulesForStream(manager.id).workspace.content, `${policy.AUTO_REVIEW_DEVELOPER_RULES}\n\n${rawWorkspace}`);
  store.updateStreamSettings(manager.id, { releaseManager: false, teamLead: true });
  assert.equal(store.developerRulesForStream(manager.id).stream.content, `${policy.TEAM_LEAD_DEVELOPER_RULES}\n\n${rawStream}`);
  assert.equal(store.workspaceDeveloperRules(workspace.id).content, rawWorkspace);
  assert.equal(store.streamDeveloperRules(manager.id).content, rawStream);
});

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTaskBoardMutationOwner } from "../../../src/application/sqlite-mutation-owner.mjs";
import { WorkspaceReleaseService } from "../../../src/application/workspace-release-service.mjs";
import { createDesktopRouterComposition } from "../../../src/composition/desktop-router-composition.mjs";
import { taskReleasePlanRevision } from "../../../src/domain/task-release-snapshot.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";

const [directory, mode] = process.argv.slice(2);
const raw = new TaskBoardStore({ databaseFile: path.join(directory, "tasks.sqlite") });
const stateFile = path.join(directory, "request.json");
let saved;
try { saved = JSON.parse(await readFile(stateFile, "utf8")); } catch (error) {
  if (error.code !== "ENOENT") throw error;
  const workspaceId = "workspace";
  const projectRoot = path.join(directory, "repository");
  const publishedRevision = "a".repeat(40);
  const task = raw.create({ text: "Exact release", bucket: "workspace", workspaceId });
  raw.recordTaskGitReference({ taskId: task.id, projectRoot, branch: "HUB-182",
    resultSnapshot: { repoRoot: projectRoot, tree: publishedRevision } });
  raw.setWorkflowStatus(task.id, "awaiting_implementation");
  const candidate = raw.task(task.id);
  const plan = { revision: taskReleasePlanRevision(workspaceId, [candidate]), candidates: [candidate], ready: [candidate], blocked: [] };
  saved = { plan, projectRoot, publishedRevision, request: {
    action: mode.startsWith("generic") ? "rename-workspace" : "complete-workspace-release",
    params: { workspaceId, expectedPlanRevision: plan.revision, deploymentVerified: true,
      expectedRepositories: [{ projectRoot, revision: publishedRevision }], verificationSummary: "verified" },
    context: { source: "desktop-control", commandId: "stable-finalization-command" },
  } };
  await writeFile(stateFile, JSON.stringify(saved));
}
const calls = [];
const originalComplete = raw.completeRelease.bind(raw);
raw.completeRelease = (...args) => {
  calls.push("closure");
  const result = originalComplete(...args);
  if (mode === "closure-crash") process.exit(23);
  return result;
};
if (mode === "checkpoint-failure") {
  raw.recordReleaseFinalizationStage = () => { throw new Error("injected checkpoint write failure"); };
}
if (mode === "new-attempt") saved.request.context.commandId = "next-finalization-attempt";
const { projectRoot, publishedRevision, plan } = saved;
const service = new WorkspaceReleaseService({
  store: createTaskBoardMutationOwner(raw),
  releasePlanner: { plan: async () => { calls.push("plan"); return plan; } },
  releaseGitWorkspaces: {
    frozenCandidate: async () => ({ repositoryRoot: projectRoot, planRevision: plan.revision,
      manifestHash: "manifest", baseCommit: "base", preReleaseHead: publishedRevision }),
    synchronizePublishedPrimary: async () => { calls.push("primary"); return { status: "already_current" }; },
  },
  taskGitWorkspaces: { synchronizeMainIntoDev: async () => {
    calls.push("dev"); return { status: "already_current", integrated: true };
  } },
  releasePreflight: {
    withAwaitTransition: async (_workspace, operation) => operation(),
    prepareAwaitSet: async () => { calls.push("await"); return { rebuilt: true }; },
  },
  verifyPublication: async () => {
    calls.push("verify");
    return { repositories: [{ root: projectRoot, revision: publishedRevision, planRevision: plan.revision,
      manifestHash: "manifest", baseCommit: "base", preReleaseHead: publishedRevision }],
    agentHubPublication: { generation: "generation-1" } };
  },
});
const router = createDesktopRouterComposition({
  handlers: new Proxy({}, { get: () => async () => ({}) }),
  commands: {
    settingTarget: () => null,
    dispatch: async (type, params) => {
      calls.push(params.reconcileOnly ? "reconcile" : "dispatch");
      if (mode === "generic-crash") process.exit(25);
      if (type !== "workspace.release.complete") throw new Error("generic mutation unexpectedly replayed");
      return service.completeRelease(params);
    },
  },
  receiptFile: path.join(directory, "receipts.sqlite"),
});
try {
  const result = await router.handleDesktopControl(saved.request);
  if (mode === "ack-crash") {
    await router.forgetDesktopControl(saved.request.context.commandId);
    process.exit(24);
  }
  console.log(JSON.stringify({ result, calls }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, calls }));
}
raw.close();

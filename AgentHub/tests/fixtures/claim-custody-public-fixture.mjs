import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";

const run = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
export async function claimCustodyFixture(t, { dataDir = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claim-custody-"));
  const repository = path.join(root, "repo");
  await mkdir(repository);
  const git = async (cwd, ...args) => (await run("git", args, { cwd, windowsHide: true })).stdout.trim();
  await git(repository, "init", "-b", "main");
  await writeFile(path.join(repository, ".gitignore"), "WIP/\n");
  await writeFile(path.join(repository, "source.txt"), "accepted source\n");
  await git(repository, "add", ".");
  await git(repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "source");
  const databaseFile = path.join(root, "hub.sqlite");
  const sessions = [];
  const open = async () => {
    const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
    await rawCatalog.load();
    const rawTasks = new TaskBoardStore({ databaseFile });
    sessions.push({ rawCatalog, rawTasks });
    const caps = createPersistenceMutationCapabilities({ rawWorkspaceCatalogStore: rawCatalog, rawTaskBoardStore: rawTasks });
    const catalog = caps.workspaceCatalogStore;
    return { rawCatalog, rawTasks, catalog, tasks: new TaskBoardService({ store: caps.taskBoardStore, workspaceCatalog: catalog }) };
  };
  t.after(async () => {
    for (const s of sessions) { s.rawTasks.close(); s.rawCatalog.close(); }
    await rm(root, { recursive: true, force: true });
  });
  const stores = await open();
  const workspace = await stores.catalog.createWorkspace({ name: "Fixture", settings: { workingDirectory: repository } });
  const owner = await stores.catalog.createStream({ workspaceId: workspace.id, name: "Previous" });
  const successor = await stores.catalog.createStream({ workspaceId: workspace.id, name: "Successor" });
  const manager = await stores.catalog.createStream({ workspaceId: workspace.id, name: "Manager", settings: { releaseManager: true } });
  for (const stream of [owner, successor, manager]) await stores.catalog.bindThread({
    streamId: stream.id, provider: "codex", threadId: `${stream.id}-thread`, projectRoot: repository,
  });
  const task = await stores.tasks.create({ text: "Preserve accepted source", bucket: "workspace", workspaceId: workspace.id });
  const workspaces = new TaskGitWorkspaceService({ dataDir: dataDir ?? path.join(root, "data"), recordTiming: () => {},
    readClaimCustodyNamespace: taskId => stores.catalog.claimCustodyNamespaceForTask(taskId),
    prepareDependencies: async () => { throw new Error("Custody must not repeat dependency preparation"); } });
  const source = await workspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: repository });
  await mkdir(path.join(source.projectRoot, "WIP"));
  await writeFile(path.join(source.projectRoot, "WIP", "useful.txt"), "unfinished evidence\n");
  const wip = [{ path: "WIP/useful.txt", type: "file", bytes: 20, sha256: hash("unfinished evidence\n") }];
  await stores.tasks.claim({ id: task.id, workspaceId: workspace.id, streamId: owner.id,
    provider: "codex", threadId: `${owner.id}-thread`, turnId: "previous-turn", operationId: "previous-claim", gitBaseline: source.gitBaseline });
  const prior = stores.tasks.task(task.id);
  const originalArgs = { request_id: "legacy-claim", task_id: task.id, dependency_mode: "ensure" };
  await stores.catalog.beginMcpOperation({ requestId: originalArgs.request_id, workspaceId: workspace.id,
    streamId: successor.id, provider: "codex", threadId: `${successor.id}-thread`, toolName: "hub_task_claim",
    argumentsHash: mcpArgumentsHash(originalArgs) });
  await stores.catalog.markMcpOperationUnknown(originalArgs.request_id, new Error("legacy ambiguous failure"));
  const original = stores.catalog.mcpOperation(originalArgs.request_id);
  let retired = false;
  let prepares = 0;
  const originalPrepare = workspaces.prepare.bind(workspaces);
  workspaces.prepare = (...args) => { prepares += 1; return originalPrepare(...args); };
  const runtime = {
    async capture() { return { version: 1, kind: "primary-runtime-cohort", members: [{ pid: 123, birth: "fixture-birth" }], instanceHash: hash("fixture-instance") }; },
    async assertRetired(cohort) { assert.equal(cohort.kind, "primary-runtime-cohort"); if (!retired) throw new Error("Legacy runtime cohort is still alive"); return { retired: true, members: cohort.members }; },
  };
  let runs = [successor, manager].map(s => ({ id: `${s.id}-run`, streamId: s.id, provider: "codex", threadId: `${s.id}-thread`, turnId: `${s.id}-turn`, status: "running" }));
  const service = (s = stores, startup = false, taskGit = workspaces) => {
    const hub = new HubMcpService({ workspaceCatalog: s.catalog, taskBoard: s.tasks, taskGitWorkspaces: taskGit,
      claimCustodyRuntime: runtime, workLog: { threadTurns: async () => [] }, secret: "fixture-secret", attachmentDirectory: root,
      reconcilePendingOnStartup: startup, taskLifecycle: {}, releasePreflight: { async preflight() { return {}; } },
      releasePlanner: { async plan() { return { ready: [] }; } }, releaseCompleter: { async completeRelease() { return {}; } } });
    hub.setActiveRuns(() => runs); hub.setDeferredInputs(() => []); return hub;
  };
  const hub = service();
  const managerToken = hub.contextToken({ provider: "codex", threadId: `${manager.id}-thread` });
  const successorToken = hub.contextToken({ provider: "codex", threadId: `${successor.id}-thread` });
  const prepare = { context_token: managerToken, request_id: "custody-plan", task_id: task.id,
    operation_request_id: original.requestId, confirm_reconcile: true, claim_custody: { action: "prepare",
      authorization_id: "explicit-forward-only-authorization", handoff_id: "saved-stopped-source-handoff",
      expected_original: Object.fromEntries(["workspaceId", "streamId", "provider", "threadId", "argumentsHash", "createdAtMs"].map(k => [k, original[k]])),
      original_arguments: originalArgs, expected_task_revision: prior.revision, expected_owner_stream_id: owner.id,
      successor_claim_request_id: "custody-successor-claim", source: { projectRoot: source.projectRoot,
        headCommit: source.headCommit, tree: await git(source.projectRoot, "rev-parse", "HEAD^{tree}"),
        wipPaths: ["WIP"], wipDigest: hash(JSON.stringify(wip)) },
    } };
  const fence = plan => ({ context_token: managerToken, request_id: "custody-fence", task_id: task.id,
    operation_request_id: original.requestId, confirm_reconcile: true,
    claim_custody: { action: "fence", plan_request_id: "custody-plan", expected_plan_hash: plan.planHash } });
  const consume = { context_token: successorToken, request_id: "custody-successor-claim", task_id: task.id,
    dependency_mode: "ensure", forward_custody_request_id: "custody-fence" };
  return { ...stores, root, source, prior, original, originalArgs, prepare, fence, consume, hub, open, service,
    workspaces, git, successor, managerToken, successorToken, runtime,
    retire() { retired = true; }, busy() { runs.push({ id: "busy", streamId: owner.id, provider: "codex", threadId: `${owner.id}-thread`, turnId: "busy", status: "running" }); },
    idle() { runs = runs.filter(run => run.id !== "busy"); },
    prepares: () => prepares, stores };
}

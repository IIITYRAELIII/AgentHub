import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { RunJournalService } from "../application/run-journal-service.mjs";
import { HubMcpService } from "../application/hub-mcp-service.mjs";
import { TurnEndNotificationRegistry } from "../application/turn-end-notifications.mjs";
import { createWorkLogUsageStore } from "../application/work-log-usage-store.mjs";
import { TaskBoardService } from "../application/task-board-service.mjs";
import { WorkspaceReleaseService } from "../application/workspace-release-service.mjs";
import { samePath } from "../infrastructure/filesystem/config.mjs";
import { resolveTaskGitRepoRootsForFiles } from "../infrastructure/filesystem/task-git-diff.mjs";
import { runtimeLayout, runtimeReleaseDirectory } from "../infrastructure/filesystem/runtime-layout.mjs";
import { UsdRubRateStore } from "../infrastructure/network/exchange-rate.mjs";
import { migrateMessageBindings } from "../infrastructure/persistence/message-bindings.mjs";
import { RateLimitHistoryStore } from "../infrastructure/persistence/rate-limit-history.mjs";
import { PreTurnInstructionStore } from "../infrastructure/persistence/pre-turn-instruction-store.mjs";
import { installRotatingConsole } from "../infrastructure/persistence/rotating-log.mjs";
import { RuntimeStateStore } from "../infrastructure/persistence/runtime-state-store.mjs";
import { TaskReadStateStore } from "../infrastructure/persistence/task-read-state-store.mjs";
import { TrustedDeviceStore } from "../infrastructure/persistence/trusted-device-store.mjs";
import { WorkspaceCatalogStore } from "../infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../infrastructure/persistence/task-board-store.mjs";
import { WorkLogUsageRepository } from "../infrastructure/persistence/work-log-usage-repository.mjs";
import {
  assertCurrentPublicationRevision,
  gitOutput,
  parseWorkingTreeStatus,
  readPublicationState,
} from "../infrastructure/persistence/publication-state.mjs";
import { SingleInstanceGuard } from "../infrastructure/process/instance-lock.mjs";
import { captureProcess } from "../infrastructure/process/process-capture.mjs";
import { RuntimeCommandServer } from "../infrastructure/process/runtime-command.mjs";
import {
  copyWindowsFileObject,
  revealWindowsFile,
} from "../infrastructure/process/windows-file-clipboard.mjs";
import { MiniAppServer } from "../interfaces/web/mini-app-server.mjs";
import { HubMcpServer } from "../interfaces/mcp/hub-mcp-server.mjs";
import { ensureLocalWebSecret } from "../interfaces/web/local-web-auth.mjs";
import { TrustedDeviceRegistry } from "../interfaces/web/trusted-device-access.mjs";
import { CodexRolloutContextSanitizer } from "../providers/codex/codex-rollout-context.mjs";
import {
  CodexSparkTaskClassifier,
  ensureDashBotStream,
} from "../providers/codex/codex-spark-task-classifier.mjs";
import { RuntimeNotificationController } from "../runtime/runtime-notification-controller.mjs";

function runtimeAssetBundleProvider(runtimeRoot) {
  const layout = runtimeLayout(runtimeRoot);
  return async () => {
    const pointer = JSON.parse(await readFile(layout.currentFile, "utf8"));
    const id = String(pointer.current ?? "").trim();
    const releaseRoot = runtimeReleaseDirectory(runtimeRoot, id);
    return {
      id,
      assetsDirectory: path.join(releaseRoot, "assets", "web-app"),
      workLogCssFile: path.join(releaseRoot, "work-log.css"),
    };
  };
}

export async function createHubInfrastructure({
  config,
  agentHubRoot,
  runtimeCommandRoot,
  localWebSecret,
  journalDatabaseFile,
  legacyWorkLogLedgerFile,
  legacyWorkLogFile,
  globalWorkLogProjectRoots,
  stateFile,
  stateBackupFile,
  instanceLockFile,
  exchangeRatesFile,
  handleDesktopControl,
  forgetDesktopControl,
  findProject,
  authorizeRuntimeCommand,
  reconcileRuntimeCommand,
  handleRuntimeCommand,
  stopProcessTree,
}) {
  const localTrustedDeviceStore = new TrustedDeviceStore({
    filePath: path.join(config.dataDir, "trusted-devices.json"),
  });
  await localTrustedDeviceStore.load();
  const trustedDeviceStore = new TrustedDeviceRegistry(localTrustedDeviceStore);
  const codexRolloutContextSanitizer = new CodexRolloutContextSanitizer({
    ...config.codexRolloutContext,
  });
  const workspaceCatalogStore = new WorkspaceCatalogStore({
    databaseFile: journalDatabaseFile,
  });
  await workspaceCatalogStore.load();
  const repositoryRoot = path.resolve(agentHubRoot, "..");
  const workspaceReleaseService = new WorkspaceReleaseService({
    store: workspaceCatalogStore,
    verifyPublication: async ({ expectedRevision = null, plan } = {}) => {
      const projectRoots = [...new Set(plan.ready.map((change) => String(change.projectRoot ?? "").trim()))];
      if (projectRoots.some((value) => !value)) throw new Error("release change has no project root");
      const repositories = [];
      for (const projectRoot of projectRoots) {
        const files = plan.ready
          .filter((change) => String(change.projectRoot ?? "").trim() === projectRoot)
          .flatMap((change) => change.files ?? []);
        const roots = await resolveTaskGitRepoRootsForFiles(projectRoot, files);
        if (!roots.length) throw new Error(`release repository is not found for: ${projectRoot}`);
        for (const root of roots) {
          if (repositories.some((repository) => path.resolve(repository.root) === path.resolve(root))) continue;
          const changes = parseWorkingTreeStatus(await gitOutput([
            "status", "--porcelain=v1", "--untracked-files=all",
          ], { cwd: root }));
          if (changes.length) throw new Error(`release repository is dirty: ${root}`);
          const revision = await assertCurrentPublicationRevision({ cwd: root });
          repositories.push({ root, revision });
        }
      }
      if (expectedRevision && (repositories.length !== 1 || repositories[0].revision !== expectedRevision)) {
        throw new Error("release revision does not match expected_revision");
      }
      const utilitiesRepository = repositories.find(
        (repository) => path.resolve(repository.root) === path.resolve(repositoryRoot),
      );
      let agentHubPublication = null;
      if (utilitiesRepository) {
        const publication = await readPublicationState();
        if (!publication?.revision || publication.revision !== utilitiesRepository.revision) {
          throw new Error("Utilities revision is not the currently published Agent Hub revision");
        }
        agentHubPublication = {
          revision: publication.revision,
          publishedAt: publication.publishedAt ?? null,
          mode: publication.mode ?? null,
        };
      }
      return { repositories, agentHubPublication };
    },
  });
  const preTurnInstructions = new PreTurnInstructionStore({
    guideFile: path.join(agentHubRoot, "AGENT_HUB_GUIDE.md"),
    globalFile: path.join(config.dataDir, "global-pre-turn-instructions.md"),
  });
  await preTurnInstructions.loadGuide();
  const taskBoardStore = new TaskBoardStore({ databaseFile: journalDatabaseFile });
  const dashBotStream = config.taskBoard.triageEnabled
    ? ensureDashBotStream(workspaceCatalogStore, {
      model: config.taskBoard.triageModel,
      projectRoot: config.projectRoot,
    })
    : null;
  const taskClassifier = config.taskBoard.triageEnabled
    ? new CodexSparkTaskClassifier({
      requestedExecutable: config.codexExecutable,
      executableArgs: config.codexExecutableArgs,
      projectRoot: config.projectRoot,
      model: config.taskBoard.triageModel,
      stopProcess: (worker) => stopProcessTree(worker.pid),
      workspaceCatalog: workspaceCatalogStore,
      streamId: dashBotStream.id,
    })
    : null;
  const taskBoard = new TaskBoardService({
    store: taskBoardStore,
    workspaceCatalog: workspaceCatalogStore,
    classify: taskClassifier ? (input) => taskClassifier.classify(input) : null,
    autoPlaceConfidence: config.taskBoard.autoPlaceConfidence,
    recordEvent: (event) => workspaceCatalogStore.recordWorkspaceEvent(event),
  });
  taskBoard.recoverPendingTriage();
  const workLogUsageStore = createWorkLogUsageStore({
    repositoryFactory: (options) => new WorkLogUsageRepository(options),
    ledgerFile: legacyWorkLogLedgerFile,
    databaseFile: journalDatabaseFile,
    defaultProjectRoot: config.projectRoot,
    workspaceCatalogStore,
  });
  const attachmentDirectory = path.join(runtimeCommandRoot, "DesktopApp", "attachments");
  const hubMcpSecret = await ensureLocalWebSecret(path.join(runtimeCommandRoot, "hub-mcp.secret"));
  const hubMcpService = new HubMcpService({
    workspaceCatalog: workspaceCatalogStore,
    taskBoard,
    workLog: workLogUsageStore,
    attachmentDirectory,
    secret: hubMcpSecret,
    releaseCompleter: workspaceReleaseService,
  });
  const hubMcpServer = new HubMcpServer({
    service: hubMcpService,
    secret: hubMcpSecret,
  });
  const serverOptions = {
    botToken: config.token,
    allowedUserIds: config.allowedUserIds,
    deviceStore: trustedDeviceStore,
    controlHandler: handleDesktopControl,
    onControlResultDelivered: ({ id }) => forgetDesktopControl(id),
    attachmentDirectory,
    assetBundleProvider: runtimeAssetBundleProvider(runtimeCommandRoot),
    journalDatabaseFile,
  };
  const miniAppServer = config.miniApp.enabled
    ? new MiniAppServer({
      ...config.miniApp,
      ...serverOptions,
      localAccessSecret: localWebSecret,
      localAccessSecretFile: path.join(runtimeCommandRoot, "local-web.secret"),
      workspaceFileRoots: [config.projectRoot, ...config.projects.map((project) => project.path)],
      copyWorkspaceFile: copyWindowsFileObject,
      revealWorkspaceFile: revealWindowsFile,
    })
    : null;
  const publicMiniAppServer = config.miniApp.enabled && config.miniApp.quickTunnel.enabled
    ? new MiniAppServer({
      ...serverOptions,
      host: config.miniApp.host,
      port: config.miniApp.quickTunnel.publicPort,
      requireTelegramAuth: true,
    })
    : null;
  const defaultDataDirectory = path.join(agentHubRoot, "data");
  const logDirectory = samePath(config.dataDir, defaultDataDirectory)
    ? agentHubRoot
    : config.dataDir;
  installRotatingConsole({
    stdoutFile: path.join(logDirectory, "agent-hub.log"),
    stderrFile: path.join(logDirectory, "agent-hub-error.log"),
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
    mirror: process.stdout.isTTY || process.stderr.isTTY,
  });

  await mkdir(path.dirname(stateFile), { recursive: true });
  const usdRubRateStore = new UsdRubRateStore({ cacheFile: exchangeRatesFile });
  await usdRubRateStore.load().catch((error) => {
    console.warn(`Cannot load cached exchange rate: ${error.message}`);
  });
  void usdRubRateStore.refresh().then((rate) => {
    console.log(`USD/RUB rate refreshed from CBR: ${rate.usdRub}`);
  }).catch((error) => {
    console.warn(`Cannot refresh USD/RUB rate from CBR; cached value remains active: ${error.message}`);
  });

  const instanceGuard = new SingleInstanceGuard({ dataDir: config.dataDir, lockFile: instanceLockFile });
  await instanceGuard.acquire();
  const runtimeStateStore = new RuntimeStateStore({
    dataDir: config.dataDir,
    legacyFile: stateFile,
    legacyBackupFile: stateBackupFile,
  });
  const taskReadStateStore = new TaskReadStateStore({ dataDir: config.dataDir });
  const bindingsMigration = await migrateMessageBindings(config.dataDir);
  if (bindingsMigration.imported || bindingsMigration.archived.length) {
    console.log(
      `Telegram bindings migrated to runtime.sqlite: ${bindingsMigration.count}; archived legacy paths: ${bindingsMigration.archived.length}`,
    );
  }
  const turnEndNotifications = new TurnEndNotificationRegistry();
  const runtimeNotificationController = new RuntimeNotificationController({
    config,
    moduleRoot: agentHubRoot,
    runProcess: captureProcess,
    stopProcess: (worker) => stopProcessTree(worker.pid),
  });
  const runJournal = new RunJournalService({
    usageStore: workLogUsageStore,
    workspaceCatalogStore,
    findProject,
    defaultProjectRoot: config.projectRoot,
    projectionProjectRoots: globalWorkLogProjectRoots,
    legacyLedgerFile: legacyWorkLogLedgerFile,
    legacyWorkLogFile,
  });
  const runtimeCommandServer = new RuntimeCommandServer({
    runtimeRoot: runtimeCommandRoot,
    authorize: authorizeRuntimeCommand,
    reconcile: reconcileRuntimeCommand,
    handler: handleRuntimeCommand,
  });
  const rateLimitHistoryStore = new RateLimitHistoryStore({
    databaseFile: journalDatabaseFile,
    rawFile: path.join(config.dataDir, "rate-limits-raw.jsonl"),
    csvFile: path.join(config.dataDir, "rate-limits.csv"),
  });
  const retiredRateLimitExports = await rateLimitHistoryStore.retireCompatibilityExports();
  if (retiredRateLimitExports.retired) {
    console.log(
      `Retired ${retiredRateLimitExports.removed.length} legacy rate-limit export file(s)`,
    );
  }

  return {
    trustedDeviceStore,
    codexRolloutContextSanitizer,
    workLogUsageStore,
    workspaceCatalogStore,
    preTurnInstructions,
    taskBoard,
    hubMcpService,
    hubMcpServer,
    miniAppServer,
    publicMiniAppServer,
    usdRubRateStore,
    instanceGuard,
    runtimeStateStore,
    taskReadStateStore,
    turnEndNotifications,
    runtimeNotificationController,
    runJournal,
    runtimeCommandServer,
    rateLimitHistoryStore,
  };
}

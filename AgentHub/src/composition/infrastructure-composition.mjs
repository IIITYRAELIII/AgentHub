import { execFile } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { RunJournalService } from "../application/run-journal-service.mjs";
import { HubMcpService } from "../application/hub-mcp-service.mjs";
import { TurnEndNotificationRegistry } from "../application/turn-end-notifications.mjs";
import { createWorkLogUsageStore } from "../application/work-log-usage-store.mjs";
import { TaskBoardService } from "../application/task-board-service.mjs";
import { TaskReleasePlanService } from "../application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../application/workspace-release-preflight-service.mjs";
import { WorkspaceReleaseService } from "../application/workspace-release-service.mjs";
import { StreamHandoffService } from "../application/stream-handoff-service.mjs";
import { AGENT_HUB_VERSION } from "../infrastructure/filesystem/agent-hub-package.mjs";
import { samePath } from "../infrastructure/filesystem/config.mjs";
import { TaskGitWorkspaceService } from "../infrastructure/filesystem/task-git-workspace.mjs";
import { AttachmentThumbnailService } from "../infrastructure/media/attachment-thumbnail-service.mjs";
import { runtimeLayout, runtimeReleaseDirectory } from "../infrastructure/filesystem/runtime-layout.mjs";
import { UsdRubRateStore } from "../infrastructure/network/exchange-rate.mjs";
import { migrateMessageBindings } from "../infrastructure/persistence/message-bindings.mjs";
import { RateLimitHistoryStore } from "../infrastructure/persistence/rate-limit-history.mjs";
import { ProviderTurnTelemetryStore } from "../infrastructure/persistence/provider-turn-telemetry-store.mjs";
import { PreTurnInstructionStore } from "../infrastructure/persistence/pre-turn-instruction-store.mjs";
import { installRotatingConsole } from "../infrastructure/persistence/rotating-log.mjs";
import { RuntimeStateStore } from "../infrastructure/persistence/runtime-state-store.mjs";
import { SharedSqliteRecoveryCoordinator } from "../infrastructure/persistence/shared-sqlite-recovery.mjs";
import { TaskReadStateStore } from "../infrastructure/persistence/task-read-state-store.mjs";
import { TrustedDeviceStore } from "../infrastructure/persistence/trusted-device-store.mjs";
import { WorkspaceCatalogStore } from "../infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../infrastructure/persistence/task-board-store.mjs";
import { WorkLogUsageRepository } from "../infrastructure/persistence/work-log-usage-repository.mjs";
import { WorkLogUsageSyncWorkerStore } from "../runtime/work-log-usage-sync-worker-client.mjs";
import { UsageSyncIdentityStore } from "../infrastructure/persistence/usage-sync-identity-store.mjs";
import { UsageSyncRemoteConfigStore } from "../infrastructure/persistence/usage-sync-remote-config-store.mjs";
import { defaultUsageSyncServerUrl } from "../domain/default-usage-sync-server.mjs";
import { verifyWorkspaceReleasePublication } from "../infrastructure/persistence/release-publication-verifier.mjs";
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
import {
  CodexTerraVoiceTranscriber,
  ensureDashBotTerraStream,
} from "../providers/codex/codex-terra-voice-transcriber.mjs";
import { RuntimeNotificationController } from "../runtime/runtime-notification-controller.mjs";
import { readTestContourStatus, startTestContour } from "../runtime/test-contour-manager.mjs";
import { sentryDiagnostics } from "../infrastructure/diagnostics/sentry-diagnostics.mjs";
import { createCommandTraceComposition } from "./command-trace-composition.mjs";

const execFileAsync = promisify(execFile);
const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;

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

function gitConfigValue(text, sectionName, keyName) {
  let section = "";
  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (!assignment || section !== sectionName) continue;
    if (assignment[1].trim().toLowerCase() === keyName) return assignment[2].trim();
  }
  return "";
}

function normalizeGithubLogin(value) {
  const login = String(value ?? "").trim();
  return GITHUB_LOGIN_PATTERN.test(login) ? login : "";
}

async function usageSyncDeviceLabelFromGitConfig(utilitiesRoot) {
  try {
    const config = await readFile(path.join(utilitiesRoot, ".git", "config"), "utf8");
    return normalizeGithubLogin(gitConfigValue(config, "utilities", "participantlogin"));
  } catch {
    return "";
  }
}

function jsonObjectFromCommandOutput(value) {
  const text = String(value ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function usageSyncDeviceLabelFromTeamProfile(utilitiesRoot) {
  const script = path.join(utilitiesRoot, "AI_INFRA_SETUP", "team_profile.py");
  try {
    const { stdout } = await execFileAsync(
      process.env.PYTHON || "python",
      [script, "changelog-author"],
      {
        cwd: utilitiesRoot,
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    );
    return normalizeGithubLogin(jsonObjectFromCommandOutput(stdout)?.github_login);
  } catch {
    return "";
  }
}

export async function usageSyncDeviceLabel(agentHubRoot) {
  const utilitiesRoot = path.dirname(agentHubRoot);
  return await usageSyncDeviceLabelFromGitConfig(utilitiesRoot)
    || await usageSyncDeviceLabelFromTeamProfile(utilitiesRoot);
}

async function usageSyncIdentity(config, agentHubRoot) {
  const store = new UsageSyncIdentityStore({
    file: path.join(config.dataDir, "usage-sync-identity.json"),
    dataDir: path.resolve(config.dataDir),
  });
  await store.load();
  const label = await usageSyncDeviceLabel(agentHubRoot);
  if (label && label !== store.label) await store.setLabel(label);
  return store;
}

async function resolveReleaseTestContourSource(repositories) {
  for (const repository of repositories) {
    const sourceRoot = path.join(repository.worktreeRoot, "AgentHub");
    try {
      await access(path.join(sourceRoot, "test-contour.mjs"));
      return { ...repository, sourceRoot };
    } catch {}
  }
  throw new Error("release preflight could not locate AgentHub in an integrated dev worktree");
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
  sentryDiagnostics.configure({
    ...config.diagnostics.sentry,
    release: config.diagnostics.sentry.release || `agent-hub@${AGENT_HUB_VERSION}`,
  });
  const instanceGuard = new SingleInstanceGuard({ dataDir: config.dataDir, lockFile: instanceLockFile });
  await instanceGuard.acquire();
  const sqliteRecoveryCoordinator = new SharedSqliteRecoveryCoordinator({
    databaseFile: journalDatabaseFile,
    instanceId: instanceGuard.instanceToken,
    captureException: (error, context) => sentryDiagnostics.captureException(error, context),
  });
  let sqliteRecovery;
  let commandTrace;
  try {
    sqliteRecovery = await sqliteRecoveryCoordinator.prepare();
  const localTrustedDeviceStore = new TrustedDeviceStore({
    filePath: path.join(config.dataDir, "trusted-devices.json"),
    // Signatures without the verifier origin are rejected unless an operator
    // explicitly keeps a not yet rebuilt Android client working.
    allowLegacySessions: process.env.AGENT_HUB_LEGACY_DEVICE_SESSIONS === "1",
  });
  await localTrustedDeviceStore.load();
  const trustedDeviceStore = new TrustedDeviceRegistry(localTrustedDeviceStore);
  const codexRolloutContextSanitizer = new CodexRolloutContextSanitizer({
    ...config.codexRolloutContext,
  });
  const workspaceCatalogStore = new WorkspaceCatalogStore({
    databaseFile: journalDatabaseFile,
  });
  const taskBoardStore = new TaskBoardStore({ databaseFile: journalDatabaseFile });
  await workspaceCatalogStore.load();
  const preTurnInstructions = new PreTurnInstructionStore({
    guideFile: path.join(agentHubRoot, "AGENT_HUB_GUIDE.md"),
    globalFile: path.join(config.dataDir, "global-pre-turn-instructions.md"),
  });
  await preTurnInstructions.loadGuide();
  const dashBotStream = config.taskBoard.triageEnabled
    ? ensureDashBotStream(workspaceCatalogStore, {
      model: config.taskBoard.triageModel,
      projectRoot: config.projectRoot,
    })
    : null;
  const existingDashBotStream = dashBotStream ?? workspaceCatalogStore.hierarchy()
    .find((workspace) => workspace.name === "Other")?.streams
    .find((stream) => stream.name === "DashBot") ?? null;
  const dashBotTerraStream = ensureDashBotTerraStream(workspaceCatalogStore, {
    firstStreamId: existingDashBotStream?.id ?? null,
    projectRoot: config.projectRoot,
  });
  const taskVoiceTranscriber = new CodexTerraVoiceTranscriber({
    requestedExecutable: config.codexExecutable,
    executableArgs: config.codexExecutableArgs,
    projectRoot: config.projectRoot,
    pythonExe: config.pythonExe,
    transcribeScript: path.join(agentHubRoot, "transcribe.py"),
    whisperModel: config.whisperModel,
    whisperModelDir: config.whisperModelDir,
    whisperDevice: config.whisperDevice,
    stopProcess: (worker) => stopProcessTree(worker.pid),
    workspaceCatalog: workspaceCatalogStore,
    streamId: dashBotTerraStream.id,
  });
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
  const workLogUsageIdentityStore = await usageSyncIdentity(config, agentHubRoot);
  const workLogUsageRemoteConfigStore = new UsageSyncRemoteConfigStore({
    file: path.join(config.dataDir, "usage-sync-remote.json"),
    defaultServerUrl: defaultUsageSyncServerUrl(),
  });
  const workLogUsageSyncDeviceId = workLogUsageIdentityStore.deviceId;
  const workLogUsageSyncStore = new WorkLogUsageSyncWorkerStore({
    databaseFile: journalDatabaseFile,
    legacyFile: path.join(config.dataDir, "work-log-usage-sync.json"),
    deviceId: workLogUsageSyncDeviceId,
  });
  const adoptedUsageSyncEvents = await workLogUsageSyncStore
    .adoptDeviceIds(workLogUsageIdentityStore.legacyDeviceIds);
  if (adoptedUsageSyncEvents.migrated) {
    console.log(
      `Adopted ${adoptedUsageSyncEvents.migrated} usage sync event(s) onto device ${workLogUsageSyncDeviceId}`,
    );
  }
  const workLogUsageStore = createWorkLogUsageStore({
    repositoryFactory: (options) => new WorkLogUsageRepository(options),
    ledgerFile: legacyWorkLogLedgerFile,
    databaseFile: journalDatabaseFile,
    defaultProjectRoot: config.projectRoot,
    usageSyncStore: workLogUsageSyncStore,
    usageSyncDeviceId: workLogUsageSyncDeviceId,
    usageSyncDeviceLabel: workLogUsageIdentityStore.label,
    workspaceCatalogStore,
  });
  const streamHandoff = new StreamHandoffService({
    workspaceCatalog: workspaceCatalogStore,
    workLog: workLogUsageStore,
  });
  const attachmentDirectory = path.join(runtimeCommandRoot, "attachments");
  const attachmentThumbnails = new AttachmentThumbnailService({
    attachmentRoot: attachmentDirectory,
    pythonExe: config.pythonExe,
  });
  const hubMcpSecret = await ensureLocalWebSecret(path.join(runtimeCommandRoot, "hub-mcp.secret"));
  const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir: config.dataDir });
  const taskReleasePlanner = new TaskReleasePlanService({ taskBoard, taskGitWorkspaces });
  const workspaceReleasePreflight = new WorkspaceReleasePreflightService({
    releasePlanner: taskReleasePlanner,
    taskGitWorkspaces,
    resolveTestContourSource: resolveReleaseTestContourSource,
    refreshTestContour: ({ sourceRoot }) => startTestContour({
      refresh: true,
      sourceRoot,
      entryFile: path.join(sourceRoot, "test-contour.mjs"),
    }),
    readTestContourStatus,
  });
  const workspaceReleaseService = new WorkspaceReleaseService({
    store: taskBoardStore,
    releasePlanner: taskReleasePlanner,
    verifyPublication: verifyWorkspaceReleasePublication,
  });
  const hubMcpService = new HubMcpService({
    workspaceCatalog: workspaceCatalogStore,
    taskBoard,
    workLog: workLogUsageStore,
    attachmentDirectory,
    secret: hubMcpSecret,
    releasePlanner: taskReleasePlanner,
    releasePreflight: workspaceReleasePreflight,
    releaseCompleter: workspaceReleaseService,
    taskGitWorkspaces,
  });
  const hubMcpServer = new HubMcpServer({
    service: hubMcpService,
    secret: hubMcpSecret,
    captureUnexpectedException: (error, context) => sentryDiagnostics.captureUnexpectedException(error, context),
  });
  const serverOptions = {
    botToken: config.token,
    allowedUserIds: config.allowedUserIds,
    telegramRuntime: config.components.telegram === true,
    deviceStore: trustedDeviceStore,
    controlHandler: handleDesktopControl,
    onControlResultDelivered: ({ id }) => forgetDesktopControl(id),
    attachmentDirectory,
    attachmentThumbnails,
    assetBundleProvider: runtimeAssetBundleProvider(runtimeCommandRoot),
    journalDatabaseFile,
    usageSyncRemoteConfigStore: workLogUsageRemoteConfigStore,
    workspaceFileRoots: [config.projectRoot, ...config.projects.map((project) => project.path)],
    recordCommandTrace: (span) => commandTrace?.service?.recordBestEffort?.(span) ?? false,
    reportUnexpectedError: (error, context) => sentryDiagnostics.captureUnexpectedException(error, context),
  };
  const miniAppServer = config.miniApp.enabled
    ? new MiniAppServer({
      ...config.miniApp,
      ...serverOptions,
      localAccessSecret: localWebSecret,
      localAccessSecretFile: path.join(runtimeCommandRoot, "local-web.secret"),
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
  commandTrace = createCommandTraceComposition({ dataDir: config.dataDir });
  await commandTrace.initialize();
  const usdRubRateStore = new UsdRubRateStore({ cacheFile: exchangeRatesFile });
  await usdRubRateStore.load().catch((error) => {
    console.warn(`Cannot load cached exchange rate: ${error.message}`);
  });
  void usdRubRateStore.refresh().then((rate) => {
    console.log(`USD/RUB rate refreshed from CBR: ${rate.usdRub}`);
  }).catch((error) => {
    console.warn(`Cannot refresh USD/RUB rate from CBR; cached value remains active: ${error.message}`);
  });

  const runtimeStateStore = new RuntimeStateStore({
    dataDir: config.dataDir,
    legacyFile: stateFile,
    legacyBackupFile: stateBackupFile,
    commandTrace: commandTrace.service,
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
    temporaryRoot: path.join(config.projectRoot, ".agent-hub", "runtime"),
    authorize: authorizeRuntimeCommand,
    reconcile: reconcileRuntimeCommand,
    handler: handleRuntimeCommand,
    captureException: (error, context) => sentryDiagnostics.captureException(error, context),
    captureUnexpectedException: (error, context) => sentryDiagnostics.captureUnexpectedException(error, context),
  });
  const rateLimitHistoryStore = new RateLimitHistoryStore({
    databaseFile: journalDatabaseFile,
    rawFile: path.join(config.dataDir, "rate-limits-raw.jsonl"),
    csvFile: path.join(config.dataDir, "rate-limits.csv"),
  });
  const providerTurnTelemetryStore = new ProviderTurnTelemetryStore({
    databaseFile: journalDatabaseFile,
  });
  await providerTurnTelemetryStore.initialize();
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
    workLogUsageIdentityStore,
    workLogUsageRemoteConfigStore,
    workspaceCatalogStore,
    taskReleasePlanner,
    workspaceReleasePreflight,
    workspaceReleaseService,
    streamHandoff,
    preTurnInstructions,
    taskBoard,
    taskGitWorkspaces,
    taskVoiceTranscriber,
    hubMcpService,
    hubMcpServer,
    miniAppServer,
    publicMiniAppServer,
    attachmentThumbnails,
    usdRubRateStore,
    instanceGuard,
    runtimeStateStore,
    taskReadStateStore,
    turnEndNotifications,
    runtimeNotificationController,
    runJournal,
    runtimeCommandServer,
    rateLimitHistoryStore,
    providerTurnTelemetryStore,
    commandTrace,
    commandTraceService: commandTrace.service,
    sqliteRecovery,
    acknowledgeSqliteRecovery: () => sqliteRecoveryCoordinator.acknowledge(sqliteRecovery),
  };
  } catch (error) {
    sentryDiagnostics.captureException(error, {
      surface: "server",
      kind: "startup",
      component: "infrastructure-composition",
      action: "initialize",
    });
    await commandTrace?.close?.().catch(() => {});
    await instanceGuard.release();
    throw error;
  }
}

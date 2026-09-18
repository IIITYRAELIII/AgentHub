import { execFile } from "node:child_process";
import { createContourExternalEffects } from "../infrastructure/filesystem/test-contour-external-effects.mjs";
import { reconcileContourAwareStartupGit, refreshContourAwareExchangeRate } from "../application/contour-effect-operations.mjs";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { homedir } from "node:os";
import { promisify } from "node:util";

import { RunJournalService } from "../application/run-journal-service.mjs";
import { HubMcpService } from "../application/hub-mcp-service.mjs";
import { TaskLifecycleService } from "../application/task-lifecycle-service.mjs";
import { McpAdmissionCoordinator } from "../application/mcp-admission-coordinator.mjs";
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
import { ReleaseGitWorkspaceService } from "../infrastructure/filesystem/release-git-workspace.mjs";
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
import { createRepositoryProductionValidationAdapter } from "../infrastructure/process/repository-production-validation.mjs";
import {
  copyWindowsFileObject,
  revealWindowsFile,
} from "../infrastructure/process/windows-file-clipboard.mjs";
import { MiniAppServer } from "../interfaces/web/mini-app-server.mjs";
import { HubMcpServer } from "../interfaces/mcp/hub-mcp-server.mjs";
import { agentHubRuntimeHealth } from "../application/runtime-health.mjs";
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
import { sentryDiagnostics } from "../infrastructure/diagnostics/sentry-diagnostics.mjs";
import { readPublicationState } from "../infrastructure/persistence/publication-state.mjs";
import { createCommandTraceComposition, measureStartupBeforeTrace } from "./command-trace-composition.mjs";
import { createPersistenceMutationCapabilities } from "./persistence-mutation-composition.mjs";

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

function testContourRuntimeIdentity(environment = process.env) {
  if (environment.AGENT_HUB_TEST_CONTOUR !== "1") return null;
  const expectedPort = Number(environment.AGENT_HUB_TEST_CONTOUR_PORT);
  const identity = {
    contourId: String(environment.AGENT_HUB_TEST_CONTOUR_ID ?? "").trim(),
    operationId: String(environment.AGENT_HUB_TEST_CONTOUR_OPERATION_ID ?? "").trim() || null,
    releaseId: String(environment.AGENT_HUB_RELEASE_ID ?? "").trim(),
    model: String(environment.CODEX_MODEL ?? "").trim(),
    expectedPort,
    runtimeNonce: String(environment.AGENT_HUB_TEST_CONTOUR_RUNTIME_NONCE ?? "").trim(),
  };
  if (!identity.contourId || !identity.releaseId || !identity.model || !identity.runtimeNonce
      || !Number.isInteger(expectedPort) || expectedPort <= 0) {
    throw new Error("Test Contour runtime identity environment is incomplete");
  }
  return identity;
}

export async function recoverTaskBoardStartup(taskBoard) {
  try {
    return await taskBoard.recoverPendingTriage();
  } catch (error) {
    throw new Error("Task triage startup recovery failed", { cause: error });
  }
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

function usageSyncRuntimeHomeIds(identityStore) {
  return {
    codex: identityStore.runtimeHomeId(process.env.CODEX_HOME || path.join(homedir(), ".codex")),
    claude: identityStore.runtimeHomeId(process.env.CLAUDE_CONFIG_DIR || homedir()),
  };
}

export async function resolveReleaseValidationSource(repositories) {
  for (const repository of repositories) {
    const sourceRoot = path.join(repository.worktreeRoot, "AgentHub");
    try {
      await access(path.join(sourceRoot, "publish-changed.mjs"));
      return { kind: "workspace-release-pipeline", ...repository, sourceRoot };
    } catch {}
  }
  return {
    kind: "external-validation-required",
    repositories,
    reason: "release preflight requires an explicit repository-owned production validation gate for non-AgentHub repositories",
  };
}

export async function createHubInfrastructure({
  config,
  agentHubRoot,
  runtimeCommandRoot, localWebSecret,
  serverInstanceId, serverReleaseId,
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
  const defaultDataDirectory = path.join(agentHubRoot, "data");
  const logDirectory = samePath(config.dataDir, defaultDataDirectory)
    ? agentHubRoot
    : config.dataDir;
  await mkdir(logDirectory, { recursive: true });
  installRotatingConsole({
    stdoutFile: path.join(logDirectory, "agent-hub.log"),
    stderrFile: path.join(logDirectory, "agent-hub-error.log"),
    maxBytes: config.logMaxBytes,
    maxFiles: config.logMaxFiles,
    mirror: process.stdout.isTTY || process.stderr.isTTY,
  });
  const startupRecords = [];
  const startupStep = async (stage, operation) => {
    const measured = await measureStartupBeforeTrace(stage, operation);
    startupRecords.push(measured.record);
    return measured.value;
  };
  sentryDiagnostics.configure({
    ...config.diagnostics.sentry,
    release: config.diagnostics.sentry.release || `agent-hub@${AGENT_HUB_VERSION}`,
  });
  const instanceGuard = new SingleInstanceGuard({ dataDir: config.dataDir, lockFile: instanceLockFile });
  await startupStep("instance-lock", () => instanceGuard.acquire());
  const sqliteRecoveryCoordinator = new SharedSqliteRecoveryCoordinator({
    databaseFile: journalDatabaseFile,
    instanceId: instanceGuard.instanceToken,
    captureException: (error, context) => sentryDiagnostics.captureException(error, context),
  });
  let sqliteRecovery;
  let commandTrace;
  try {
    sqliteRecovery = await startupStep("sqlite-recovery", () => sqliteRecoveryCoordinator.prepare());
  const localTrustedDeviceStore = new TrustedDeviceStore({
    filePath: path.join(config.dataDir, "trusted-devices.json"),
    // Signatures without the verifier origin are rejected unless an operator
    // explicitly keeps a not yet rebuilt Android client working.
    allowLegacySessions: process.env.AGENT_HUB_LEGACY_DEVICE_SESSIONS === "1",
  });
  await startupStep("trusted-devices", () => localTrustedDeviceStore.load());
  const trustedDeviceStore = new TrustedDeviceRegistry(localTrustedDeviceStore);
  const codexRolloutContextSanitizer = new CodexRolloutContextSanitizer({
    ...config.codexRolloutContext,
  });
  const rawWorkspaceCatalogStore = await startupStep("workspace-store-open", () => new WorkspaceCatalogStore({
    databaseFile: journalDatabaseFile,
  }));
  const rawTaskBoardStore = await startupStep("task-board-open", () => new TaskBoardStore({ databaseFile: journalDatabaseFile }));
  await startupStep("workspace-catalog-load", () => rawWorkspaceCatalogStore.load());
  const preTurnInstructions = new PreTurnInstructionStore({
    guideFile: path.join(agentHubRoot, "AGENT_HUB_GUIDE.md"),
    globalFile: path.join(config.dataDir, "global-pre-turn-instructions.md"),
  });
  await startupStep("pre-turn-guide", () => preTurnInstructions.loadGuide());
  const dashBotStream = config.taskBoard.triageEnabled
    ? await startupStep("dashbot-stream", () => rawWorkspaceCatalogStore.runMutation(() => ensureDashBotStream(rawWorkspaceCatalogStore, {
      model: config.taskBoard.triageModel,
      projectRoot: config.projectRoot,
    })))
    : null;
  const existingDashBotStream = dashBotStream ?? rawWorkspaceCatalogStore.hierarchy()
    .find((workspace) => workspace.name === "Other")?.streams
    .find((stream) => stream.name === "DashBot") ?? null;
  const dashBotTerraStream = await startupStep("dashbot-terra-stream", () => rawWorkspaceCatalogStore.runMutation(() => ensureDashBotTerraStream(rawWorkspaceCatalogStore, {
    firstStreamId: existingDashBotStream?.id ?? null,
    projectRoot: config.projectRoot,
  })));
  const { workspaceCatalogStore, taskBoardStore } = createPersistenceMutationCapabilities({
    rawWorkspaceCatalogStore,
    rawTaskBoardStore,
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
  await startupStep("task-board-recovery", () => recoverTaskBoardStartup(taskBoard));
  const workLogUsageIdentityStore = await usageSyncIdentity(config, agentHubRoot);
  const workLogUsageRemoteConfigStore = new UsageSyncRemoteConfigStore({
    file: path.join(config.dataDir, "usage-sync-remote.json"),
    defaultServerUrl: defaultUsageSyncServerUrl(),
  });
  const workLogUsageSyncDeviceId = workLogUsageIdentityStore.deviceId;
  const workLogUsageRuntimeHomeIds = usageSyncRuntimeHomeIds(workLogUsageIdentityStore);
  const workLogUsageSyncStore = new WorkLogUsageSyncWorkerStore({
    databaseFile: journalDatabaseFile,
    legacyFile: path.join(config.dataDir, "work-log-usage-sync.json"),
    deviceId: workLogUsageSyncDeviceId,
    defaultRuntimeHomeIds: workLogUsageRuntimeHomeIds,
  });
  const adoptedUsageSyncEvents = await startupStep("usage-sync-device-adoption", () => workLogUsageSyncStore
    .adoptDeviceIds(workLogUsageIdentityStore.legacyDeviceIds));
  if (adoptedUsageSyncEvents.migrated) {
    console.log(
      `Adopted ${adoptedUsageSyncEvents.migrated} usage sync event(s) onto device ${workLogUsageSyncDeviceId}`,
    );
  }
  const workLogUsageStore = await startupStep("usage-store-open", () => createWorkLogUsageStore({
    repositoryFactory: (options) => new WorkLogUsageRepository(options),
    ledgerFile: legacyWorkLogLedgerFile,
    databaseFile: journalDatabaseFile,
    defaultProjectRoot: config.projectRoot,
    usageSyncStore: workLogUsageSyncStore,
    usageSyncDeviceId: workLogUsageSyncDeviceId,
    usageSyncDeviceLabel: workLogUsageIdentityStore.label,
    usageSyncRuntimeHomeIds: workLogUsageRuntimeHomeIds,
    usageSyncIdentity: workLogUsageIdentityStore,
    workspaceCatalogStore,
  }));
  agentHubRuntimeHealth.setDiagnosticSource("usageSync", () => workLogUsageSyncStore.diagnostics());
  agentHubRuntimeHealth.setDiagnosticSource("journal", () => workLogUsageStore.diagnostics());
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
  const contourExternalEffects = config.testContourRecording
    ? createContourExternalEffects({ root: config.testContourRecording.root })
    : null;
  const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir: config.dataDir, contourExternalEffects });
  const releaseGitWorkspaces = new ReleaseGitWorkspaceService({ dataDir: config.dataDir, contourExternalEffects });
  const registeredReleaseProjectRoots = workspaceCatalogStore.hierarchy()
    .filter((workspace) => workspace.settings?.releaseWorkflowEnabled === true)
    .map((workspace) => ({
      workspaceId: workspace.id,
      projectRoot: String(workspace.settings?.workingDirectory ?? "").trim() || config.projectRoot,
      registrationSource: String(workspace.settings?.workingDirectory ?? "").trim()
        ? "workspace_setting"
        : "runtime_default",
    }))
    .filter((workspace) => workspace.projectRoot);
  const { releaseReconciliation, taskGitReconciliation } = await reconcileContourAwareStartupGit({
    policy: contourExternalEffects, releaseGitWorkspaces, taskGitWorkspaces,
    projectRoots: registeredReleaseProjectRoots, startupStep,
  });
  agentHubRuntimeHealth.setDiagnosticSource("taskGit", () => taskGitReconciliation);
  agentHubRuntimeHealth.setDiagnosticSource("releaseGit", () => contourExternalEffects ? releaseReconciliation : releaseGitWorkspaces.diagnostics());
  for (const repository of releaseReconciliation.repositories.filter((item) => item.status !== "ready")) {
    console.warn(`Release repository requires manual reconciliation: ${repository.reason}`);
  }
  for (const repository of taskGitReconciliation.repositories.filter((item) => item.status === "blocked")) {
    console.warn(`Task Git repository requires manual reconciliation: ${repository.reason}`);
  }
  const taskReleasePlanner = new TaskReleasePlanService({ taskBoard, taskGitWorkspaces });
  const workspaceReleasePreflight = new WorkspaceReleasePreflightService({
    releasePlanner: taskReleasePlanner,
    taskGitWorkspaces,
    releaseGitWorkspaces,
    resolveReleaseValidationSource,
    readPublicationState,
    validateProductionCandidate: createRepositoryProductionValidationAdapter({
      policies: config.releaseValidation?.repositories ?? [],
      dataDir: path.join(config.dataDir, "release-validation"),
    }),
  });
  const taskLifecycle = new TaskLifecycleService({
    taskBoard,
    workspaceCatalog: workspaceCatalogStore,
    taskGitWorkspaces,
    releasePreflight: workspaceReleasePreflight,
  });
  const workspaceReleaseService = new WorkspaceReleaseService({
    store: taskBoardStore,
    releasePlanner: taskReleasePlanner,
    releaseGitWorkspaces,
    taskGitWorkspaces,
    releasePreflight: workspaceReleasePreflight,
    verifyPublication: verifyWorkspaceReleasePublication,
  });
  const hubMcpService = new HubMcpService({
    workspaceCatalog: workspaceCatalogStore,
    taskBoard,
    taskLifecycle,
    workLog: workLogUsageStore,
    attachmentDirectory,
    secret: hubMcpSecret,
    releasePlanner: taskReleasePlanner,
    releasePreflight: workspaceReleasePreflight,
    releaseCompleter: workspaceReleaseService,
    taskGitWorkspaces,
    releaseGitWorkspaces,
  });
  agentHubRuntimeHealth.setDiagnosticSource("sqliteContention", () => (
    hubMcpService.databaseContentionDiagnostics()
  ));
  const mcpAdmissionCoordinator = new McpAdmissionCoordinator();
  const hubMcpServer = new HubMcpServer({
    service: hubMcpService,
    secret: hubMcpSecret,
    mcpAdmissionCoordinator,
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
    journalProjectionService: {
      ensureAccountUsageProjectionCurrent: (options = {}) => (
        workLogUsageStore.ensureAccountUsageProjectionCurrent({
          projectRoot: config.projectRoot,
          projectionProjectRoots: globalWorkLogProjectRoots,
          ...options,
        })
      ),
    },
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
      testContourRuntimeIdentity: testContourRuntimeIdentity(),
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
  await mkdir(path.dirname(stateFile), { recursive: true });
  commandTrace = createCommandTraceComposition({ dataDir: config.dataDir,
    instanceId: serverInstanceId, releaseId: serverReleaseId,
    readHealth: () => agentHubRuntimeHealth.snapshot() });
  await startupStep("command-trace-initialize", () => commandTrace.initialize());
  for (const record of startupRecords) record(commandTrace.service);
  workLogUsageSyncStore.setTraceService(commandTrace.service);
  const usdRubRateStore = new UsdRubRateStore({ cacheFile: exchangeRatesFile });
  await usdRubRateStore.load().catch((error) => {
    console.warn(`Cannot load cached exchange rate: ${error.message}`);
  });
  void refreshContourAwareExchangeRate({ policy: contourExternalEffects, store: usdRubRateStore }).then((rate) => {
    if (rate.skipped) return;
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
  await taskReadStateStore.initialize();
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
    contourExternalEffects,
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
    taskLifecycle,
    taskGitWorkspaces,
    releaseGitWorkspaces,
    taskVoiceTranscriber,
    hubMcpService,
    hubMcpServer,
    mcpAdmissionCoordinator,
    miniAppServer,
    publicMiniAppServer,
    attachmentDirectory,
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

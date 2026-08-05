import { RateLimitTelemetryService } from "../application/rate-limit-telemetry-service.mjs";
import { createCodexAssistantAttachmentImporter } from "../providers/codex/codex-assistant-attachments.mjs";
import { ApprovalController } from "../interfaces/telegram/approval-controller.mjs";
import { MediaController } from "../interfaces/telegram/media-controller.mjs";
import { TelegramClient } from "../infrastructure/telegram/telegram-client.mjs";
import { TelegramSettingsMenu } from "../interfaces/telegram/telegram-settings-menu.mjs";
import { TelegramStatusController } from "../interfaces/telegram/telegram-status-controller.mjs";
import { randomStatusHeaderFileName } from "../interfaces/telegram/status-header.mjs";
import { DeferredInputPresentationService } from "../interfaces/desktop/deferred-input-presentation-service.mjs";
import { DesktopAttachmentService } from "../interfaces/desktop/desktop-attachment-service.mjs";
import { DirectGatewayController, loadDirectGatewaySettings } from "../interfaces/web/direct-gateway.mjs";
import { MiniAppLifecycleService } from "../interfaces/web/mini-app-lifecycle-service.mjs";
import { MiniAppPublisher } from "../interfaces/web/mini-app-publisher.mjs";
import { miniAppMenuButtonRequests } from "../interfaces/web/mini-app-server.mjs";
import { QuickTunnelController } from "../infrastructure/network/quick-tunnel.mjs";

export async function createClientInterfaceComposition({
  config,
  token,
  botMenu,
  statusHeaderDirectory,
  statusMediaFileIds,
  saveState,
  currentChatId,
  currentProvider,
  telegramLimit,
  miniAppServer,
  publicMiniAppServer,
  runtimeCommandRoot,
  journalDatabaseFile,
  handleDesktopControl,
  reconcileRemoteDesktopControl,
  forgetDesktopControl,
  trustedDeviceUserId,
  desktopMessageReceipts,
  projects,
  codexModels,
  claudeModels,
  claudeModelLabels,
  reasoningEfforts,
  reasoningLabels,
  collaborationModes,
  collaborationModeLabels,
  uiCallback,
  resolveClaudeInvocation,
  parseClaudeLimits,
  formatClaudeRateLimits,
  formatCodexRateLimits,
  spawnCapture,
  sendRpc,
  codexTransportRunning,
  rateLimitHistoryStore,
  workLogUsageStore,
  runtimeTimers,
  isStopping,
  findProject,
  refreshTaskCatalog,
  currentTaskCatalog,
  currentTaskRuns,
  codexModelLabel,
  agentHubRoot,
  stopProcessTree,
  startTurn,
  activeProjectRoot,
  approvalProtocol,
  autoApprove,
  respondRpc,
  sendRunMessage,
  runExists,
  taskProgress,
}) {
  let mediaController;
  const telegramClient = new TelegramClient({
    token,
    apiBaseUrl: config.telegramApiBaseUrl,
    menu: botMenu,
    statusHeaderDirectory,
    selectStatusHeader: randomStatusHeaderFileName,
    getStatusFileId: (name) => statusMediaFileIds.get(name) ?? null,
    rememberStatusFileId: async (name, fileId) => {
      if (fileId) statusMediaFileIds.set(name, fileId);
      else statusMediaFileIds.delete(name);
      await saveState();
    },
    getDefaultChatId: currentChatId,
    getDefaultProvider: currentProvider,
    rememberSpeechText: (...args) => mediaController?.rememberSpeechText(...args) ?? null,
    messageLimit: telegramLimit,
  });
  const telegram = (method, body) => {
    if (method !== "answerCallbackQuery") return telegramClient.request(method, body);
    telegramClient.answerCallback(body, {
      onError: (error) => console.warn(`Telegram callback acknowledgement failed: ${error.message}`),
    });
    return Promise.resolve(undefined);
  };
  const miniAppLifecycle = new MiniAppLifecycleService({
    config,
    localServer: miniAppServer,
    publicServer: publicMiniAppServer,
    runtimeCommandRoot,
    journalDatabaseFile,
    telegram,
    menuButtonRequests: miniAppMenuButtonRequests,
    loadGatewaySettings: loadDirectGatewaySettings,
    DirectGatewayControllerClass: DirectGatewayController,
    MiniAppPublisherClass: MiniAppPublisher,
    QuickTunnelControllerClass: QuickTunnelController,
    controlHandler: handleDesktopControl,
    controlReconciler: reconcileRemoteDesktopControl,
    forgetControl: forgetDesktopControl,
  });
  const desktopAttachments = new DesktopAttachmentService({
    assistantAttachmentImporterFactory: createCodexAssistantAttachmentImporter,
    runtimeCommandRoot,
    projectRoot: config.projectRoot,
    projectRoots: config.projects.map((project) => project.path),
    workerEnabled: config.miniApp.worker.enabled,
    publisher: () => miniAppLifecycle.publisher,
    trustedUserId: trustedDeviceUserId,
  });
  const telegramMultipart = (method, body, fileField, filePath) => (
    telegramClient.multipart(method, body, fileField, filePath)
  );
  const sendStatusCard = (...args) => telegramClient.sendStatusCard(...args);
  const sendMessage = (...args) => telegramClient.sendMessage(...args);
  const sendMessageTo = (...args) => telegramClient.sendMessageTo(...args);
  const sendLongMessage = (...args) => telegramClient.sendLongMessage(...args);
  const startTyping = () => telegramClient.startTyping();
  const stopTyping = () => telegramClient.stopTyping();
  const deferredInputPresentation = new DeferredInputPresentationService({
    telegram,
    receipts: desktopMessageReceipts,
    describeAttachments: (...args) => desktopAttachments.descriptors(...args),
  });
  const telegramSettingsMenu = new TelegramSettingsMenu({
    projects,
    codexModels,
    claudeModels,
    claudeModelLabels,
    reasoningEfforts,
    reasoningLabels,
    collaborationModes,
    collaborationModeLabels,
    callbackData: uiCallback,
    sendMessage,
  });
  const rateLimitTelemetry = new RateLimitTelemetryService({
    resolveClaudeInvocation,
    parseClaudeLimits,
    formatClaudeRateLimits,
    formatCodexRateLimits,
    spawnCapture,
    readCodexRateLimits: () => sendRpc("account/rateLimits/read", {}, { timeoutMs: 5_000 }),
    codexRunning: codexTransportRunning,
    historyStore: rateLimitHistoryStore,
    workLogUsageStore,
    timers: runtimeTimers,
    isStopping,
  });
  const telegramStatusController = new TelegramStatusController({
    config,
    projects,
    findProject,
    refreshTaskCatalog,
    currentTaskCatalog,
    currentTaskRuns,
    readCodexRateLimits: () => rateLimitTelemetry.readCodex(),
    readClaudeRateLimits: () => rateLimitTelemetry.readClaude(),
    parseClaudeLimits,
    codexModelLabel,
    claudeModelLabels,
    reasoningLabels,
    collaborationModeLabels,
    sendStatusCard,
  });
  mediaController = new MediaController({
    config,
    token,
    agentHubRoot,
    telegram,
    sendMessage: sendMessageTo,
    startTurn,
    activeProjectRoot,
    stopProcessTree,
  });
  await mediaController.load();
  const approvalController = new ApprovalController({
    approvalProtocol,
    autoApprove,
    respond: respondRpc,
    send: sendMessage,
    sendForRun: sendRunMessage,
    runExists,
    setProgressStage: (...args) => taskProgress().setStage(...args),
    telegram,
    currentChatId,
  });
  return {
    telegramClient,
    telegram,
    miniAppLifecycle,
    desktopAttachments,
    desktopAttachmentPaths: (...args) => desktopAttachments.paths(...args),
    isLegacyDesktopAttachmentFile: (...args) => desktopAttachments.isLegacyFile(...args),
    desktopAttachmentDescriptors: (...args) => desktopAttachments.descriptors(...args),
    importCodexDesktopAttachments: (...args) => desktopAttachments.importCodex(...args),
    desktopOpenAttachment: (...args) => desktopAttachments.open(...args),
    telegramMultipart,
    sendStatusCard,
    sendMessage,
    sendMessageTo,
    sendLongMessage,
    startTyping,
    stopTyping,
    deferredInputPresentation,
    telegramSettingsMenu,
    rateLimitTelemetry,
    telegramStatusController,
    mediaController,
    approvalController,
  };
}

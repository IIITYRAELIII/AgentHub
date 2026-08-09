import path from "node:path";
import {
  deferredEditableText,
  deferredResponseAnnotations,
} from "../domain/deferred-input.mjs";
import { fitTaskHistoryPayload } from "../domain/response-budget.mjs";
import { runInputPreview } from "../application/managed-run-lifecycle-service.mjs";
import {
  mergeActiveTaskHistory,
  mergeCompletedTaskHistory,
} from "../application/task-history.mjs";
import { createDesktopReadComposition } from "./desktop-read-composition.mjs";
import { createDesktopSystemComposition } from "./desktop-system-composition.mjs";

export function createDesktopReadSystemWiring({
  config,
  models,
  projects,
  maxSpeechJobs,
  state,
  services,
}) {
  const system = createDesktopSystemComposition({
    config,
    dependencies: {
      activeProvider: state.activeProvider,
      isCodex: state.isCodex,
      preferences: services.preferences,
      codexModelLabel: models.codexModelLabel,
      claudeModelLabels: models.claudeModelLabels,
      reasoningLabels: models.reasoningLabels,
      collaborationModeLabels: models.collaborationModeLabels,
      formattedRateLimits: services.formattedRateLimits,
      activeRunCount: services.activeRunCount,
      backgroundJobCount: services.backgroundJobCount,
      readRateLimitHistory: services.readRateLimitHistory,
      readUsageHistory: services.readUsageHistory,
      refreshCatalog: services.refreshCatalog,
      searchTurns: services.searchTurns,
      projectRoots: () => projects.map((project) => project.path),
      samePath: services.samePath,
      miniAppPublisher: services.miniAppPublisher,
      trustedDeviceStore: services.trustedDeviceStore,
      resolveTask: services.resolveTask,
      lastTaskMessage: services.lastTaskMessage,
      enqueueSpeech: services.enqueueSpeech,
      maxSpeechJobs,
    },
  });

  const read = createDesktopReadComposition({
    snapshot: {
      clock: {
        nowMs: () => Date.now(),
        nowIso: () => new Date().toISOString(),
      },
      context: {
        latestUsage: services.latestContextUsage,
        isCompacting: services.isCompacting,
        compactionFor: services.compactionFor,
      },
      maintenance: {
        entryFor: services.maintenanceFor,
      },
      board: {
        snapshot: services.taskBoardSnapshot,
        workspaces: services.taskBoardWorkspaces,
        layout: services.taskBoardLayout,
      },
      runs: {
        forTask: services.runForTask,
        titleFor: services.runTitle,
      },
      tasks: {
        savedLastMessage: services.lastTaskMessage,
        projectNameFor: (projectRoot) => (
          services.findProject(projectRoot)?.name ?? path.basename(projectRoot)
        ),
        entryIsSelected: services.catalogEntryIsSelected,
        executionRuntimeLabel: services.executionRuntimeLabel,
        orderingActivityAtMs: services.orderingActivityAtMs,
        samePath: services.samePath,
      },
      catalog: {
        entries: services.catalogEntries,
        hierarchy: services.workspaceHierarchy,
        refreshedAt: services.catalogRefreshedAt,
        refresh: services.refreshCatalog,
        merge: services.mergeCatalog,
      },
      selection: {
        selectedTask: state.selectedTask,
        hasThread: state.hasThread,
        selectedTurnTarget: state.selectedTurnTarget,
        activeProject: state.activeProject,
        activeThreadTitle: state.activeThreadTitle,
      },
      settings: {
        current: () => ({
          activeProvider: state.activeProvider(),
          activeProjectRoot: state.activeProjectRoot(),
          ...services.preferencesSnapshot(),
          autoApprove: state.autoApprove(),
          codexModels: models.codexModels,
          codexModelLabel: models.codexModelLabel,
          claudeModels: models.claudeModels,
          claudeModelLabels: models.claudeModelLabels,
          reasoningEfforts: models.reasoningEfforts,
          reasoningLabels: models.reasoningLabels,
          collaborationModes: models.collaborationModes,
          collaborationModeLabels: models.collaborationModeLabels,
          projects,
        }),
      },
      deferred: {
        pendingValues: services.pendingValues,
        queuedValues: services.queuedValues,
        inputPreview: runInputPreview,
        editableText: deferredEditableText,
        responseAnnotations: (input) => deferredResponseAnnotations(input)?.annotations ?? [],
        describeAttachments: services.describeAttachments,
      },
      receipts: {
        forMessage: services.receiptForMessage,
        recent: services.recentReceipts,
      },
      approvals: {
        snapshot: services.approvalSnapshot,
      },
      restart: {
        request: state.restartRequest,
        blockingRuns: services.restartBlockingRuns,
        compactionCount: services.compactionCount,
        mediaJobCount: services.mediaJobCount,
        speechJobCount: services.speechJobCount,
      },
      exchangeRates: services.exchangeRates,
      server: {
        snapshot: services.serverSnapshot,
      },
      warn: services.warn,
    },
    readModel: {
      readStateStore: services.readStateStore,
      trustedDeviceUserId: system.trustedDeviceUserId,
      hasAllowedUsers: services.hasAllowedUsers,
      androidEnabled: services.androidEnabled,
      lastTaskMessage: services.lastTaskMessage,
    },
    history: {
      selection: {
        activeProvider: state.activeProvider,
        threadId: state.threadId,
        chatId: state.chatId,
      },
      catalog: {
        entries: services.catalogEntries,
        refresh: services.refreshCatalog,
        threadsForStream: services.threadsForStream,
      },
      historyReader: {
        read: services.readCachedHistory,
        refresh: services.refreshHistory,
      },
      runs: {
        forTask: services.runForTask,
      },
      latestMessage: services.lastTaskMessage,
      historyMerger: {
        mergeActive: mergeActiveTaskHistory,
        mergeCompleted: mergeCompletedTaskHistory,
      },
      receipts: {
        forMessage: services.receiptForMessage,
        forTurn: services.receiptForTurn,
      },
      attachmentImporter: services.attachmentImporter,
      responseBudget: {
        fit: fitTaskHistoryPayload,
      },
      warn: services.warn,
    },
  });

  return { ...system, ...read };
}

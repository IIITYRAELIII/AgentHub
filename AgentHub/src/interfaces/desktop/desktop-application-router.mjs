import { commandClientContext, commandTaskTarget } from "../../application/application-command-service.mjs";
import { createDesktopControlRouter } from "./desktop-control-router.mjs";

const MUTATION_ACTIONS = Object.freeze([
  "select-task", "send-message", "new-task", "rotate-stream", "create-stream",
  "update-setting", "rename-task", "archive-task", "cancel-run",
  "resolve-approval", "deferred-input", "restart-server", "retry-startup", "set-autostart",
  "update-server-configuration", "update-root-agents", "update-global-pre-turn-instructions", "compact-context", "create-device-pairing",
  "revoke-device", "submit-bug-report",
  "rename-workspace", "update-workspace-settings", "move-workspace-to-folder", "rename-workspace-folder", "update-workspace-rules", "complete-workspace-release", "create-workspace", "archive-workspace", "restore-workspace", "delete-archived-workspace", "create-workspace-from-stream", "merge-workspaces", "rename-stream",
  "archive-stream", "update-stream-settings", "update-stream-rules", "move-stream",
  "board-task-create", "board-task-ingest", "board-task-update", "board-task-checklist", "board-task-checklist-linked-action", "board-task-attachment-add", "board-task-status", "board-task-move", "board-task-complete", "board-task-remove",
  "board-task-retry-triage", "board-task-start", "board-column-move", "board-column-comment",
  "board-workspace-move", "usage-sync", "usage-sync-invite", "usage-sync-enroll",
  "usage-sync-device-label",
  "message-pin-set", "message-pins-clear",
]);

const CONCURRENT_MUTATION_ACTIONS = Object.freeze([
  "send-message", "cancel-run", "deferred-input", "restart-server", "retry-startup",
]);

/**
 * Server configuration remains local. Provider sign-in is local too: its browser
 * callback reaches only the Hub machine. Device enrollment may also be delegated
 * by an already trusted device; Telegram and unnamed remote sources cannot mint
 * credentials.
 */
const LOCAL_ONLY_ACTIONS = Object.freeze([
  "update-server-configuration",
  "start-provider-login",
  "submit-provider-login-code",
  "cancel-provider-login",
  "command-trace-timeline",
  "command-trace-percentiles",
  "command-trace-stats",
]);
const DEVICE_PAIRING_SOURCES = new Set(["desktop-control", "local-mini-app", "trusted-device"]);

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export function createDesktopApplicationRouter({
  handlers,
  commands,
  receiptFile,
  receiptOptions = {},
  reconcileMutation,
  commandTrace = null,
}) {
  if (!handlers || typeof handlers !== "object") throw new TypeError("desktop handlers are required");
  requiredFunction(commands?.dispatch, "commands.dispatch");
  requiredFunction(commands?.settingTarget, "commands.settingTarget");
  for (const name of [
    "snapshot", "runtimeHealth", "taskHistory", "rateLimitHistory", "usageHistory", "search", "workspaceMessageSearch", "markTaskRead",
    "openTask", "openTurn", "workspaceMessageOpen", "sendMessage", "taskDiff", "deferredInput",
    "statusDetails", "speakLastAnswer", "restartServer", "setAutostart",
    "updateServerConfiguration", "readPreTurnInstructions", "updateGlobalPreTurnInstructions",
    "readRootAgents", "updateRootAgents", "compactContext", "openAttachment",
    "submitBugReport", "reportDiagnostic", "trustedDevices", "createDevicePairing", "revokeDevice",
    "boardTaskCreate", "boardTaskIngest", "boardTaskUpdate", "boardTaskChecklist", "boardTaskChecklistLinkedAction", "boardTaskAttachmentAdd", "boardTaskStatus", "boardTaskMove", "boardTaskComplete", "boardTaskRemove",
    "boardTaskRetryTriage", "boardTaskStart", "boardColumnMove", "boardColumnComment",
    "boardWorkspaceMove",
    "usageSync", "usageSyncInvite", "usageSyncEnroll", "usageSyncDeviceLabel",
    "messagePinSet", "messagePinsClear",
  ]) requiredFunction(handlers[name], name);

  const dispatch = (type, params, context, target) => commands.dispatch(
    type,
    params,
    commandClientContext(context, "desktop"),
    target === undefined ? undefined : { target },
  );
  return createDesktopControlRouter({
    handlers: {
      snapshot: handlers.snapshot,
      "runtime-health": handlers.runtimeHealth,
      "retry-startup": (params) => {
        if (!handlers.retryStartup) throw new Error("Повтор запуска недоступен в этой версии");
        return handlers.retryStartup(params);
      },
      "task-history": handlers.taskHistory,
      "rate-limit-history": handlers.rateLimitHistory,
      "usage-history": handlers.usageHistory,
      search: handlers.search,
      "workspace-message-search": handlers.workspaceMessageSearch,
      "mark-task-read": handlers.markTaskRead,
      "open-task": handlers.openTask,
      "open-turn": handlers.openTurn,
      "workspace-message-open": handlers.workspaceMessageOpen,
      "select-task": (params, context) => dispatch("task.select", params, context, commandTaskTarget(params)),
      "send-message": handlers.sendMessage,
      "new-task": (params, context) => dispatch("task.create", params, context),
      "rotate-stream": (params, context) => dispatch("stream.rotate", params, context, commandTaskTarget(params)),
      "update-setting": (params, context) => dispatch("settings.update", params, context, commands.settingTarget(params)),
      "rename-task": (params, context) => dispatch("task.rename", params, context, commandTaskTarget(params)),
      "archive-task": (params, context) => dispatch("task.archive", params, context, commandTaskTarget(params)),
      "task-diff": handlers.taskDiff,
      "cancel-run": (params, context) => dispatch("run.cancel", params, context, commandTaskTarget(params)),
      "resolve-approval": (params, context) => dispatch("approval.resolve", params, context),
      "deferred-input": handlers.deferredInput,
      "status-details": handlers.statusDetails,
      "speak-last-answer": handlers.speakLastAnswer,
      "restart-server": handlers.restartServer,
      "set-autostart": handlers.setAutostart,
      "update-server-configuration": handlers.updateServerConfiguration,
      "start-provider-login": (params) => {
        if (!handlers.startProviderLogin) throw new Error("Вход в аккаунт недоступен в этой версии");
        return handlers.startProviderLogin(params);
      },
      // Not a durable mutation: the manual code must not enter command receipts.
      "submit-provider-login-code": (params) => {
        if (!handlers.submitProviderLoginCode) throw new Error("Вход в аккаунт недоступен в этой версии");
        return handlers.submitProviderLoginCode(params);
      },
      "cancel-provider-login": (params) => {
        if (!handlers.cancelProviderLogin) throw new Error("Вход в аккаунт недоступен в этой версии");
        return handlers.cancelProviderLogin(params);
      },
      "read-pre-turn-instructions": handlers.readPreTurnInstructions,
      "update-global-pre-turn-instructions": handlers.updateGlobalPreTurnInstructions,
      "read-root-agents": handlers.readRootAgents,
      "update-root-agents": handlers.updateRootAgents,
      "compact-context": handlers.compactContext,
      "open-attachment": handlers.openAttachment,
      "submit-bug-report": handlers.submitBugReport,
      "report-diagnostic": handlers.reportDiagnostic,
      "trusted-devices": handlers.trustedDevices,
      "create-device-pairing": (params, context) => {
        if (!DEVICE_PAIRING_SOURCES.has(String(context?.source ?? ""))) {
          throw new Error("Добавление устройства доступно только локальному Hub или доверенному устройству");
        }
        return handlers.createDevicePairing(params, context);
      },
      "revoke-device": handlers.revokeDevice,
      "message-pin-set": handlers.messagePinSet,
      "message-pins-clear": handlers.messagePinsClear,
      "rename-workspace": (params, context) => dispatch("workspace.rename", params, context),
      "update-workspace-settings": (params, context) => dispatch("workspace.settings.update", params, context),
      "move-workspace-to-folder": (params, context) => dispatch("workspace.folder.move", params, context),
      "rename-workspace-folder": (params, context) => dispatch("workspace.folder.rename", params, context),
      "update-workspace-rules": (params, context) => dispatch("workspace.developer-rules.update", params, context),
      "read-workspace-release-plan": (params, context) => dispatch("workspace.release-plan.read", params, context),
      "complete-workspace-release": (params, context) => dispatch("workspace.release.complete", params, context),
      "create-workspace": (params, context) => dispatch("workspace.create", params, context),
      "archive-workspace": (params, context) => dispatch("workspace.archive", params, context),
      "restore-workspace": (params, context) => dispatch("workspace.restore", params, context),
      "delete-archived-workspace": (params, context) => dispatch("workspace.delete-archived", params, context),
      "create-workspace-from-stream": (params, context) => dispatch("workspace.create-from-stream", params, context),
      "merge-workspaces": (params, context) => dispatch("workspace.merge", params, context),
      "create-stream": (params, context) => dispatch("stream.create", params, context),
      "rename-stream": (params, context) => dispatch("stream.rename", params, context),
      "archive-stream": (params, context) => dispatch("stream.archive", params, context),
      "update-stream-settings": (params, context) => dispatch("stream.settings.update", params, context),
      "update-stream-rules": (params, context) => dispatch("stream.developer-rules.update", params, context),
      "move-stream": (params, context) => dispatch("stream.move", params, context),
      "board-task-create": handlers.boardTaskCreate,
      "board-task-ingest": handlers.boardTaskIngest,
      "board-task-update": handlers.boardTaskUpdate,
      "board-task-diff": handlers.boardTaskDiff,
      "board-task-checklist": handlers.boardTaskChecklist,
      "board-task-checklist-linked-action": handlers.boardTaskChecklistLinkedAction,
      "board-task-attachment-add": handlers.boardTaskAttachmentAdd,
      "board-task-status": handlers.boardTaskStatus,
      "board-task-move": handlers.boardTaskMove,
      "board-task-complete": handlers.boardTaskComplete,
      "board-task-remove": handlers.boardTaskRemove,
      "board-task-retry-triage": handlers.boardTaskRetryTriage,
      "board-task-start": handlers.boardTaskStart,
      "board-column-move": handlers.boardColumnMove,
      "board-column-comment": handlers.boardColumnComment,
      "board-workspace-move": handlers.boardWorkspaceMove,
      "usage-sync": handlers.usageSync,
      "usage-sync-invite": handlers.usageSyncInvite,
      "usage-sync-enroll": handlers.usageSyncEnroll,
      "usage-sync-device-label": handlers.usageSyncDeviceLabel,
      "command-trace-timeline": handlers.commandTraceTimeline,
      "command-trace-percentiles": handlers.commandTracePercentiles,
      "command-trace-stats": handlers.commandTraceStats,
    },
    mutationActions: MUTATION_ACTIONS,
    concurrentMutationActions: CONCURRENT_MUTATION_ACTIONS,
    localOnlyActions: LOCAL_ONLY_ACTIONS,
    miniAppLimits: {
      source: "telegram-mini-app",
      limit: 10,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
    },
    desktopMaxResponseBytes: 3_500_000,
    receiptFile,
    receiptOptions,
    reconcileMutation,
    commandTrace,
  });
}

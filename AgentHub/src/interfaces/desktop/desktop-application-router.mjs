import { commandClientContext, commandTaskTarget } from "../../application/application-command-service.mjs";
import { createDesktopControlRouter } from "./desktop-control-router.mjs";

const MUTATION_ACTIONS = Object.freeze([
  "open-task", "open-turn", "select-task", "send-message", "new-task",
  "update-setting", "rename-task", "archive-task", "cancel-run",
  "resolve-approval", "deferred-input", "restart-server", "set-autostart",
  "update-server-configuration", "compact-context", "create-device-pairing",
  "revoke-device", "submit-bug-report",
  "rename-workspace", "merge-workspaces", "rename-stream", "move-stream",
]);

function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export function createDesktopApplicationRouter({ handlers, commands, receiptFile, reconcileMutation }) {
  if (!handlers || typeof handlers !== "object") throw new TypeError("desktop handlers are required");
  requiredFunction(commands?.dispatch, "commands.dispatch");
  requiredFunction(commands?.settingTarget, "commands.settingTarget");
  for (const name of [
    "snapshot", "taskHistory", "rateLimitHistory", "usageHistory", "search",
    "openTask", "openTurn", "sendMessage", "taskDiff", "deferredInput",
    "statusDetails", "speakLastAnswer", "restartServer", "setAutostart",
    "updateServerConfiguration", "compactContext", "openAttachment",
    "submitBugReport", "trustedDevices", "createDevicePairing", "revokeDevice",
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
      "task-history": handlers.taskHistory,
      "rate-limit-history": handlers.rateLimitHistory,
      "usage-history": handlers.usageHistory,
      search: handlers.search,
      "open-task": handlers.openTask,
      "open-turn": handlers.openTurn,
      "select-task": (params, context) => dispatch("task.select", params, context, commandTaskTarget(params)),
      "send-message": handlers.sendMessage,
      "new-task": (params, context) => dispatch("task.create", params, context),
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
      "compact-context": handlers.compactContext,
      "open-attachment": handlers.openAttachment,
      "submit-bug-report": handlers.submitBugReport,
      "trusted-devices": handlers.trustedDevices,
      "create-device-pairing": handlers.createDevicePairing,
      "revoke-device": handlers.revokeDevice,
      "rename-workspace": (params, context) => dispatch("workspace.rename", params, context),
      "merge-workspaces": (params, context) => dispatch("workspace.merge", params, context),
      "rename-stream": (params, context) => dispatch("stream.rename", params, context),
      "move-stream": (params, context) => dispatch("stream.move", params, context),
    },
    mutationActions: MUTATION_ACTIONS,
    miniAppLimits: {
      source: "telegram-mini-app",
      limit: 10,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
    },
    desktopMaxResponseBytes: 3_500_000,
    receiptFile,
    reconcileMutation,
  });
}

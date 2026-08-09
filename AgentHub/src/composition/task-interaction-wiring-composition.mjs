import {
  approvalModeKeyboard as presentApprovalModeKeyboard,
  formatApprovalMode as presentApprovalMode,
  formatCommandApproval as presentCommandApproval,
  formatFileApproval as presentFileApproval,
} from "../interfaces/telegram/approval-presentation.mjs";
import { createTaskViewComposition } from "./task-view-composition.mjs";

export function createTaskInteractionWiring({
  taskView,
  approvalController,
  activeProvider,
  autoApprove,
  autoApproveOnStart,
  claudePermissionMode,
  activeProjectRoot,
  uiCallback,
}) {
  const taskViewController = createTaskViewComposition(taskView);

  return {
    showTaskMessage: (binding, targetChatId, { count = 1 } = {}) => (
      taskViewController.show(binding, targetChatId, { count })
    ),
    showLastTaskMessage: (binding, targetChatId, { count = 1 } = {}) => (
      taskViewController.showLast(binding, targetChatId, { count })
    ),
    resolveTaskViewBinding: (identity, targetChatId, sourceMessageId) => (
      taskViewController.resolveBinding(identity, targetChatId, sourceMessageId)
    ),
    readCachedHistory: (binding) => taskViewController.readHistory(binding, { cachedOnly: true }),
    refreshHistory: (binding) => taskViewController.readHistory(binding),
    requestApproval: (rpcId, kind, params, text, run = null) => (
      approvalController.request(rpcId, kind, params, text, run)
    ),
    requestMcpElicitation: (rpcId, params, run = null) => (
      approvalController.requestMcp(rpcId, params, run)
    ),
    requestUserInput: (rpcId, params, run = null) => (
      approvalController.requestUserInput(rpcId, params, run)
    ),
    formatCommandApproval: (params, run = null) => (
      presentCommandApproval(params, run, activeProjectRoot())
    ),
    formatFileApproval: (params) => presentFileApproval(params),
    formatApprovalMode: () => presentApprovalMode({
      provider: activeProvider(),
      autoApprove: autoApprove(),
      autoApproveOnStart,
      claudePermissionMode,
    }),
    approvalModeKeyboard: () => presentApprovalModeKeyboard({
      autoApprove: autoApprove(),
      callback: uiCallback,
    }),
  };
}

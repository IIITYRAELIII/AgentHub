import { interstreamAuditContentHash } from "../domain/interstream-message.mjs";
import { taskGitIdentityHash } from "../domain/task-git-reference.mjs";

// Reuse the authenticated inter-Stream review receipt. No separate approval
// ledger or caller-declared path allowlist participates in this decision.
export function createNativeMergeReviewVerifier({ workspaceCatalog, taskBoard }) {
  return async (review, expected, identity) => {
    const receipt = workspaceCatalog.mcpOperation(review?.requestId);
    const match = /<native-merge-review>\s*([^]*?)\s*<\/native-merge-review>/u.exec(review?.text ?? "");
    let verdict;
    try { verdict = JSON.parse(match?.[1] ?? ""); } catch { throw new Error("Native merge requires an exact reviewed verdict"); }
    const origin = { workspaceId: receipt?.workspaceId, streamId: receipt?.streamId,
      provider: receipt?.provider, sourceThreadId: receipt?.threadId, requestId: receipt?.requestId };
    const sender = workspaceCatalog.stream(receipt?.streamId);
    const receiver = workspaceCatalog.stream(receipt?.result?.target?.streamId);
    const taskIds = identity?.taskId ? [identity.taskId] : identity?.tasks?.map(task => task.taskId) ?? [];
    const tasks = taskIds.map(id => taskBoard.task(id));
    if (receipt?.toolName !== "hub_stream_message_send" || receipt.status !== "succeeded" || receipt.receiptState !== "succeeded"
        || receipt.result?.delivery?.accepted !== true || !sender || !receiver
        || sender.workspaceId !== receiver.workspaceId || sender.workspaceId !== receipt.workspaceId
        || sender.id === receiver.id
        || !tasks.length || tasks.some(task => !task || task.workspaceId !== receipt.workspaceId)
        || (identity.workspaceId && identity.workspaceId !== receipt.workspaceId)
        || receiver.settings?.releaseManager !== true
        || workspaceCatalog.activeThread(receiver.id)?.provider !== receipt.provider
        || /astra/iu.test(String(sender.settings?.model ?? ""))
        || interstreamAuditContentHash(review.text, { origin }) !== receipt.interstreamContentHash
        || verdict.kind !== "native-merge-review-v1" || verdict.verdict !== "ACCEPT"
        || taskGitIdentityHash(verdict.binding) !== taskGitIdentityHash(expected)) {
      throw new Error("Native merge review receipt, exact diff or selected identity changed");
    }
    return { requestId: receipt.requestId, argumentsHash: receipt.argumentsHash,
      contentHash: receipt.interstreamContentHash, origin };
  };
}

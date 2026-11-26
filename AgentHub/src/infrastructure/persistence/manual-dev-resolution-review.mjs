import path from "node:path";
import { WorkspaceCatalogStore } from "./workspace-catalog-store.mjs";
import { TaskBoardStore } from "./task-board-store.mjs";
import { interstreamAuditContentHash } from "../../domain/interstream-message.mjs";
import { taskGitIdentityHash } from "../../domain/task-git-reference.mjs";
import { nativeResolutionReviewDeclaration } from "../../domain/native-resolution-input.mjs";

// The existing authenticated inter-Stream receipt is the authority. There is no
// caller callback, approval boolean, new review ledger or secret/signature scheme.
export async function verifyManualDevResolutionReview({ dataDir, review, binding } = {}) {
  const declaration = nativeResolutionReviewDeclaration(review);
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(dataDir, "journal.sqlite"), readOnly: true });
  let board;
  try {
    await catalog.load();
    board = new TaskBoardStore({ databaseFile: path.join(dataDir, "journal.sqlite"), readOnly: true });
    const receipt = catalog.mcpOperation(review.requestId);
    const sender = receipt && catalog.stream(receipt.streamId);
    const receiver = receipt && catalog.stream(receipt.result?.target?.streamId);
    const task = board.task(binding.taskId);
    const origin = { workspaceId: receipt?.workspaceId, streamId: receipt?.streamId,
      provider: receipt?.provider, sourceThreadId: receipt?.threadId, requestId: receipt?.requestId };
    if (receipt?.toolName !== "hub_stream_message_send" || receipt.status !== "succeeded" || receipt.receiptState !== "succeeded"
        || receipt.result?.delivery?.accepted !== true || !sender || !receiver || !task
        || sender.workspaceId !== receiver.workspaceId || sender.workspaceId !== receipt.workspaceId
        || task.workspaceId !== receipt.workspaceId || binding.workspaceId !== receipt.workspaceId
        || interstreamAuditContentHash(review.text, { origin }) !== receipt.interstreamContentHash
        || taskGitIdentityHash(declaration.binding) !== taskGitIdentityHash(binding)) {
      throw Error("Native merge review receipt or exact context changed");
    }
    return { requestId: receipt.requestId, argumentsHash: receipt.argumentsHash,
      contentHash: receipt.interstreamContentHash, origin };
  } finally { board?.close(); catalog.close(); }
}

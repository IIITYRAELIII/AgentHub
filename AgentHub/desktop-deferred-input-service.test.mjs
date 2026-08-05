import assert from "node:assert/strict";
import test from "node:test";
import { DesktopDeferredInputService } from "./src/interfaces/desktop/desktop-deferred-input-service.mjs";

function createService(item) {
  const pendingInputs = new Map([[item.id, item]]);
  const queuedInputs = new Map();
  return new DesktopDeferredInputService({
    pendingInputs, queuedInputs, findReceiptByResultId: () => null, isProcessing: () => false,
    cancelSchedule: () => {}, steerActiveInput: async () => ({}), responseAnnotations: () => null,
    replaceInputText: (input, text) => text, saveState: async () => {}, updateReceipt: () => {},
    cleanupFiles: async () => {}, updateMessage: async () => {}, scheduleNext: () => {}, scheduleQueued: () => {},
    selectTask: async () => {}, clientContext: (context) => context ?? {}, startTurn: async () => ({}),
    runForTask: () => null, describeAttachments: () => [], selectedTask: () => ({}),
    dispatchCommand: async () => {}, activeTitle: () => "New", snapshot: async () => ({}),
  });
}

test("Desktop deferred input edit preserves its stable message id", async () => {
  const item = { id: "message-1", input: "old", temporaryFiles: [] };
  const service = createService(item);
  const result = await service.handle({ id: item.id, action: "edit", text: "new" });
  assert.equal(result.id, "message-1");
  assert.equal(item.input, "new");
});

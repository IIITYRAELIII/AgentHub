import { DeferredInputService } from "../application/deferred-input-service.mjs";
import { RunConflictPolicy } from "../application/run-conflict-policy.mjs";
import { RunCoordinator } from "../application/run-coordinator.mjs";
import { DesktopDeferredInputService } from "../interfaces/desktop/desktop-deferred-input-service.mjs";
import { createDesktopMessageController } from "../interfaces/desktop/desktop-message-controller.mjs";

export function createDesktopRunInputComposition({
  composerTransfers,
  deferredInput,
  conflictPolicy,
  coordinator,
  messageController,
  desktopDeferredInput,
}) {
  const transferMethods = [
    "configure", "ready", "remember", "forget", "resolve", "claim", "consume", "has", "snapshot",
  ];
  if (!composerTransfers || transferMethods.some((name) => typeof composerTransfers[name] !== "function")) {
    throw new TypeError("composerTransfers is required");
  }
  composerTransfers.configure({
    cleanup: desktopDeferredInput.cleanupFiles,
    persist: desktopDeferredInput.saveState,
  });
  const deferredInputService = new DeferredInputService(deferredInput);
  const runConflictPolicy = new RunConflictPolicy(conflictPolicy);
  const runCoordinator = new RunCoordinator({
    ...coordinator,
    repositoryConflict: (target) => runConflictPolicy.check(target),
    deferInput: (...args) => deferredInputService.defer(...args),
  });
  const desktopMessageController = createDesktopMessageController({
    ...messageController,
    runCoordinator,
    composerTransfers,
    discardPreparedAttachments: (files) => desktopDeferredInput.cleanupFiles({ temporaryFiles: files }),
  });
  const desktopDeferredInputService = new DesktopDeferredInputService({
    ...desktopDeferredInput,
    startDeferred: (item) => runCoordinator.startDeferred(item),
    composerTransfers,
    steerActiveInput: (payload) => desktopMessageController.steerActiveInput(payload),
  });

  return {
    deferredInputService,
    runConflictPolicy,
    runCoordinator,
    desktopMessageController,
    desktopDeferredInputService,
    desktopDeferredInput: (...args) => desktopDeferredInputService.handle(...args),
  };
}

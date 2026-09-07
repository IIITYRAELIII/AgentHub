import { DeferredInputService } from "../application/deferred-input-service.mjs";
import { RunConflictPolicy } from "../application/run-conflict-policy.mjs";
import { RunCoordinator } from "../application/run-coordinator.mjs";
import { DesktopDeferredInputService } from "../interfaces/desktop/desktop-deferred-input-service.mjs";
import { createDesktopMessageController } from "../interfaces/desktop/desktop-message-controller.mjs";
import { DeferredComposerTransferRegistry } from "../application/deferred-composer-transfer-registry.mjs";

export function createDesktopRunInputComposition({
  deferredInput,
  conflictPolicy,
  coordinator,
  messageController,
  desktopDeferredInput,
}) {
  const composerTransfers = new DeferredComposerTransferRegistry({
    cleanup: desktopDeferredInput.cleanupFiles,
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
  });
  const desktopDeferredInputService = new DesktopDeferredInputService({
    ...desktopDeferredInput,
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

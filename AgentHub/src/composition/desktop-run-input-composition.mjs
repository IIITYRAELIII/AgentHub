import { DeferredInputService } from "../application/deferred-input-service.mjs";
import { RunConflictPolicy } from "../application/run-conflict-policy.mjs";
import { RunCoordinator } from "../application/run-coordinator.mjs";
import { DesktopDeferredInputService } from "../interfaces/desktop/desktop-deferred-input-service.mjs";
import { createDesktopMessageController } from "../interfaces/desktop/desktop-message-controller.mjs";

export function createDesktopRunInputComposition({
  deferredInput,
  conflictPolicy,
  coordinator,
  messageController,
  desktopDeferredInput,
}) {
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
  });
  const desktopDeferredInputService = new DesktopDeferredInputService({
    ...desktopDeferredInput,
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

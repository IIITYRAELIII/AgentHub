import { createContourAwareDiffCapture } from "../runtime/test-contour-runtime-effects.mjs";
import { createRunAdmissionComposition } from "./run-admission-composition.mjs";
import { createRunPresentationComposition } from "./run-presentation-composition.mjs";

export function createRunShellComposition({
  presentation,
  admission,
  diff,
  ports,
}) {
  const captureDiff = createContourAwareDiffCapture(admission.config, diff.capture);
  async function refreshTaskDiff(run) {
    if (!run) return "";
    if (run.rolloutChangeTrackingKnown !== true) {
      const captured = await captureDiff(run.gitBaseline, diff.dataDir, run.id);
      if (captured !== null) run.latestDiff = captured;
    }
    await diff.persist(diff.taskKey(run), run.latestDiff ?? "");
    if (diff.isSelected(run)) diff.setSelected(run.latestDiff ?? "");
    return run.latestDiff ?? "";
  }

  const runPresentation = createRunPresentationComposition({
    ...presentation,
    refreshTaskDiff,
  });
  ports.telegramDelivery.bind(runPresentation.telegramDeliveryService);

  const runAdmission = ports.runAdmission.bind(createRunAdmissionComposition({
    ...admission,
    taskProgress: runPresentation.taskProgress,
  }));
  ports.deferredInput.bind(runAdmission.deferredInputController);
  ports.runShell.bind({ refreshTaskDiff });

  return {
    ...runAdmission,
    ...runPresentation,
    refreshTaskDiff,
  };
}

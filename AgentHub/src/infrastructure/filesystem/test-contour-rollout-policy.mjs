import { createContourExternalEffects } from "./test-contour-external-effects.mjs";

const policies = new Map();

export function contourRolloutPolicy(config = null, environment = process.env) {
  const root = config?.testContourRecording?.root
    ?? (environment.AGENT_HUB_TEST_CONTOUR === "1" ? environment.AGENT_HUB_RECORDING_PROVIDER_ROOT : null);
  if (!root) return null;
  if (!policies.has(root)) {
    const effects = createContourExternalEffects({ root });
    const operations = new Map();
    policies.set(root, Object.freeze({
      exclude(operation) {
        if (!operations.has(operation)) operations.set(operation, effects.exclude("codex-rollout", operation));
        return operations.get(operation);
      },
      assertRead(operation) {
        this.exclude(operation);
        throw Object.assign(new Error("Captured Codex rollouts are excluded from recording execution"), {
          code: "CONTOUR_ROLLOUT_EXCLUDED", operation,
        });
      },
    }));
    if (policies.size > 16) policies.delete(policies.keys().next().value);
  }
  return policies.get(root);
}

// Guard the shared filesystem entry points too: captured run.rolloutPath and
// historical queues can bypass discovery and the ordinary observation mapper.
export function assertCodexRolloutReadAllowed(operation) {
  contourRolloutPolicy()?.assertRead(operation);
}

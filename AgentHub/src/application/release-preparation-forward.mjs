import { mcpArgumentsHash } from "../domain/mcp-arguments-hash.mjs";
import { preparationHash, validatePreparationEnvelope, ReleasePreparationRejectedError }
  from "./release-preparation-admission.mjs";

import { FORWARD_PREPARATION } from "../domain/release-preparation.mjs";
export { FORWARD_PREPARATION, preparationLegacyIdentity, preparationLegacyHash }
  from "../domain/release-preparation.mjs";
const reject = message => { throw new ReleasePreparationRejectedError(message); };

// This is a CURRENT continuation decision, never a reconstruction of the
// missing historical stage. Its complete selection/publication remains bound.
export function validatePreparationForward({ record, originalPreparation, preparation, requestId }) {
  const original = validatePreparationEnvelope(originalPreparation);
  const current = validatePreparationEnvelope(preparation);
  if (record?.toolName !== "hub_release_prepare" || record.status !== "unknown"
      || record.operationStatus !== "pending" || record.receiptState !== "unknown"
      || record.requestId !== requestId
      || mcpArgumentsHash({ request_id: requestId, preparation: original }) !== record.argumentsHash) {
    reject("Forward preparation original identity is not an exact retained UNKNOWN");
  }
  const selection = value => value.tasks.map(({ rowRevision: _row, ...task }) => task)
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
  if (preparationHash(selection(original)) !== preparationHash(selection(current))
      || original.planRevision !== current.planRevision || original.publicationHash !== current.publicationHash
      || original.repositories.length !== 1 || current.repositories.length !== 1
      || original.repositories[0].projectRoot !== current.repositories[0].projectRoot
      || original.repositories[0].publishedRevision !== current.repositories[0].publishedRevision) {
    reject("Forward preparation cannot change original selection or publication");
  }
  const prior = record.preparationState;
  if (prior && prior.kind !== FORWARD_PREPARATION) reject("Forward preparation is only for legacy stage-less originals");
  if (prior) {
    const withoutReview = envelope => ({ ...envelope, tasks: selection(envelope),
      repositories: envelope.repositories.map(({ nativeResolutionReview: _review, ...repository }) => repository) });
    if (preparationHash(prior.originalPreparation) !== preparationHash(original)
        || preparationHash(withoutReview(prior.envelope)) !== preparationHash(withoutReview(current))) {
      reject("Forward preparation current basis changed; preserve its original effects");
    }
  }
  return { original, current };
}

// The local source consumer supplies an observer, not a serialized approval
// flag. It must join/verify the exact old invocation and its native children.
// Missing root PIDs/jobs/candidates are explicitly not terminal evidence.
export async function inspectPreparationForwardCustody(inspect, request) {
  if (typeof inspect !== "function") reject("Original invocation terminal observer is unavailable");
  const proof = await inspect(request);
  if (proof?.kind === "preparation-effects-isolated-v1") {
    const keys = ["kind", "requestId", "argumentsHash", "originalSourceClosureHash", "isolationEvidenceSha256",
      "authorizationSha256", "legacyInvocationTerminal", "writeTargetsHash"];
    if (Object.keys(proof).length !== keys.length || keys.some(key => !Object.hasOwn(proof, key))
        || proof.requestId !== request.requestId || proof.argumentsHash !== request.argumentsHash
        || proof.originalSourceClosureHash !== request.originalPreparation.sourceClosureHash
        || proof.legacyInvocationTerminal !== true || !request.isolationPlan
        || proof.writeTargetsHash !== request.isolationPlan.writeTargetsHash
        || ![proof.isolationEvidenceSha256, proof.authorizationSha256].every(v => /^[a-f0-9]{64}$/u.test(v))) {
      reject("Preparation future write-target isolation is not proved");
    }
    return structuredClone(proof);
  }
  const keys = ["kind", "requestId", "argumentsHash", "originalSourceClosureHash", "terminalEvidenceSha256",
    "joinedInvocation", "joinedChildren"];
  if (!proof || typeof proof !== "object" || Array.isArray(proof)
      || Object.keys(proof).length !== keys.length || keys.some(key => !Object.hasOwn(proof, key))
      || proof.kind !== "preparation-invocation-terminal-v1" || proof.requestId !== request.requestId
      || proof.argumentsHash !== request.argumentsHash
      || proof.originalSourceClosureHash !== request.originalPreparation.sourceClosureHash
      || !/^[a-f0-9]{64}$/u.test(proof.terminalEvidenceSha256)
      || proof.joinedInvocation !== true || proof.joinedChildren !== true) {
    reject("Original preparation invocation/child completion is not proved");
  }
  return structuredClone(proof);
}

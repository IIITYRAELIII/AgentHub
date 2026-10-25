import { createHash } from "node:crypto";

export const FORWARD_PREPARATION = "original-preparation-forward-v1";
export function preparationLegacyIdentity(record) {
  const { preparationState: _state, ...legacy } = record;
  return legacy;
}
export const preparationLegacyHash = record => createHash("sha256")
  .update(JSON.stringify(preparationLegacyIdentity(record))).digest("hex");

export class ReleasePreparationRejectedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.code = "RELEASE_PREPARATION_REJECTED";
  }
}

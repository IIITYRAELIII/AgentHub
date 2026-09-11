import { taskOccupancyIdentity } from "../domain/task-runs.mjs";
import { isDeepStrictEqual } from "node:util";

function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an operational reference object");
}

// This is a reversible view, not a replacement command ledger. The restore
// token is process-local and paired with an exact original object. It must not
// become a serialized authority or be used to infer identity from message text.
export function createContourReferenceProjection(paths) {
  const tokens = new WeakMap();
  function project(original, { queue = false } = {}) {
    object(original);
    const view = structuredClone(original);
    const bindings = [];
    const bind = (holder, key, kind) => {
      if (holder[key] == null || holder[key] === "") return;
      const canonical = holder[key];
      const operational = paths.map(canonical, kind);
      holder[key] = operational;
      bindings.push({ holder, key, canonical, operational });
    };
    bind(view, "projectRoot", "project");
    if (queue) {
      if (!original.id || !original.clientUserMessageId) throw new Error("Queue references require canonical item and command IDs");
      const before = taskOccupancyIdentity(original);
      const after = taskOccupancyIdentity(view);
      if (!before || before.key !== after?.key || before.binding !== after?.binding) throw new Error("Path-dependent legacy occupancy requires an explicit migration");
      if (Array.isArray(view.input)) {
        for (const item of view.input) {
          if (item?.type === "text" && typeof item.text === "string") continue;
          if (["localImage", "localFile"].includes(item?.type)) bind(item, "path", "attachment");
          else throw new Error("Unclassified deferred input attachment");
        }
      } else if (view.input != null && typeof view.input !== "string") throw new Error("Unclassified deferred input");
      if (view.temporaryFiles != null) {
        if (!Array.isArray(view.temporaryFiles)) throw new Error("Invalid temporaryFiles");
        for (let index = 0; index < view.temporaryFiles.length; index++) bind(view.temporaryFiles, index, "attachment");
      }
    }
    const token = Object.freeze({});
    tokens.set(token, { view, original: structuredClone(original), immutableView: structuredClone(view), bindings, queue });
    return { view, token };
  }
  function canonicalize(token) {
    const entry = tokens.get(token);
    if (!entry) throw new Error("Unknown contour reference token");
    const { view, original, immutableView, bindings, queue } = entry;
    // Changes to an operational target require a new explicit projection. Never
    // guess reverse paths or silently recalculate a receipt fingerprint.
    for (const binding of bindings) if (binding.holder[binding.key] !== binding.operational) throw new Error("Operational reference changed without canonical binding");
    for (const key of ["id", "clientUserMessageId", "provider", "streamId", "threadId"]) {
      if (view[key] !== original[key]) throw new Error("Canonical reference identity changed");
    }
    // A view may gain queue bookkeeping (attempts/waitReason), but it must never
    // mutate the immutable submitted input or receipt/fingerprint evidence.
    const result = structuredClone(view);
    result.projectRoot = original.projectRoot;
    if (!Object.hasOwn(original, "projectRoot")) delete result.projectRoot;
    if (queue) {
      for (const key of ["input", "temporaryFiles", "fingerprint", "receipt", "annotations"]) {
        if (!isDeepStrictEqual(view[key], immutableView[key]) || Object.hasOwn(view, key) !== Object.hasOwn(immutableView, key)) throw new Error("Canonical command evidence changed in operational view");
        if (Object.hasOwn(original, key)) result[key] = structuredClone(original[key]);
        else delete result[key];
      }
    }
    return result;
  }
  return Object.freeze({ selection: (value) => project(value), queueItem: (value) => project(value, { queue: true }), canonicalize });
}

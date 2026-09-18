import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createContourOperationalPaths } from "../../domain/test-contour-operational-paths.mjs";
import { assertContourOwnedPath } from "./test-contour-external-effects.mjs";

export const CONTOUR_TARGET_PROJECT_MISMATCH = "CONTOUR_TARGET_PROJECT_MISMATCH";

// Durable state keeps original coordinates; only the recording provider maps
// canonical input to execution paths. UI/catalog coordinates return here before
// receipts and admission. Lookup is a point read from the existing ledger owner.
export function createContourCommandMapping({ root, readCommand = () => null }) {
  root = assertContourOwnedPath(root, root);
  const markerFile = assertContourOwnedPath(path.join(root, "recording-provider.json"), root);
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  if (marker.schemaVersion !== 1 || marker.kind !== "literal-recording-provider" || marker.root !== root || marker.externalEffects !== "deny") throw new Error("Invalid recording mapping marker");
  const paths = createContourOperationalPaths({ root, sources: marker.sources });
  const mappings = paths.manifest();
  const threads = new Map();
  for (const thread of marker.threads ?? []) {
    const key = `${thread.provider}\0${thread.id}`;
    if (!thread.provider || !thread.id || !thread.streamId || threads.has(key)) throw new Error("Ambiguous recording Thread binding");
    paths.map(thread.cwd, "project");
    threads.set(key, structuredClone(thread));
  }
  function canonicalPath(value, kind = "project") {
    if (value == null || value === "") return value;
    if (typeof value !== "string" || !(path.isAbsolute(value) || path.win32.isAbsolute(value))) throw new Error("Expected an absolute contour reference");
    for (const mapping of mappings.filter((entry) => path.isAbsolute(value) && entry.kind === kind)) {
      const relative = path.relative(mapping.target, value);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
      const api = /^[a-z]:[\\/]/i.test(mapping.source) || mapping.source.startsWith("\\\\") ? path.win32 : path.posix;
      const canonical = relative ? api.join(mapping.source, ...relative.split(path.sep)) : mapping.source;
      if (path.relative(paths.map(canonical, kind), path.resolve(value))) throw new Error("Ambiguous operational path");
      return canonical;
    }
    paths.map(value, kind);
    return value; // Retain original lexical spelling when already canonical.
  }
  function reference(value, execution) {
    if (!value || typeof value !== "object") throw new Error("Target reference required");
    const result = { ...value };
    if (result.projectRoot != null) result.projectRoot = canonicalPath(result.projectRoot);
    if (result.sessionCwd != null) result.sessionCwd = canonicalPath(result.sessionCwd);
    if (value.provider && value.threadId) {
      const thread = threads.get(`${value.provider}\0${value.threadId}`);
      if (!thread) throw new Error("Target Thread is not in the captured canonical binding");
      if (value.streamId && value.streamId !== thread.streamId) throw new Error("Target Stream differs from canonical Thread binding");
      if (execution && result.projectRoot && path.relative(paths.map(result.projectRoot, "project"), paths.map(thread.cwd, "project"))) throw Object.assign(new Error("Target project differs from canonical Thread binding"), { code: CONTOUR_TARGET_PROJECT_MISMATCH });
      if (execution && Object.hasOwn(value, "projectRoot")) result.projectRoot = thread.cwd;
      // Do not inject absent transport fields: request shape is fingerprinted.
    }
    return result;
  }
  const target = (value) => reference(value, true);
  // A historical read model may retain its containing project while the exact
  // Thread binding names a nested directory. Reading it grants no execution.
  const readReference = (value) => reference(value, false);
  function canonicalInput(value) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) throw new Error("Unclassified contour input");
    return value.map((item) => {
      if (item?.type === "text" && typeof item.text === "string") return structuredClone(item);
      if (["localImage", "localFile"].includes(item?.type)) return { ...structuredClone(item), path: canonicalPath(item.path, "attachment") };
      throw new Error("Unclassified contour input item");
    });
  }
  function input(value, clientUserMessageId = null) {
    const canonical = canonicalInput(value);
    const record = clientUserMessageId ? readCommand(clientUserMessageId) : null;
    if (!record?.item) return canonical;
    if (record.clientUserMessageId !== clientUserMessageId && record.item.clientUserMessageId !== clientUserMessageId) throw new Error("Command lookup returned a different identity");
    if (!isDeepStrictEqual(paths.input(canonical), paths.input(record.item.input))) {
      const error = new Error("Same command ID has different canonical input");
      error.code = "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH";
      throw error;
    }
    return structuredClone(record.item.input);
  }
  function files(values, clientUserMessageId = null) {
    if (!Array.isArray(values)) throw new Error("Expected typed attachment paths");
    const canonical = values.map((value) => canonicalPath(value, "attachment"));
    const original = clientUserMessageId ? readCommand(clientUserMessageId)?.item?.temporaryFiles : null;
    if (Array.isArray(original) && isDeepStrictEqual(original.map((file) => paths.map(file, "attachment")), canonical.map((file) => paths.map(file, "attachment")))) return [...original];
    return canonical;
  }
  function request(request) {
    if (!["send-message", "select-task"].includes(request.action)) return request;
    return { ...request, params: target(request.params ?? {}) };
  }
  return Object.freeze({ paths, target, readReference, input, files, canonicalPath, request });
}

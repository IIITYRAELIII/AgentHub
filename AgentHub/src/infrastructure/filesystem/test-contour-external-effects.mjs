import { appendFileSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createContourExternalEffectsPort } from "../../ports/contour-external-effects.mjs";

function samePath(left, right) {
  const canonical = (value) => {
    const resolved = path.resolve(value);
    try { return realpathSync.native(resolved); } catch { return resolved; }
  };
  const a = canonical(left);
  const b = canonical(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function assertContourOwnedPath(file, root, { optional = false } = {}) {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(file);
  const relative = path.relative(resolvedRoot, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Contour path escapes owned root");
  let current = target;
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Contour path contains a link");
    } catch (error) {
      if (!(optional && current === target && error.code === "ENOENT")) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return target;
}

export function createContourExternalEffects({ root }) {
  if (!root || !path.isAbsolute(root)) throw new Error("Explicit recording root required");
  root = assertContourOwnedPath(root, root);
  const markerFile = assertContourOwnedPath(path.join(root, "recording-provider.json"), root);
  const marker = JSON.parse(readFileSync(markerFile, "utf8"));
  if (marker.schemaVersion !== 1 || marker.kind !== "literal-recording-provider" || !samePath(marker.root, root) || marker.externalEffects !== "deny") throw new Error("Invalid recording exclusion marker");
  const file = path.join(root, "external-effects.jsonl");
  return createContourExternalEffectsPort((record) => {
    assertContourOwnedPath(file, root, { optional: true });
    appendFileSync(file, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`, "utf8");
  });
}

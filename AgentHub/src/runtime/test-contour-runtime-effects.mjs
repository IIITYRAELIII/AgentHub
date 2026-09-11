import { lstatSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { createContourCommandMapping } from "../infrastructure/filesystem/test-contour-command-mapping.mjs";
import { createContourExternalEffects } from "../infrastructure/filesystem/test-contour-external-effects.mjs";

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// Missing files are valid cleanup targets; existing ancestors must still be
// owned directories, never links into the source runtime.
export function assertOwnedRuntimeFile(file, root) {
  if (typeof file !== "string" || !path.isAbsolute(file) || !inside(root, file)) {
    throw new Error("Runtime file escapes the recording contour");
  }
  let current = path.resolve(file);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Runtime file contains a link");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(file);
}

export function createRuntimeFileRemoval(config = {}) {
  const root = config.testContourRecording?.root;
  if (!root) return (file) => unlink(file).catch(() => {});
  const { paths } = createContourCommandMapping({ root });
  const dataDir = path.resolve(config.dataDir);
  if (dataDir !== path.join(path.dirname(root), "data")) throw new Error("Recording data root mismatch");
  return async (file) => {
    const ownedRoot = path.isAbsolute(file) && inside(dataDir, file) ? dataDir : root;
    const target = path.isAbsolute(file) && inside(ownedRoot, file)
      ? file : paths.map(file, "attachment");
    assertOwnedRuntimeFile(target, ownedRoot);
    await unlink(target).catch((error) => { if (error.code !== "ENOENT") throw error; });
  };
}

export function createContourClaudeAuthority({ root, dataDir }) {
  // Validate the same profile marker as the recording provider. Persisted PID
  // fingerprints alone are not authority over a process in the source runtime.
  createContourCommandMapping({ root });
  if (path.resolve(dataDir) !== path.join(path.dirname(root), "data")) throw new Error("Recording data root mismatch");
  function validateOutputs(run) {
    const turnId = String(run?.turnId ?? "");
    if (!turnId || path.basename(turnId) !== turnId || /[\\/:\0]/u.test(turnId)) throw new Error("Invalid recording turn output identity");
    const directory = path.join(dataDir, "claude-runs");
    const outputPath = assertOwnedRuntimeFile(path.join(directory, `${turnId}.jsonl`), dataDir);
    const errorPath = assertOwnedRuntimeFile(path.join(directory, `${turnId}.err.log`), dataDir);
    if (run.claudeOutputPath != null && path.resolve(run.claudeOutputPath) !== outputPath
      || run.claudeErrorPath != null && path.resolve(run.claudeErrorPath) !== errorPath) {
      throw new Error("Claude output does not belong to its recording turn");
    }
  }
  return Object.freeze({
    started(run) {
      if (run?.pid && run.contourProcessRoot !== root) throw new Error("Captured PID cannot become recording process authority");
      validateOutputs(run);
      run.contourProcessRoot = root;
    },
    owns(run) {
      if (run?.contourProcessRoot !== root) return false;
      validateOutputs(run);
      return true;
    },
    validateOutputs,
  });
}

export function createContourAwareDiffCapture(config, capture) {
  const root = config?.testContourRecording?.root;
  if (!root) return capture;
  const policy = createContourExternalEffects({ root });
  return async (baseline) => {
    policy.exclude("task-git-diff", "capture", [{ projectRoot: baseline?.projectRoot ?? baseline?.repoRoot ?? "" }]);
    // null means retain the last persisted diff; an empty string would erase it.
    return null;
  };
}

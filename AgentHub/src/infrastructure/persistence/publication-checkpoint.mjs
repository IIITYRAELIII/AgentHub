import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { preparePublicationTestSelection } from "../filesystem/publication-test-selection.mjs";

export function publicationCheckpointFile(environment = process.env) {
  const root = environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
  return path.join(root, "AgentHub", "publication-checkpoint.json");
}

export async function readPublicationCheckpoint(file = publicationCheckpointFile()) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writePublicationCheckpoint(value, file = publicationCheckpointFile()) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function clearPublicationCheckpoint(file = publicationCheckpointFile()) {
  await rm(file, { force: true });
}

export function publicationCheckpointStore(file = publicationCheckpointFile()) {
  return {
    read: () => readPublicationCheckpoint(file),
    write: (value) => writePublicationCheckpoint(value, file),
    clear: () => clearPublicationCheckpoint(file),
  };
}

export const PUBLIC_INSTALLER_HANDOFF = "public-runtime-installer-handoff-v1";

function publicInstallerHandoff(step, result, identity) {
  if (result?.kind !== PUBLIC_INSTALLER_HANDOFF) return null;
  const binding = step.publicInstallerBinding;
  if (step.label !== "Установка runtime-релиза" || result.status !== "waiting"
      || !binding || Object.keys(binding).sort().join() !== "candidate,generation,operationId,targetId"
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(binding.operationId ?? "")
      || !Number.isSafeInteger(binding.generation) || binding.generation < 1
      || !/^[a-f0-9]{64}$/u.test(binding.candidate ?? "")
      || typeof binding.targetId !== "string" || !binding.targetId.trim()
      || !isDeepStrictEqual(identity?.publicInstallerBinding, binding)
      || !isDeepStrictEqual(result.binding, binding)) {
    throw new Error("Public installer handoff binding differs from its publication step");
  }
  return result;
}

export async function runPublicationSteps(steps, {
  run,
  checkpoint = null,
  identity = null,
  checkpointScope = identity,
  journal = null,
} = {}) {
  const executeStep = async step => {
    let prepared = step;
    if (step.testSelectionPlan) {
      const args = step.args;
      if (!identity?.testPlan || JSON.stringify(identity.testPlan) !== JSON.stringify(step.testSelectionPlan)
          || step.command !== process.execPath || args?.length !== 2
          || args[0] !== "test-suite.mjs" || args[1] !== "selected"
          || path.resolve(step.cwd) !== path.join(path.resolve(identity.worktreeRoot), "AgentHub")) {
        throw new Error("Selected-test step differs from its publication identity");
      }
      prepared = { ...step, args: [...args, ...await preparePublicationTestSelection(step.testSelectionPlan, {
        repositoryRoot: identity.worktreeRoot, revision: identity.revision,
      })] };
    }
    return run({ ...prepared, logFile: journal?.logFile ?? "" });
  };
  await journal?.start(identity, steps);
  if (!checkpoint) {
    try {
      for (const step of steps) {
        await journal?.stepStarted(step.label);
        try {
          const waiting = publicInstallerHandoff(step, await executeStep(step), identity);
          if (waiting) {
            await journal?.stepFinished(step.label, { status: "waiting" });
            return waiting;
          }
          await journal?.stepFinished(step.label, { status: "completed" });
        } catch (error) {
          await journal?.stepFinished(step.label, { status: "failed", error });
          throw error;
        }
      }
    } catch (error) {
      throw error;
    }
    return;
  }
  const saved = await checkpoint.read();
  if (saved?.pendingPublicInstaller
      && !isDeepStrictEqual(saved.pendingPublicInstaller.binding, identity?.publicInstallerBinding)) {
    throw new Error("Public installer checkpoint binding changed while awaiting its original");
  }
  const exactIdentity = JSON.stringify(saved?.identity) === JSON.stringify(identity);
  const matchingScope = JSON.stringify(saved?.checkpointScope ?? saved?.identity)
    === JSON.stringify(checkpointScope);
  const completed = new Set(exactIdentity ? saved?.completedLabels ?? [] : []);
  const completedFingerprints = matchingScope ? { ...(saved?.completedFingerprints ?? {}) } : {};
  try {
    for (const step of steps) {
      const fingerprint = String(step.fingerprint ?? "").trim();
      const reusable = step.reusable !== false && (fingerprint
        ? completedFingerprints[step.label] === fingerprint
        : completed.has(step.label));
      if (reusable && (!step.verifyReuse || await step.verifyReuse())) {
        console.log(`\n==> ${step.label}: уже выполнено, продолжаю публикацию`);
        await journal?.stepFinished(step.label, { status: "reused" });
        continue;
      }
      await journal?.stepStarted(step.label);
      try {
        const waiting = publicInstallerHandoff(step, await executeStep(step), identity);
        if (waiting) {
          await journal?.stepFinished(step.label, { status: "waiting" });
          await checkpoint.write({ identity, checkpointScope, completedLabels: [...completed],
            completedFingerprints, pendingPublicInstaller: waiting, updatedAt: new Date().toISOString() });
          return waiting;
        }
      } catch (error) {
        await journal?.stepFinished(step.label, { status: "failed", error });
        throw error;
      }
      await journal?.stepFinished(step.label, { status: "completed" });
      completed.add(step.label);
      if (fingerprint) completedFingerprints[step.label] = fingerprint;
      await checkpoint.write({
        identity,
        checkpointScope,
        completedLabels: [...completed],
        completedFingerprints,
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    throw error;
  }
}

import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { publicationCheckpointFile, readPublicationCheckpoint } from "./publication-checkpoint.mjs";
import { publicationLockOwned } from "../process/publication-lock.mjs";

const TERMINAL_STATUSES = new Set(["succeeded", "published", "failed", "interrupted"]);
export const PUBLICATION_STAGE_CONTRACT_VERSION = 1;
export const PUBLICATION_STAGE_CONTRACT = Object.freeze([
  { id: "release-candidate-contour", label: "Проверка release candidate в изолированном контуре", effect: false },
  { id: "agent-hub-full-tests", label: "Полные тесты Agent Hub", effect: false },
  { id: "prepare-publication-artifacts", label: "Подготовка артефактов публикации", effect: true },
  { id: "publish-git", label: "Публикация Git", effect: true },
  { id: "install-runtime-release", label: "Установка runtime-релиза", effect: true },
  { id: "deploy-mini-app-worker", label: "Развёртывание Mini App Worker", effect: true },
  { id: "verify-mini-app-worker", label: "Проверка Mini App Worker", effect: true },
  { id: "activate-runtime-release", label: "Активация runtime-релиза", effect: true },
  { id: "install-vscode-extension", label: "Установка расширения VS Code", effect: true },
]);
const PUBLICATION_STAGE_BY_LABEL = new Map(PUBLICATION_STAGE_CONTRACT.map((stage) => [stage.label, stage]));
const PRE_EFFECT_STEPS = new Set(PUBLICATION_STAGE_CONTRACT.filter((stage) => !stage.effect)
  .map((stage) => stage.label));
const PUBLICATION_STAGE_LABELS = PUBLICATION_STAGE_CONTRACT.map((stage) => stage.label);

function stageRecord(label) {
  const stage = PUBLICATION_STAGE_BY_LABEL.get(label);
  return { label, stageId: stage?.id ?? null, status: "pending" };
}

export function failedFrozenPublicationEvidence(run, checkpoint, {
  expectedRunId, allowLegacyHashBound = false,
} = {}) {
  if (run?.version !== 2 || run.status !== "failed" || !run.finishedAt || run.currentStep !== null
      || !emptyRecord(run.progress) || run.runId !== expectedRunId) {
    throw new Error("publication freeze recovery requires one exact terminal failed publication run");
  }
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const labels = steps.map((step) => step.label);
  if (stableText(run.identity?.labels ?? []) !== stableText(labels)
      || stableText(labels) !== stableText(PUBLICATION_STAGE_LABELS)) {
    throw new Error("publication freeze recovery found an unknown or incomplete publication stage contract");
  }
  const legacy = run.stageContractVersion == null;
  if (legacy && !allowLegacyHashBound) {
    throw new Error("publication freeze recovery legacy publication stages require an exact raw run hash");
  }
  if (!legacy && run.stageContractVersion !== PUBLICATION_STAGE_CONTRACT_VERSION) {
    throw new Error("publication freeze recovery publication stage schema changed");
  }
  for (let index = 0; index < steps.length; index += 1) {
    const expectedStage = PUBLICATION_STAGE_CONTRACT[index];
    const step = steps[index];
    if ((!legacy && step.stageId !== expectedStage.id)
        || (expectedStage.effect && step.status !== "pending")) {
      throw new Error("publication freeze recovery found publication effect or ambiguous stage evidence");
    }
  }
  const contourFailed = steps[0].status === "failed" && steps[1].status === "pending";
  const contourCompleted = steps[0].status === "completed" && steps[1].status === "failed";
  const contourReused = steps[0].status === "reused" && steps[1].status === "failed";
  const fullTestsFailed = contourCompleted || contourReused;
  if (!contourFailed && !fullTestsFailed) {
    throw new Error("publication freeze recovery requires an exact terminal pre-effect validation failure");
  }
  const failedStageIndex = contourFailed ? 0 : 1;
  let checkpointObservation = "absent";
  if (!checkpoint && !contourFailed) {
    throw new Error("publication freeze recovery full-test failure requires its current checkpoint");
  }
  if (checkpoint) {
    const checkpointIdentity = checkpoint.identity;
    const expectedScope = {
      mode: "changed", from: run.identity?.from, runtimeRoot: run.identity?.runtimeRoot,
      validationMode: run.identity?.validationMode,
    };
    if (stableText(checkpointIdentity?.labels ?? []) !== stableText(PUBLICATION_STAGE_LABELS)
        || stableText(checkpoint.checkpointScope) !== stableText(expectedScope)
        || checkpointIdentity?.mode !== run.identity?.mode
        || checkpointIdentity?.from !== run.identity?.from
        || checkpointIdentity?.runtimeRoot !== run.identity?.runtimeRoot
        || checkpointIdentity?.worktreeRoot !== run.identity?.worktreeRoot
        || checkpointIdentity?.validationMode !== run.identity?.validationMode
        || checkpointIdentity?.artifactProtocol !== run.identity?.artifactProtocol
        || checkpointIdentity?.release?.workspaceId !== run.identity?.release?.workspaceId
        || checkpointIdentity?.release?.primaryRoot !== run.identity?.release?.primaryRoot) {
      throw new Error("publication freeze recovery publication checkpoint schema or scope changed");
    }
    const completedLabels = [...(checkpoint.completedLabels ?? [])];
    const fingerprintLabels = Object.keys(checkpoint.completedFingerprints ?? {});
    const orderedPrefix = PUBLICATION_STAGE_LABELS.slice(0, completedLabels.length);
    if (stableText(completedLabels) !== stableText(fingerprintLabels)
        || stableText(completedLabels) !== stableText(orderedPrefix)
        || completedLabels.some((label) => !PRE_EFFECT_STEPS.has(label))) {
      throw new Error("publication freeze recovery publication checkpoint reached an effect stage");
    }
    const currentIdentity = stableText(checkpointIdentity) === stableText(run.identity);
    if (currentIdentity) {
      if (contourFailed) {
        throw new Error("publication freeze recovery contour failure cannot own a current checkpoint");
      }
      const expectedCompleted = PUBLICATION_STAGE_LABELS.slice(0, failedStageIndex);
      if (stableText(completedLabels) !== stableText(expectedCompleted)) {
        throw new Error("publication freeze recovery current publication checkpoint contradicts the failed stage");
      }
      checkpointObservation = "current-candidate";
    } else {
      if (contourCompleted) {
        throw new Error("publication freeze recovery completed contour requires its current checkpoint");
      }
      if (contourReused && completedLabels[0] !== PUBLICATION_STAGE_LABELS[0]) {
        throw new Error("publication freeze recovery reused contour lacks retained checkpoint evidence");
      }
      const checkpointGeneration = [
        checkpointIdentity?.revision,
        checkpointIdentity?.release?.planRevision,
        checkpointIdentity?.release?.manifestHash,
        checkpointIdentity?.release?.preReleaseHead,
      ];
      const runGeneration = [
        run.identity?.revision,
        run.identity?.release?.planRevision,
        run.identity?.release?.manifestHash,
        run.identity?.release?.preReleaseHead,
      ];
      if (checkpointGeneration.some((value) => value == null)
          || checkpointGeneration.some((value, index) => value === runGeneration[index])) {
        throw new Error("publication freeze recovery publication checkpoint has mixed candidate identity");
      }
      checkpointObservation = "retained-prior-generation";
    }
  }
  return {
    stageContractVersion: legacy ? "legacy-hash-bound-v1" : PUBLICATION_STAGE_CONTRACT_VERSION,
    stageIds: PUBLICATION_STAGE_CONTRACT.map((stage) => stage.id),
    failedStageId: PUBLICATION_STAGE_CONTRACT[failedStageIndex].id,
    checkpointObservation,
  };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]),
  );
  return value;
}

function stableText(value) {
  return JSON.stringify(stable(value));
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function emptyRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertPreEffectInterruption(previous, checkpoint, isProcessAlive) {
  if (previous?.version !== 2 || previous.status !== "running") {
    throw new Error("a different publication identity has a nonterminal run that is not safely interruptible");
  }
  if (isProcessAlive(Number(previous.ownerPid))) {
    throw new Error("a different publication identity still has a live writer");
  }
  if (!emptyRecord(previous.progress)) {
    throw new Error("a different publication identity has durable publication progress");
  }
  const steps = Array.isArray(previous.steps) ? previous.steps : [];
  if (!steps.length || stableText(previous.identity?.labels ?? []) !== stableText(steps.map(({ label }) => label))) {
    throw new Error("a different publication identity has ambiguous stage history");
  }
  const reached = steps.filter((step) => step.status !== "pending");
  if (!reached.length || reached.some((step) => !PRE_EFFECT_STEPS.has(step.label))) {
    throw new Error("a different publication identity reached a publication effect stage");
  }
  if (previous.currentStep && !PRE_EFFECT_STEPS.has(previous.currentStep)) {
    throw new Error("a different publication identity stopped at a publication effect stage");
  }
  if (!checkpoint) {
    throw new Error("publication checkpoint is required to interrupt a different publication identity");
  }
  if (stableText(checkpoint.identity) !== stableText(previous.identity)) {
    throw new Error("publication checkpoint belongs to a different interrupted identity");
  }
  const checkpointLabels = [
    ...(checkpoint.completedLabels ?? []),
    ...Object.keys(checkpoint.completedFingerprints ?? {}),
  ];
  if (checkpointLabels.some((label) => !PRE_EFFECT_STEPS.has(label))) {
    throw new Error("publication checkpoint proves a publication effect stage was reached");
  }
}

function stateRoot(environment = process.env) {
  return environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
}

export function publicationRunPaths(environment = process.env) {
  const root = path.join(stateRoot(environment), "AgentHub");
  return {
    statusFile: path.join(root, "publication-status.json"),
    logDirectory: path.join(root, "publication-runs"),
  };
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function readPublicationRunStatus(file = publicationRunPaths().statusFile) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function publicationRunStore({
  environment = process.env,
  runtimeRoot = null,
  now = () => new Date(),
  createId = randomUUID,
  ownerPid = () => process.pid,
  isProcessAlive = processAlive,
  afterInterruptedArchive = async () => {},
  afterTerminalArchive = async () => {},
} = {}) {
  const paths = runtimeRoot ? {
    statusFile: path.join(runtimeRoot, "publication-status.json"),
    logDirectory: path.join(runtimeRoot, "publication-runs"),
  } : publicationRunPaths(environment);
  const checkpointFile = runtimeRoot
    ? path.join(runtimeRoot, "publication-checkpoint.json")
    : publicationCheckpointFile(environment);
  let state = null;
  return {
    read: () => readPublicationRunStatus(paths.statusFile),
    get progress() {
      return structuredClone(state?.progress ?? {});
    },
    get logFile() {
      return state?.logFile ?? "";
    },
    async start(identity, steps) {
      const startedAt = now();
      const previous = await readPublicationRunStatus(paths.statusFile);
      if (previous?.version === 2
        && stableText(previous.identity) === stableText(identity)
        && ["running", "failed", "awaiting_restart", "awaiting_finalization"].includes(previous.status)) {
        state = previous;
        state.attempts.push({ startedAt: startedAt.toISOString(), previousStatus: state.status });
        state.status = "running";
        state.ownerPid = ownerPid();
        state.finishedAt = null;
        state.currentStep = null;
        state.error = null;
        for (const step of state.steps) {
          if (step.status === "running") step.status = "interrupted";
        }
        for (const step of steps) {
          if (!state.steps.some((item) => item.label === step.label)) state.steps.push({ label: step.label, status: "pending" });
        }
        await appendFile(state.logFile, `\nResumed: ${startedAt.toISOString()}\n`, "utf8");
        await writeJsonAtomic(paths.statusFile, state);
        return;
      }
      if (previous && !TERMINAL_STATUSES.has(previous.status)) {
        if (!publicationLockOwned({ environment })) {
          throw new Error("a different nonterminal publication run requires the canonical publication lock");
        }
        const checkpoint = await readPublicationCheckpoint(checkpointFile);
        assertPreEffectInterruption(previous, checkpoint, isProcessAlive);
        if (!pathInside(paths.logDirectory, previous.logFile)
            || !path.basename(previous.logFile).includes(String(previous.runId ?? ""))) {
          throw new Error("interrupted publication log identity is outside the canonical run directory");
        }
        const archiveFile = `${previous.logFile}.status.json`;
        const archived = await readPublicationRunStatus(archiveFile);
        const finishedAt = archived?.finishedAt ?? startedAt.toISOString();
        const interrupted = structuredClone(previous);
        interrupted.status = "interrupted";
        interrupted.finishedAt = finishedAt;
        interrupted.currentStep = null;
        interrupted.error = "Interrupted before publication effects by a different candidate";
        interrupted.steps = interrupted.steps.map((step) => step.status === "running"
          ? { ...step, status: "interrupted", finishedAt, error: interrupted.error }
          : step);
        interrupted.interruption = {
          kind: "pre_effect_candidate_replacement",
          replacementIdentitySha256: createHash("sha256").update(stableText(identity)).digest("hex"),
          checkpointCompletedLabels: [...(checkpoint?.completedLabels ?? [])],
        };
        if (archived && stableText(archived) !== stableText(interrupted)) {
          throw new Error("interrupted publication archive conflicts with the exact prior run");
        }
        if (!archived) await writeJsonAtomic(archiveFile, interrupted);
        await afterInterruptedArchive({ previous: structuredClone(previous), interrupted, archiveFile });
      }
      if (previous && TERMINAL_STATUSES.has(previous.status)) {
        if (!pathInside(paths.logDirectory, previous.logFile)
            || !path.basename(previous.logFile).includes(String(previous.runId ?? ""))) {
          throw new Error("terminal publication log identity is outside the canonical run directory");
        }
        const archiveFile = `${previous.logFile}.status.json`;
        const archived = await readPublicationRunStatus(archiveFile);
        if (archived && stableText(archived) !== stableText(previous)) {
          throw new Error("terminal publication archive conflicts with the exact prior run");
        }
        if (!archived) await writeJsonAtomic(archiveFile, previous);
        await afterTerminalArchive({ previous: structuredClone(previous), archiveFile });
      }
      const runId = createId();
      const timestamp = startedAt.toISOString().replaceAll(":", "-");
      state = {
        version: 2,
        stageContractVersion: PUBLICATION_STAGE_CONTRACT_VERSION,
        runId,
        status: "running",
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        currentStep: null,
        ownerPid: ownerPid(),
        attempts: [{ startedAt: startedAt.toISOString() }],
        progress: {},
        identity,
        logFile: path.join(paths.logDirectory, `${timestamp}-${runId}.log`),
        steps: steps.map((step) => stageRecord(step.label)),
        error: null,
      };
      await mkdir(paths.logDirectory, { recursive: true });
      await writeFile(state.logFile, `Agent Hub publication ${runId}\nStarted: ${state.startedAt}\n\n`, "utf8");
      await writeJsonAtomic(paths.statusFile, state);
    },
    async stepStarted(label) {
      let step = state.steps.find((item) => item.label === label);
      if (!step) {
        step = stageRecord(label);
        state.steps.push(step);
      }
      Object.assign(step, { status: "running", startedAt: now().toISOString() });
      state.currentStep = label;
      await writeJsonAtomic(paths.statusFile, state);
    },
    async stepFinished(label, { status, error = null } = {}) {
      let step = state.steps.find((item) => item.label === label);
      if (!step) {
        step = stageRecord(label);
        state.steps.push(step);
      }
      Object.assign(step, {
        status,
        finishedAt: now().toISOString(),
        error: error ? String(error.message ?? error) : null,
      });
      state.currentStep = null;
      await writeJsonAtomic(paths.statusFile, state);
    },
    async updateProgress(value) {
      state.progress = { ...state.progress, ...structuredClone(value) };
      await writeJsonAtomic(paths.statusFile, state);
    },
    async finish(status, error = null) {
      if (!state) return;
      state.status = status;
      state.currentStep = null;
      state.finishedAt = TERMINAL_STATUSES.has(status) ? now().toISOString() : null;
      state.error = error ? String(error.message ?? error) : null;
      await writeJsonAtomic(paths.statusFile, state);
    },
  };
}

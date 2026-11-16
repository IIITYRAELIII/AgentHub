// Read-only legacy journal/evidence codec; no product execution or writer.
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";


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
  return failedValidationEvidence(run, checkpoint, { expectedRunId, allowLegacyHashBound }, PUBLICATION_STAGE_CONTRACT);
}

export function failedPublicPackageValidationEvidence(run, checkpoint, { expectedRunId } = {}) {
  if (run?.identity?.deploymentProfile !== "github-release" || !run.identity.testPlan) {
    throw new Error("Public package validation requires its original selected distribution profile");
  }
  return failedValidationEvidence(run, checkpoint, { expectedRunId, allowLegacyHashBound: false, bindTestPlan: true }, [
    PUBLICATION_STAGE_CONTRACT[0],
    { id: null, label: "Выбранные тесты Agent Hub", effect: false },
    PUBLICATION_STAGE_CONTRACT[2],
    { id: null, label: "Упаковка установочного архива", effect: true },
    PUBLICATION_STAGE_CONTRACT[3],
    { id: null, label: "Публикация GitHub Release", effect: true },
  ]);
}

function failedValidationEvidence(run, checkpoint, { expectedRunId, allowLegacyHashBound, bindTestPlan = false }, stageContract) {
  const stageLabels = stageContract.map(stage => stage.label);
  const preEffectSteps = new Set(stageContract.filter(stage => !stage.effect).map(stage => stage.label));
  if (run?.version !== 2 || run.status !== "failed" || !run.finishedAt || run.currentStep !== null
      || !emptyRecord(run.progress) || run.runId !== expectedRunId) {
    throw new Error("publication freeze recovery requires one exact terminal failed publication run");
  }
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const labels = steps.map((step) => step.label);
  if (stableText(run.identity?.labels ?? []) !== stableText(labels)
      || stableText(labels) !== stableText(stageLabels)) {
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
    const expectedStage = stageContract[index];
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
      ...(bindTestPlan ? { testPlan: run.identity.testPlan } : {}),
    };
    if (stableText(checkpointIdentity?.labels ?? []) !== stableText(stageLabels)
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
    const fingerprintValues = completedLabels.map((label) => checkpoint.completedFingerprints?.[label]);
    const orderedPrefix = stageLabels.slice(0, completedLabels.length);
    if (stableText(completedLabels) !== stableText(fingerprintLabels)
        || stableText(completedLabels) !== stableText(orderedPrefix)
        || completedLabels.some((label) => !preEffectSteps.has(label))) {
      throw new Error("publication freeze recovery publication checkpoint reached an effect stage");
    }
    if (fingerprintValues.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("publication freeze recovery publication checkpoint fingerprints are invalid");
    }
    const currentIdentity = stableText(checkpointIdentity) === stableText(run.identity);
    if (currentIdentity) {
      if (contourFailed) {
        throw new Error("publication freeze recovery contour failure cannot own a current checkpoint");
      }
      const expectedCompleted = stageLabels.slice(0, failedStageIndex);
      if (stableText(completedLabels) !== stableText(expectedCompleted)) {
        throw new Error("publication freeze recovery current publication checkpoint contradicts the failed stage");
      }
      checkpointObservation = "current-candidate";
    } else {
      if (completedLabels.length < 1 || completedLabels.length > preEffectSteps.size) {
        throw new Error("publication freeze recovery retained checkpoint has no durable pre-effect prefix");
      }
      if (contourCompleted) {
        throw new Error("publication freeze recovery completed contour requires its current checkpoint");
      }
      if (contourReused && completedLabels[0] !== stageLabels[0]) {
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
    stageIds: stageContract.map((stage) => stage.id),
    failedStageId: stageContract[failedStageIndex].id,
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

function emptyRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
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

export async function readPublicationRunStatus(file = publicationRunPaths().statusFile) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

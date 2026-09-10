import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
} = {}) {
  const paths = runtimeRoot ? {
    statusFile: path.join(runtimeRoot, "publication-status.json"),
    logDirectory: path.join(runtimeRoot, "publication-runs"),
  } : publicationRunPaths(environment);
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
        && JSON.stringify(previous.identity) === JSON.stringify(identity)
        && !["succeeded", "published"].includes(previous.status)) {
        state = previous;
        state.attempts.push({ startedAt: startedAt.toISOString(), previousStatus: state.status });
        state.status = "running";
        state.ownerPid = process.pid;
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
      const runId = createId();
      const timestamp = startedAt.toISOString().replaceAll(":", "-");
      state = {
        version: 2,
        runId,
        status: "running",
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        currentStep: null,
        ownerPid: process.pid,
        attempts: [{ startedAt: startedAt.toISOString() }],
        progress: {},
        identity,
        logFile: path.join(paths.logDirectory, `${timestamp}-${runId}.log`),
        steps: steps.map((step) => ({ label: step.label, status: "pending" })),
        error: null,
      };
      await mkdir(paths.logDirectory, { recursive: true });
      await writeFile(state.logFile, `Agent Hub publication ${runId}\nStarted: ${state.startedAt}\n\n`, "utf8");
      await writeJsonAtomic(paths.statusFile, state);
    },
    async stepStarted(label) {
      let step = state.steps.find((item) => item.label === label);
      if (!step) {
        step = { label, status: "pending" };
        state.steps.push(step);
      }
      Object.assign(step, { status: "running", startedAt: now().toISOString() });
      state.currentStep = label;
      await writeJsonAtomic(paths.statusFile, state);
    },
    async stepFinished(label, { status, error = null } = {}) {
      let step = state.steps.find((item) => item.label === label);
      if (!step) {
        step = { label };
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
      state.finishedAt = ["succeeded", "published", "failed"].includes(status) ? now().toISOString() : null;
      state.error = error ? String(error.message ?? error) : null;
      await writeJsonAtomic(paths.statusFile, state);
    },
  };
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
  now = () => new Date(),
  createId = randomUUID,
} = {}) {
  const paths = publicationRunPaths(environment);
  let state = null;
  return {
    get logFile() {
      return state?.logFile ?? "";
    },
    async start(identity, steps) {
      const startedAt = now();
      const runId = createId();
      const timestamp = startedAt.toISOString().replaceAll(":", "-");
      state = {
        version: 1,
        runId,
        status: "running",
        startedAt: startedAt.toISOString(),
        finishedAt: null,
        currentStep: null,
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
      const step = state.steps.find((item) => item.label === label);
      Object.assign(step, { status: "running", startedAt: now().toISOString() });
      state.currentStep = label;
      await writeJsonAtomic(paths.statusFile, state);
    },
    async stepFinished(label, { status, error = null } = {}) {
      const step = state.steps.find((item) => item.label === label);
      Object.assign(step, {
        status,
        finishedAt: now().toISOString(),
        error: error ? String(error.message ?? error) : null,
      });
      state.currentStep = null;
      await writeJsonAtomic(paths.statusFile, state);
    },
    async finish(status, error = null) {
      if (!state) return;
      state.status = status;
      state.currentStep = null;
      state.finishedAt = now().toISOString();
      state.error = error ? String(error.message ?? error) : null;
      await writeJsonAtomic(paths.statusFile, state);
    },
  };
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export async function runPublicationSteps(steps, {
  run,
  checkpoint = null,
  identity = null,
  journal = null,
} = {}) {
  await journal?.start(identity, steps);
  if (!checkpoint) {
    try {
      for (const step of steps) {
        await journal?.stepStarted(step.label);
        try {
          await run({ ...step, logFile: journal?.logFile ?? "" });
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
  const serializedIdentity = JSON.stringify(identity);
  const saved = await checkpoint.read();
  const completed = new Set(
    JSON.stringify(saved?.identity) === serializedIdentity ? saved.completedLabels ?? [] : [],
  );
  try {
    for (const step of steps) {
      if (completed.has(step.label)) {
        console.log(`\n==> ${step.label}: уже выполнено, продолжаю публикацию`);
        await journal?.stepFinished(step.label, { status: "reused" });
        continue;
      }
      await journal?.stepStarted(step.label);
      try {
        await run({ ...step, logFile: journal?.logFile ?? "" });
      } catch (error) {
        await journal?.stepFinished(step.label, { status: "failed", error });
        throw error;
      }
      await journal?.stepFinished(step.label, { status: "completed" });
      completed.add(step.label);
      await checkpoint.write({
        identity,
        completedLabels: [...completed],
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    throw error;
  }
}

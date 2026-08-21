import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function testFileCheckpointFile(environment = process.env) {
  const root = environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
  return path.join(root, "AgentHub", "test-file-checkpoint.json");
}

export async function readTestFileCheckpoint(file = testFileCheckpointFile()) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeTestFileCheckpoint(value, file = testFileCheckpointFile()) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function clearTestFileCheckpoint(file = testFileCheckpointFile()) {
  await rm(file, { force: true });
}

export function testFileCheckpointStore(file = testFileCheckpointFile()) {
  return {
    read: () => readTestFileCheckpoint(file),
    write: (value) => writeTestFileCheckpoint(value, file),
    clear: () => clearTestFileCheckpoint(file),
  };
}

export async function runCheckpointedTestFiles(files, {
  suite,
  identity = "",
  run,
  checkpoint = null,
  fingerprint = async () => "unchanged",
  log = console.log,
} = {}) {
  const saved = checkpoint && identity ? await checkpoint.read() : null;
  const state = saved?.identity === identity ? saved : { identity, suites: {} };
  const savedSuite = state.suites?.[suite];
  const completedFingerprints = { ...(savedSuite?.completedFingerprints ?? {}) };
  const failures = [];

  for (const file of files) {
    const currentFingerprint = await fingerprint(file);
    if (checkpoint && identity && completedFingerprints[file] === currentFingerprint) {
      log(`Тест уже пройден, продолжаю: ${file}`);
      continue;
    }
    delete completedFingerprints[file];
    try {
      await run(file);
      completedFingerprints[file] = currentFingerprint;
    } catch (error) {
      failures.push({ file, error });
    }
    state.suites = {
      ...state.suites,
      [suite]: {
        files,
        completedFingerprints,
        failedFiles: failures.map((failure) => failure.file),
      },
    };
    state.updatedAt = new Date().toISOString();
    if (checkpoint && identity) await checkpoint.write(state);
  }

  if (failures.length) {
    const summary = failures.map(({ file, error }) => `${file}: ${error.message}`).join("\n");
    throw new AggregateError(
      failures.map(({ error }) => error),
      `${suite}: не пройдено файлов: ${failures.length}\n${summary}`,
    );
  }
}

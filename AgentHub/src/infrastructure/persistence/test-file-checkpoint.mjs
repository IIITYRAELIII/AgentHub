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
  log = console.log,
} = {}) {
  if (!checkpoint || !identity) {
    for (const file of files) await run(file);
    return;
  }

  const saved = await checkpoint.read();
  const state = saved?.identity === identity
    ? saved
    : { identity, suites: {} };
  const savedSuite = state.suites?.[suite];
  const completed = new Set(
    JSON.stringify(savedSuite?.files) === JSON.stringify(files)
      ? savedSuite.completedFiles ?? []
      : [],
  );

  for (const file of files) {
    if (completed.has(file)) {
      log(`Тест уже пройден, продолжаю: ${file}`);
      continue;
    }
    await run(file);
    completed.add(file);
    state.suites = {
      ...state.suites,
      [suite]: {
        files,
        completedFiles: [...completed],
      },
    };
    state.updatedAt = new Date().toISOString();
    await checkpoint.write(state);
  }
}

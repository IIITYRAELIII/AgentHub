import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile, stat } from "node:fs/promises";
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
    if ((await stat(file)).size > 4 * 1024 * 1024) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
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
  now = Date.now,
  retentionMs = 30 * 24 * 60 * 60_000,
  maxEntries = 2_000,
} = {}) {
  const saved = checkpoint && identity ? await checkpoint.read() : null;
  // Legacy hashes omitted IO inputs and toolchains, so never upgrade them into
  // successful evidence. Release identity is metadata; v2 hashes own reuse.
  const state = saved?.version === 2 ? structuredClone(saved) : { version: 2, suites: {} };
  state.identity = identity;
  const entries = [];
  const cutoff = now() - retentionMs;
  for (const [suiteName, value] of Object.entries(state.suites ?? {})) {
    for (const [file, fingerprint] of Object.entries(value.completedFingerprints ?? {})) {
      const timestamp = value.completedAt?.[file];
      if (typeof fingerprint === "string" && Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now()) {
        entries.push({ suiteName, file, fingerprint, timestamp });
      }
    }
  }
  state.suites = {};
  for (const entry of entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, maxEntries)) {
    const value = state.suites[entry.suiteName] ??= { completedFingerprints: {}, completedAt: {} };
    value.completedFingerprints[entry.file] = entry.fingerprint;
    value.completedAt[entry.file] = entry.timestamp;
  }
  const savedSuite = state.suites?.[suite];
  const selected = new Set(files);
  const completedFingerprints = Object.fromEntries(Object.entries(savedSuite?.completedFingerprints ?? {}).filter(([file]) => selected.has(file)));
  const completedAt = { ...(savedSuite?.completedAt ?? {}) };
  const failures = [];

  for (const file of files) {
    const currentFingerprint = await fingerprint(file);
    if (checkpoint && identity && currentFingerprint && completedFingerprints[file] === currentFingerprint) {
      log(`Тест уже пройден, продолжаю: ${file}`);
      continue;
    }
    delete completedFingerprints[file];
    delete completedAt[file];
    if (!currentFingerprint && checkpoint && identity) log(`Тест без кэша (входные данные не подтверждены): ${file}`);
    try {
      await run(file);
      if (currentFingerprint) {
        completedFingerprints[file] = currentFingerprint;
        completedAt[file] = now();
      }
    } catch (error) {
      failures.push({ file, error });
    }
    state.suites = {
      ...state.suites,
      [suite]: {
        completedFingerprints,
        completedAt,
        failedFiles: failures.map((failure) => failure.file),
      },
    };
    // Enforce the same count bound as new results arrive, not only next run.
    const all = Object.entries(state.suites).flatMap(([name, value]) => Object.keys(value.completedFingerprints).map((key) => ({ name, key, at: value.completedAt[key] })));
    for (const entry of all.sort((a, b) => b.at - a.at).slice(maxEntries)) {
      delete state.suites[entry.name].completedFingerprints[entry.key];
      delete state.suites[entry.name].completedAt[entry.key];
    }
    state.updatedAt = new Date(now()).toISOString();
    if (checkpoint && identity) await checkpoint.write(state);
  }

  // A wholly reused suite still persists pruning and its current release ID.
  if (checkpoint && identity) await checkpoint.write(state);

  if (failures.length) {
    const summary = failures.map(({ file, error }) => `${file}: ${error.message}`).join("\n");
    throw new AggregateError(
      failures.map(({ error }) => error),
      `${suite}: не пройдено файлов: ${failures.length}\n${summary}`,
    );
  }
}

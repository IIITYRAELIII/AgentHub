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
  concurrency = 1,
  execution = async () => ({ parallel: false, shared: [] }),
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
  const pending = [];
  const normalizedConcurrency = Math.max(1, Math.floor(Number(concurrency) || 1));

  for (const [index, file] of files.entries()) {
    const fingerprintResult = await fingerprint(file);
    const currentFingerprint = typeof fingerprintResult === "string"
      ? fingerprintResult : fingerprintResult?.fingerprint ?? null;
    const missReasons = Array.isArray(fingerprintResult?.missReasons)
      ? fingerprintResult.missReasons.filter((value) => typeof value === "string" && value) : [];
    if (checkpoint && identity && currentFingerprint && completedFingerprints[file] === currentFingerprint) {
      log(`Тест уже пройден, продолжаю: ${file}`);
      continue;
    }
    delete completedFingerprints[file];
    delete completedAt[file];
    if (checkpoint && identity) {
      if (!currentFingerprint) log(`Тест без кэша (${missReasons.join(", ") || "input-proof-unavailable"}): ${file}`);
      else if (savedSuite?.completedFingerprints?.[file]) log(`Кэш теста изменился (input fingerprint): ${file}`);
      else log(`Кэш теста отсутствует: ${file}`);
    }
    const policy = await execution(file);
    pending.push({
      file,
      index,
      currentFingerprint,
      parallel: policy?.parallel === true,
      shared: new Set(Array.isArray(policy?.shared) ? policy.shared : []),
    });
  }

  let persist = Promise.resolve();
  const persistState = () => {
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
    if (checkpoint && identity) {
      const snapshot = structuredClone(state);
      persist = persist.then(() => checkpoint.write(snapshot));
    }
    return persist;
  };
  const active = new Set();
  const conflicts = (candidate) => !candidate.parallel
    ? active.size > 0
    : [...active].some((running) => !running.parallel
      || [...candidate.shared].some((resource) => running.shared.has(resource)));
  const ordered = [
    ...pending.filter((item) => item.parallel),
    ...pending.filter((item) => !item.parallel),
  ];
  const executeOne = async (item) => {
    let error = null;
    try {
      await run(item.file);
      if (item.currentFingerprint) {
        completedFingerprints[item.file] = item.currentFingerprint;
        completedAt[item.file] = now();
      }
    } catch (caught) {
      error = caught;
      failures.push({ file: item.file, error: caught, index: item.index });
    } finally {
      active.delete(item);
      await persistState();
    }
    return error;
  };
  const running = new Set();
  while (ordered.length || running.size) {
    let launched = false;
    while (ordered.length && running.size < normalizedConcurrency) {
      const candidateIndex = ordered.findIndex((item) => !conflicts(item));
      if (candidateIndex < 0) break;
      const [item] = ordered.splice(candidateIndex, 1);
      active.add(item);
      const operation = executeOne(item).finally(() => running.delete(operation));
      running.add(operation);
      launched = true;
    }
    if (running.size) await Promise.race(running);
    else if (!launched && ordered.length) throw new Error("Test scheduler cannot make progress");
  }

  // A wholly reused suite still persists pruning and its current release ID.
  if (checkpoint && identity) await persistState();

  if (failures.length) {
    failures.sort((a, b) => a.index - b.index);
    const summary = failures.map(({ file, error }) => `${file}: ${error.message}`).join("\n");
    throw new AggregateError(
      failures.map(({ error }) => error),
      `${suite}: не пройдено файлов: ${failures.length}\n${summary}`,
    );
  }
}

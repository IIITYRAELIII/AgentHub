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

function testFailureFacts(error, depth = 0) {
  if (!error || typeof error !== "object") return { name: "NonErrorFailure" };
  try {
    const facts = Object.fromEntries(
      ["name", "code", "signal", "syscall", "killed", "testPhase", "testExecutionSucceeded", "processTreeStopped"]
        .filter(key => ["string", "number", "boolean"].includes(typeof error[key]))
        .map(key => [key, typeof error[key] === "string" ? error[key].slice(0, 128) : error[key]]));
    if (typeof error.testRoot === "string") {
      facts.testRoot = error.testRoot.slice(0, 1024);
      if (error.testRoot.length > 1024) facts.testRootTruncated = true;
      if (typeof error.path === "string") {
        const relative = path.relative(error.testRoot, error.path);
        if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
          facts.path = error.path.slice(0, 1024);
          if (error.path.length > 1024) facts.pathTruncated = true;
        }
      }
    }
    if (error.testChild) facts.child = Object.fromEntries(
      ["pid", "requestedAt", "spawnedAt", "exitedAt", "closedAt", "code", "signal", "errorCode"]
        .filter(key => ["string", "number"].includes(typeof error.testChild[key]))
        .map(key => [key, typeof error.testChild[key] === "string" ? error.testChild[key].slice(0, 128) : error.testChild[key]]));
    if (depth < 2) {
      if (error.cause) facts.cause = testFailureFacts(error.cause, depth + 1);
      if (Array.isArray(error.errors)) {
        facts.errors = error.errors.slice(0, 4).map(value => testFailureFacts(value, depth + 1));
        if (error.errors.length > 4) facts.omittedErrors = error.errors.length - 4;
      }
    }
    return facts;
  } catch { return { name: "UninspectableFailure" }; }
}

function retainedCheckpoint(saved, { identity, now, retentionMs, maxEntries }) {
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
  const failures = Object.entries(state.suites ?? {}).map(([name, value]) =>
    [name, Array.isArray(value.failedFiles) ? value.failedFiles.filter(file => typeof file === "string") : []]);
  state.suites = Object.fromEntries(failures.map(([name, failedFiles]) =>
    [name, { completedFingerprints: {}, completedAt: {}, failedFiles }]));
  for (const entry of entries.sort((a, b) => b.timestamp - a.timestamp).slice(0, maxEntries)) {
    const value = state.suites[entry.suiteName];
    value.completedFingerprints[entry.file] = entry.fingerprint;
    value.completedAt[entry.file] = entry.timestamp;
  }
  return state;
}

async function checkpointDecision(file, suite, state, fingerprint, enabled) {
  const result = await fingerprint(file);
  const currentFingerprint = typeof result === "string" ? result : result?.fingerprint ?? null;
  const missReasons = Array.isArray(result?.missReasons)
    ? result.missReasons.filter(value => typeof value === "string" && value) : [];
  const previous = state.suites[suite];
  const status = previous?.failedFiles?.includes(file) ? "failed"
    : !currentFingerprint ? "unknown"
      : enabled && previous?.completedFingerprints?.[file] === currentFingerprint ? "reusable"
        : previous?.completedFingerprints?.[file] ? "affected" : "unproven";
  return { file, suite, status, fingerprint: currentFingerprint, missReasons };
}

// Read-only input to the existing exact selection owner. Execution recomputes
// these decisions; this plan is neither a PASS nor publication authority.
export async function planCheckpointedTestFiles(files, {
  suite, suiteForFile = () => suite, identity = "", checkpoint = null,
  fingerprint = async () => null, now = Date.now,
  retentionMs = 30 * 24 * 60 * 60_000, maxEntries = 2_000,
} = {}) {
  const enabled = Boolean(checkpoint && identity);
  const state = retainedCheckpoint(enabled ? await checkpoint.read() : null,
    { identity, now, retentionMs, maxEntries });
  const entries = [];
  for (const file of files) entries.push(await checkpointDecision(file, suiteForFile(file), state, fingerprint, enabled));
  return { entries, selectedFiles: entries.filter(entry => entry.status !== "reusable").map(entry => entry.file),
    reusedFiles: entries.filter(entry => entry.status === "reusable").map(entry => entry.file) };
}

export async function runCheckpointedTestFiles(files, {
  suite,
  suiteForFile = () => suite,
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
  admission = null,
  onFile = () => {},
} = {}) {
  const saved = checkpoint && identity ? await checkpoint.read() : null;
  // Legacy hashes omitted IO inputs and toolchains, so never upgrade them into
  // successful evidence. Release identity is metadata; v2 hashes own reuse.
  const state = retainedCheckpoint(saved, { identity, now, retentionMs, maxEntries });
  const suites = new Map();
  for (const file of files) {
    const name = suiteForFile(file);
    if (!suites.has(name)) {
      const savedSuite = state.suites[name];
      suites.set(name, { savedSuite,
        completedFingerprints: { ...(savedSuite?.completedFingerprints ?? {}) },
        completedAt: { ...(savedSuite?.completedAt ?? {}) },
        failedFiles: new Set(savedSuite?.failedFiles ?? []) });
    }
  }
  const failures = [];
  const pending = [];
  const normalizedConcurrency = Math.max(1, Math.floor(Number(concurrency) || 1));

  for (const [index, file] of files.entries()) {
    const suiteName = suiteForFile(file);
    const { savedSuite, completedFingerprints, completedAt } = suites.get(suiteName);
    const decision = await checkpointDecision(file, suiteName, state, fingerprint, Boolean(checkpoint && identity));
    const { fingerprint: currentFingerprint, missReasons } = decision;
    if (decision.status === "reusable") {
      log(`Тест уже пройден, продолжаю: ${file}`);
      onFile({ file, suite: suiteName, outcome: "reused", reason: "unchanged-input-proof" });
      continue;
    }
    delete completedFingerprints[file];
    delete completedAt[file];
    if (checkpoint && identity) {
      if (decision.status === "failed") log(`Повторяю упавший тест: ${file}`);
      else if (!currentFingerprint) log(`Тест без кэша (${missReasons.join(", ") || "input-proof-unavailable"}): ${file}`);
      else if (savedSuite?.completedFingerprints?.[file]) log(`Кэш теста изменился (input fingerprint): ${file}`);
      else log(`Кэш теста отсутствует: ${file}`);
    }
    const policy = await execution(file);
    pending.push({
      file,
      suiteName,
      index,
      currentFingerprint,
      reason: decision.status,
      queuedAt: now(),
      parallel: policy?.parallel === true,
      shared: new Set(Array.isArray(policy?.shared) ? policy.shared : []),
    });
  }

  let persist = Promise.resolve();
  let persistenceError = null;
  const persistState = () => {
    for (const [name, value] of suites) {
      state.suites[name] = {
        completedFingerprints: value.completedFingerprints,
        completedAt: value.completedAt,
        failedFiles: [...value.failedFiles].sort(),
      };
    }
    // Enforce the same count bound as new results arrive, not only next run.
    const all = Object.entries(state.suites).flatMap(([name, value]) => Object.keys(value.completedFingerprints).map((key) => ({ name, key, at: value.completedAt[key] })));
    for (const entry of all.sort((a, b) => b.at - a.at).slice(maxEntries)) {
      delete state.suites[entry.name].completedFingerprints[entry.key];
      delete state.suites[entry.name].completedAt[entry.key];
    }
    state.updatedAt = new Date(now()).toISOString();
    if (checkpoint && identity) {
      const snapshot = structuredClone(state);
      persist = persist
        .then(() => persistenceError ? undefined : checkpoint.write(snapshot))
        .catch((error) => { persistenceError ??= error; });
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
    const startedAt = now();
    try {
      await run(item.file);
      suites.get(item.suiteName).failedFiles.delete(item.file);
      if (item.currentFingerprint) {
        const { completedFingerprints, completedAt } = suites.get(item.suiteName);
        completedFingerprints[item.file] = item.currentFingerprint;
        completedAt[item.file] = now();
      }
    } catch (caught) {
      error = caught;
      suites.get(item.suiteName).failedFiles.add(item.file);
      failures.push({ file: item.file, suiteName: item.suiteName, error: caught, index: item.index });
    } finally {
      active.delete(item);
      admission?.finished();
      const finishedAt = now();
      await persistState();
      onFile({ file: item.file, suite: item.suiteName, waitMs: startedAt - item.queuedAt,
        runMs: finishedAt - startedAt, outcome: error ? "failed" : "passed", reason: item.reason,
        ...(error ? { failure: testFailureFacts(error) } : {}),
      });
    }
    return error;
  };
  const running = new Set();
  let resourceChange = null;
  let admissionError = null;
  const changed = () => resourceChange ??= admission.changed()
    .finally(() => { resourceChange = null; });
  try {
  while (ordered.length || running.size) {
    if (persistenceError) {
      await Promise.all(running);
      break;
    }
    let launched = false;
    while (ordered.length && running.size < normalizedConcurrency) {
      const candidateIndex = ordered.findIndex((item) => !conflicts(item));
      if (candidateIndex < 0) break;
      if (admission && !await admission.canStart()) break;
      const [item] = ordered.splice(candidateIndex, 1);
      active.add(item);
      admission?.started();
      const operation = executeOne(item).finally(() => running.delete(operation));
      running.add(operation);
      launched = true;
    }
    if (admission) await Promise.race([...running, changed()]);
    else if (running.size) await Promise.race(running);
    else if (!launched && ordered.length) throw new Error("Test scheduler cannot make progress");
  }
  } catch (error) {
    // Monitoring/persistence failure stops new admission. In-flight tests keep
    // their original execution and successful checkpoints; never retry them.
    admissionError = error;
    await Promise.all(running);
  } finally {
    if (resourceChange) {
      try { await resourceChange; } catch (error) { admissionError ??= error; }
    }
  }

  // A wholly reused suite still persists pruning and its current release ID.
  if (checkpoint && identity) await persistState();

  if (admissionError) {
    throw new AggregateError([admissionError, ...(persistenceError ? [persistenceError] : []), ...failures.map(({ error }) => error)],
      `${suite}: resource admission failed; ${ordered.length} file(s) not started: ${admissionError.message}`);
  }

  if (persistenceError) {
    if (!failures.length) throw persistenceError;
    throw new AggregateError(
      [persistenceError, ...failures.map(({ error }) => error)],
      `${suite}: checkpoint persistence failed after ${failures.length} test failure(s): ${persistenceError.message}`,
    );
  }

  if (failures.length) {
    failures.sort((a, b) => a.index - b.index);
    const summary = failures.map(({ file, error }) => `${file}: ${error.message}`).join("\n");
    throw new AggregateError(
      failures.map(({ error }) => error),
      `${suite}: не пройдено файлов: ${failures.length}\n${summary}`,
    );
  }
}

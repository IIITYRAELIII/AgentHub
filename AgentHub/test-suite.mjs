import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  explainTestInputFingerprint,
  fingerprintTestInputs,
} from "./src/infrastructure/persistence/test-input-fingerprint.mjs";

import {
  runCheckpointedTestFiles,
  testFileCheckpointStore,
} from "./src/infrastructure/persistence/test-file-checkpoint.mjs";
import { clearInheritedPublicationOwnership } from "./src/infrastructure/process/publication-lock.mjs";
import { testResourceAdmission } from "./src/infrastructure/process/test-resource-admission.mjs";
import { prepareTaskWorktreeDependencies } from "./src/infrastructure/filesystem/task-worktree-dependencies.mjs";
import { runTaskGitCommand } from "./src/infrastructure/filesystem/task-git-workspace.mjs";

const ROOT = import.meta.dirname;
const RUNNER_INPUTS = [
  "src/infrastructure/persistence/test-file-checkpoint.mjs",
  "src/infrastructure/process/test-resource-admission.mjs",
  "src/infrastructure/process/test-resource-monitor.mjs",
  "src/infrastructure/process/test-resource-accounting.cs",
].map((file) => path.join(ROOT, file));
const TEST_RUNNER_FILE = fileURLToPath(import.meta.url);
// WIP не содержит поставляемого кода. Без этого исключения случайный
// *.test.mjs во временных материалах молча попадал бы в группу unit.
export const IGNORED_DIRECTORIES = new Set(["node_modules", "build", "dist", ".wrangler", "WIP"]);
export const E2E_FILES = [
  "tests/e2e/agent-hub-server.e2e.test.mjs",
  "tests/e2e/agent-hub-server.claude.e2e.test.mjs",
  "tests/e2e/agent-hub-server.local-control.e2e.test.mjs",
  "tests/e2e/agent-hub-server.journal.e2e.test.mjs",
  "tests/e2e/agent-hub-server.recording-contour.e2e.test.mjs",
  "tests/e2e/test-contour-recording-refresh.e2e.test.mjs",
  "tests/e2e/test-contour-model-catalog.e2e.test.mjs",
  // Измерено 2026-09-10: 1.4 с, 5 из 5 проверок пройдено. Дешёвая проверка
  // владения Thread и восстановления MCP-моста, ранее не выполнялась ни одной
  // группой. Стоимость обычного выпуска практически не меняется.
  "tests/e2e/fake-codex-accept-all.e2e.test.mjs",
  // Протокольная защита harness: fake Codex отвечает на каждый запрос даже при
  // отказе записи state. Без неё потерянный ответ выглядит как 30-секундный
  // таймаут thread/read и ложное «app-server завис». Около 2 с.
  "tests/e2e/fake-codex-app-server.e2e.test.mjs",
];
// Дорогие сценарии надёжности на настоящих процессах. Не входят в `all`.
// Запускаются профилем `reliability` при правках соответствующих подсистем.
export const RELIABILITY_E2E_FILES = [
  "tests/e2e/terminal-queue-contention.local-control.e2e.test.mjs",
];
export const VSCODE_FILES = [
  "render.test.js",
  "agent-hub-bridge.test.js",
  "runtime-reload-policy.test.js",
  "activity-bar-launch.test.js",
  "vscode-direct-transport.test.js",
];
export const VISUAL_FILES = [
  "tests/public/card-layout-dom.test.mjs",
  "tests/public/journal-account-provider-column.test.mjs",
];
// Файлы, содержащие проверки под профилем. Профильный режим выполняет эти файлы
// с включённым профилем; их остальные проверки при этом выполняются повторно.
// Это сознательный размен: диапазон правки — один аргумент у каждой проверки,
// а профили запускаются по требованию, а не в каждом выпуске.
export const PROFILE_FILES = {
  cosmetic: [
    "tests/public/card-layout-dom.test.mjs",
    "tests/public/journal-account-provider-column.test.mjs",
  ],
  stress: [
    "tests/public/stream-tabs-controller.test.mjs",
  ],
  reliability: [...RELIABILITY_E2E_FILES],
};
const python = process.platform === "win32" ? "python.exe" : "python3";

export async function discoverTestFiles(directory = ROOT) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) result.push(...await discoverTestFiles(absolute));
      continue;
    }
    if (!entry.name.endsWith(".test.mjs") || entry.name.endsWith(".e2e.test.mjs")) continue;
    result.push(path.relative(ROOT, absolute).split(path.sep).join("/"));
  }
  return result.toSorted();
}

function run(command, args, { cwd = ROOT, env, onChild } = {}) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env, ...(env ?? {}) };
    clearInheritedPublicationOwnership(childEnvironment);
    const identity = { requestedAt: new Date().toISOString() };
    const observe = () => { try { onChild?.({ ...identity }); } catch { /* Diagnostic only. */ } };
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      env: childEnvironment,
    });
    identity.pid = child.pid ?? null;
    observe();
    child.once("spawn", () => { identity.spawnedAt = new Date().toISOString(); observe(); });
    child.once("exit", (code, signal) => {
      Object.assign(identity, { exitedAt: new Date().toISOString(), code, signal });
      observe();
    });
    child.once("error", (error) => { identity.errorCode = error.code ?? null; observe(); reject(error); });
    child.once("close", (code, signal) => {
      Object.assign(identity, { closedAt: new Date().toISOString(), code, signal });
      observe();
      if (code === 0) resolve();
      else reject(new Error(`Тестовый этап завершён с ${signal ?? `кодом ${code}`}.`));
    });
  });
}

export async function testFingerprint(file, { cwd = ROOT, root = cwd, declaration, ...options } = {}) {
  return fingerprintTestInputs(file, { cwd, root, declaration, runnerFile: TEST_RUNNER_FILE, runnerInputs: RUNNER_INPUTS, ...options });
}

export async function runWindowsTestFile(file, {
  cwd = ROOT,
  isolation = true,
  execute = run,
  env,
} = {}) {
  const args = ["--test", "--test-concurrency=1", ...(isolation ? ["--test-isolation=none"] : []), file];
  return runIsolatedTestCommand(process.execPath, args, { cwd, execute, env });
}

function annotateTestFailure(failure, facts) {
  if (!failure || typeof failure !== "object") return;
  for (const [key, value] of Object.entries(facts)) {
    try {
      // Caller-owned fields, accessors and failed proxy inspection must never
      // change the original execution or cleanup outcome.
      if (!(key in failure)) Object.defineProperty(failure, key, {
        value, writable: true, configurable: true, enumerable: true,
      });
    } catch { /* Optional diagnostics cannot replace the original failure. */ }
  }
}

export async function runIsolatedTestCommand(command, args, { cwd = ROOT, execute = run, env } = {}) {
  // A failed assertion and an OS failure share exit code 1. Neither proves a
  // transient failure; retries require a new explicit run and reuse successes.
  // Keep the disposable owner short: deep Git refs in Windows fixtures still
  // have to fit below MAX_PATH when they create repositories under os.tmpdir().
  const childRoot = await mkdtemp(path.join(os.tmpdir(), "ah-"));
  let executionFailed = false;
  let executionError;
  let cleanupError;
  let childIdentity = null;
  try {
    await execute(command, args, {
      cwd,
      onChild: (identity) => {
        try {
          const facts = {};
          for (const key of ["pid", "requestedAt", "spawnedAt", "exitedAt", "closedAt", "code", "signal", "errorCode"]) {
            const value = identity?.[key];
            if (["string", "number"].includes(typeof value)) facts[key] = typeof value === "string" ? value.slice(0, 128) : value;
          }
          childIdentity = facts;
        } catch { /* Optional child observations cannot change execution. */ }
      },
      env: {
        ...env,
        LOCALAPPDATA: childRoot,
        APPDATA: childRoot,
        // USERPROFILE is Windows OS identity, not fixture state. Replacing it
        // breaks Edge's KnownFolder resolution even with a private browser
        // profile. HOME/application state and explicit fixture dirs are private.
        HOME: childRoot,
        XDG_CONFIG_HOME: childRoot,
        XDG_STATE_HOME: childRoot,
        XDG_CACHE_HOME: childRoot,
        TEMP: childRoot,
        TMP: childRoot,
        TMPDIR: childRoot,
      },
    });
  } catch (error) {
    executionFailed = true;
    executionError = error;
  }
  try {
    // Retry only removal of this owned root after native Windows handles retire.
    // Never replay the test; a persistent lock still preserves both failures.
    await rm(childRoot, { recursive: true, force: true,
      maxRetries: process.platform === "win32" ? 3 : 0, retryDelay: 100 });
  } catch (error) {
    cleanupError = error;
    // A known temporary root does not prove that every native handle closed.
    // Keep both original outcomes; cleanup never authorizes a test retry.
    annotateTestFailure(cleanupError, {
      testPhase: "cleanup", testRoot: childRoot, testExecutionSucceeded: !executionFailed,
    });
  }
  if (!executionFailed && !cleanupError) return;
  const failure = executionFailed && cleanupError
    ? new AggregateError([executionError, cleanupError],
      "Test execution and temporary-root cleanup failed", { cause: executionError })
    : executionFailed ? executionError : cleanupError;
  // The existing per-file reporter emits these facts immediately. The native
  // child close receipt does not certify unrelated Windows service handles.
  annotateTestFailure(failure, {
    testRoot: childRoot, testPhase: cleanupError ? "execution-and-cleanup" : "execution",
    testExecutionSucceeded: !executionFailed, testChild: childIdentity,
  });
  throw failure;
}

async function testManifest() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "tests/test-cache-inputs.json"), "utf8"));
  if (manifest.version !== 2 || !manifest.files || typeof manifest.files !== "object") {
    throw new Error("tests/test-cache-inputs.json must use version 2");
  }
  return manifest;
}

async function declaredFingerprint(file, cwd, manifest) {
  const key = path.relative(ROOT, path.resolve(cwd, file)).split(path.sep).join("/");
  const declaration = manifest.version === 2 ? manifest.files[key] ?? null : null;
  let browserFile = "";
  if (declaration?.browser) {
    if (process.platform === "win32") {
      browserFile = path.join(process.env["ProgramFiles(x86)"] || process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe");
    } else {
      const { chromium } = await import("playwright");
      browserFile = chromium.executablePath();
    }
  }
  return explainTestInputFingerprint(file, {
    cwd, root: ROOT, declaration, browserFile, runnerFile: TEST_RUNNER_FILE, runnerInputs: RUNNER_INPUTS,
  });
}

export function testExecutionPolicy(declaration) {
  // Cache proof and isolation have different owners. Each file gets a separate
  // process/temp root; only named, observed shared resources conflict.
  const shared = declaration?.execution?.shared ?? [];
  if (!Array.isArray(shared) || shared.some((value) => typeof value !== "string" || !/^[a-z0-9._-]+$/u.test(value))) {
    throw new Error("Invalid test shared-resource declaration");
  }
  return { parallel: true, shared: [...shared] };
}

export async function prepareTestDependencies({
  root = ROOT,
  execute = runTaskGitCommand,
} = {}) {
  const projectRoot = path.resolve(root);
  return prepareTaskWorktreeDependencies({
    projectRoot,
    lockfiles: [path.join(projectRoot, "package-lock.json")],
    lockPath: path.join(projectRoot, "WIP", "test-dependencies"),
    verify: false,
    runNpm: async (args, { cwd, lease, signal }) => {
      await lease.assertOwned();
      const environment = { ...process.env };
      clearInheritedPublicationOwnership(environment);
      // The shared process runner merges its environment over the parent.
      // Undefined entries explicitly remove inherited publication capabilities.
      const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, environment[key]]));
      const windows = process.platform === "win32";
      await execute(windows ? ["/d", "/s", "/c", "npm.cmd", ...args] : args, {
        cwd, signal, env,
        executable: windows ? process.env.ComSpec || "cmd.exe" : "npm",
        commandLabel: "npm",
        timeoutMs: 10 * 60_000,
      });
      await lease.assertOwned();
    },
  });
}

export async function runTestSuite(mode, {
  checkpointIdentity = String(process.env.AGENT_HUB_FULL_TEST_CHECKPOINT_ID ?? "").trim(),
  checkpoint = checkpointIdentity ? testFileCheckpointStore() : null,
  execute = run,
  discover = discoverTestFiles,
  testConcurrency = Infinity,
  createAdmission = execute === run ? testResourceAdmission : async () => null,
  prepareDependencies = prepareTestDependencies,
  report = (value) => console.log(`Test resource admission: ${JSON.stringify(value)}`),
  onFile = (value) => console.log(`Test file timing: ${JSON.stringify(value)}`),
} = {}) {
  const admission = await createAdmission();
  let operationError = null;
  try {
  if (mode === "all") {
    try {
      await runCheckpointedTestFiles(["locked-dependencies"], {
        suite: "dependencies", admission, onFile,
        fingerprint: async () => null, run: prepareDependencies,
      });
    } catch (error) {
      // Keep the existing dependency owner's error identity. No validation or
      // publication may start after a failed locked preparation.
      if (error instanceof AggregateError && error.errors.length === 1) throw error.errors[0];
      throw error;
    }
  }
  const allTestFiles = await discover();
  const architectureFiles = allTestFiles.filter((file) => file.startsWith("tests/composition/"));
  const unitFiles = allTestFiles.filter((file) => !file.startsWith("tests/composition/") && !VISUAL_FILES.includes(file));
  const suites = {
    architecture: { files: architectureFiles, cwd: ROOT, isolation: true },
    unit: { files: unitFiles, cwd: ROOT, isolation: true },
    visual: { files: [...VISUAL_FILES], cwd: ROOT, isolation: true },
    e2e: { files: E2E_FILES, cwd: ROOT, isolation: false },
    vscode: { files: VSCODE_FILES, cwd: path.join(ROOT, "VSCodeExtension"), isolation: false },
    cosmetic: {
      files: [...PROFILE_FILES.cosmetic], cwd: ROOT, isolation: true,
      env: { AGENT_HUB_TEST_PROFILES: "cosmetic" },
    },
    stress: {
      files: [...PROFILE_FILES.stress], cwd: ROOT, isolation: true,
      env: { AGENT_HUB_TEST_PROFILES: "stress" },
    },
    reliability: {
      files: [...PROFILE_FILES.reliability], cwd: ROOT, isolation: false,
      env: { AGENT_HUB_TEST_PROFILES: "reliability" },
    },
  };
  const selectedModes = mode === "all" ? ["architecture", "unit", "visual", "e2e", "vscode"] : [mode];
  const entries = new Map();
  for (const name of selectedModes) {
    const selected = suites[name];
    if (!selected) throw new Error(`Неизвестная группа тестов: ${name}.`);
    if (!selected.files.length) throw new Error(`Группа тестов ${name} пуста.`);
    for (const file of selected.files) {
      const key = path.relative(ROOT, path.resolve(selected.cwd, file)).split(path.sep).join("/");
      entries.set(key, { ...selected, file, suite: name });
    }
  }
  if (mode === "all") entries.set("install_test.py", { suite: "installer" });
  const manifest = await testManifest();
  const failures = [];
    if (mode === "all") {
      try {
        await runCheckpointedTestFiles(["syntax-check.mjs"], {
          suite: "syntax", identity: checkpointIdentity, checkpoint,
          fingerprint: async () => null, admission,
          onFile,
          run: () => execute(process.execPath, ["--no-warnings", "--experimental-vm-modules", "syntax-check.mjs"]),
        });
      } catch (error) { failures.push(error); }
    }
    try {
      await runCheckpointedTestFiles([...entries.keys()], {
        suite: mode,
        suiteForFile: (file) => entries.get(file).suite,
        identity: checkpointIdentity, checkpoint,
        fingerprint: (key) => {
          const entry = entries.get(key);
          return !checkpointIdentity || entry.suite === "installer" ? null
            : declaredFingerprint(entry.file, entry.cwd, manifest);
        },
        concurrency: testConcurrency,
        admission,
        onFile,
        execution: (key) => testExecutionPolicy(manifest.files[key]),
        run: (key) => {
          const entry = entries.get(key);
          return entry.suite === "installer" ? runIsolatedTestCommand(python, ["-m", "unittest", "install_test.py"], { execute })
            : runWindowsTestFile(entry.file, { ...entry, execute });
        },
      });
    } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, `Проверка ${mode} не пройдена:\n${failures.map((error) => error.message).join("\n\n")}`);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (admission) {
      try { report(await admission.close()); } catch (error) {
        if (operationError) throw new AggregateError([operationError, error], "Test execution and accounting closure failed");
        throw error;
      }
    }
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const mode = String(process.argv[2] ?? "unit").trim().toLowerCase();
  await runTestSuite(mode);
}

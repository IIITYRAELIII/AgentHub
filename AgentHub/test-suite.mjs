import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  explainTestInputFingerprint,
  fingerprintTestInputs,
  parallelTestExecution,
} from "./src/infrastructure/persistence/test-input-fingerprint.mjs";

import {
  runCheckpointedTestFiles,
  testFileCheckpointStore,
} from "./src/infrastructure/persistence/test-file-checkpoint.mjs";
import { clearInheritedPublicationOwnership } from "./src/infrastructure/process/publication-lock.mjs";
import { prepareTaskWorktreeDependencies } from "./src/infrastructure/filesystem/task-worktree-dependencies.mjs";
import { runTaskGitCommand } from "./src/infrastructure/filesystem/task-git-workspace.mjs";

const ROOT = import.meta.dirname;
const TEST_RUNNER_FILE = fileURLToPath(import.meta.url);
// WIP не содержит поставляемого кода. Без этого исключения случайный
// *.test.mjs во временных материалах молча попадал бы в группу unit.
export const IGNORED_DIRECTORIES = new Set(["node_modules", "build", "dist", ".wrangler", "WIP"]);
import { E2E_FILES, RELIABILITY_E2E_FILES, VSCODE_FILES, VISUAL_FILES, PROFILE_FILES } from "./src/domain/test-suite-groups.mjs";
export { E2E_FILES, RELIABILITY_E2E_FILES, VSCODE_FILES, VISUAL_FILES, PROFILE_FILES };
import { discoverReleaseTestInventory } from "./src/infrastructure/filesystem/release-test-inventory.mjs";
import { resolveTestSelection } from "./src/domain/test-selection.mjs";
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

function run(command, args, { cwd = ROOT, env } = {}) {
  return new Promise((resolve, reject) => {
    const childEnvironment = { ...process.env, ...(env ?? {}) };
    clearInheritedPublicationOwnership(childEnvironment);
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      windowsHide: true,
      env: childEnvironment,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Тестовый этап завершён с ${signal ?? `кодом ${code}`}.`));
    });
  });
}

export async function testFingerprint(file, { cwd = ROOT, root = cwd, declaration, ...options } = {}) {
  return fingerprintTestInputs(file, { cwd, root, declaration, runnerFile: TEST_RUNNER_FILE, ...options });
}

export async function runWindowsTestFile(file, {
  cwd = ROOT,
  isolation = true,
  execute = run,
  env,
} = {}) {
  const args = ["--test", "--test-concurrency=1", ...(isolation ? ["--test-isolation=none"] : []), file];
  // A failed assertion and an OS failure share exit code 1. Neither proves a
  // transient failure; retries require a new explicit run and reuse successes.
  // Keep the disposable owner short: deep Git refs in Windows fixtures still
  // have to fit below MAX_PATH when they create repositories under os.tmpdir().
  const childRoot = await mkdtemp(path.join(os.tmpdir(), "ah-"));
  try {
    await execute(process.execPath, args, {
      cwd,
      env: {
        ...env,
        LOCALAPPDATA: childRoot,
        TEMP: childRoot,
        TMP: childRoot,
        TMPDIR: childRoot,
      },
    });
  } finally {
    await rm(childRoot, { recursive: true, force: true });
  }
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
    cwd, root: ROOT, declaration, browserFile, runnerFile: TEST_RUNNER_FILE,
  });
}

export function boundedTestFileConcurrency({
  availableParallelism = os.availableParallelism(),
  freeMemory = os.freemem(),
} = {}) {
  return availableParallelism >= 4 && freeMemory >= 4 * 1024 ** 3 ? 2 : 1;
}

function executionPolicy(file, cwd, manifest) {
  const key = path.relative(ROOT, path.resolve(cwd, file)).split(path.sep).join("/");
  return parallelTestExecution(manifest.files[key]) ?? { parallel: false, shared: [] };
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
  testConcurrency = boundedTestFileConcurrency(),
  prepareDependencies = prepareTestDependencies,
  selection = null,
} = {}) {
  if (selection != null) return runSelectedTests(selection, { checkpointIdentity, checkpoint, execute, prepareDependencies, testConcurrency });
  const options = { checkpointIdentity, checkpoint, execute, discover, testConcurrency };
  if (mode === "all") {
    // Frozen generation clones contain tracked inputs, not node_modules.
    // The existing dependency owner installs once and reuses verified markers.
    await prepareDependencies();
    const failures = [];
    const stages = [
      ["syntax", () => runCheckpointedTestFiles(["syntax-check.mjs"], {
        suite: "syntax",
        identity: checkpointIdentity,
        checkpoint,
        // Cheap discovery/contract preflight is deliberately repeated.
        fingerprint: async () => null,
        run: () => execute(process.execPath, ["--no-warnings", "--experimental-vm-modules", "syntax-check.mjs"]),
      })],
      ["architecture", () => runTestSuite("architecture", options)],
      ["unit", () => runTestSuite("unit", options)],
      ["visual", () => runTestSuite("visual", options)],
      ["installer", () => runCheckpointedTestFiles(["install_test.py"], {
        suite: "installer",
        identity: checkpointIdentity,
        checkpoint,
        // Python and host installer state are not covered by a Node fingerprint.
        fingerprint: async () => null,
        run: () => execute(python, ["-m", "unittest", "install_test.py"]),
      })],
      ["e2e", () => runTestSuite("e2e", options)],
      ["vscode", () => runTestSuite("vscode", options)],
    ];
    for (const [stage, execute] of stages) {
      try {
        await execute();
      } catch (error) {
        failures.push({ stage, error });
      }
    }
    if (failures.length) {
      const summary = failures.map(({ stage, error }) => `${stage}: ${error.message}`).join("\n\n");
      throw new AggregateError(failures.map(({ error }) => error), `Полная проверка не пройдена:\n${summary}`);
    }
    return;
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
  const selected = suites[mode];
  if (!selected) throw new Error(`Неизвестная группа тестов: ${mode}.`);
  if (selected.files.length === 0) throw new Error(`Группа тестов ${mode} пуста.`);

  const manifest = await testManifest();
  if (checkpointIdentity) {
    await runCheckpointedTestFiles(selected.files, {
      suite: mode,
      identity: checkpointIdentity,
      checkpoint,
      fingerprint: (file) => declaredFingerprint(file, selected.cwd, manifest),
      concurrency: testConcurrency,
      execution: (file) => executionPolicy(file, selected.cwd, manifest),
      run: (file) => runWindowsTestFile(file, { ...selected, execute }),
    });
    return;
  }

  if (["visual", "cosmetic", "stress", "reliability"].includes(mode)
    || (process.platform === "win32" && ["architecture", "unit"].includes(mode))) {
    // Separate processes release SQLite and antivirus-observed temporary files
    // before the next test module starts. A single process can retain a Windows
    // file handle briefly even with test concurrency set to one.
    await runCheckpointedTestFiles(selected.files, {
      suite: mode,
      concurrency: testConcurrency,
      execution: (file) => executionPolicy(file, selected.cwd, manifest),
      run: (file) => runWindowsTestFile(file, { ...selected, execute }),
    });
    return;
  }

  const concurrency = mode === "e2e" ? "1" : "4";
  await execute(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...selected.files], selected);
}

export async function runSelectedTests(selection, {
  checkpointIdentity = "", checkpoint = null, execute = run, createAdmission = async () => null,
  prepareDependencies = prepareTestDependencies, report = console.log, onFile = console.log,
  testConcurrency = boundedTestFileConcurrency(), inventory = null,
} = {}) {
  const available = inventory ?? await discoverReleaseTestInventory(ROOT);
  const plan = resolveTestSelection(selection, available);
  const selected = available.filter(entry => plan.selectedIds.includes(entry.id));
  if (selected.some(entry => entry.suite === "release-check")) throw new Error("Release checks execute through the publication owner");
  // Selection is resolved before dependency preparation, accounting or children.
  report({ type: "test-selection", ...plan });
  for (const id of plan.notSelectedIds) onFile({ file: id, status: "not-selected" });
  if (!selected.length) return { plan, status: "not-selected" };
  await prepareDependencies();
  const manifest = await testManifest();
  const entries = new Map(selected.map(entry => [entry.id, { ...entry, cwd: path.join(ROOT, entry.directory ?? "") }]));
  const admission = await createAdmission();
  let failure;
  try {
    await runCheckpointedTestFiles([...entries.keys()], {
      suite: "selected", suiteForFile: id => entries.get(id).suite,
      identity: checkpointIdentity ? `${checkpointIdentity}:selection:${plan.identitySha256}` : "", checkpoint,
      concurrency: testConcurrency, admission, onFile,
      execution: id => executionPolicy(entries.get(id).file, entries.get(id).cwd, manifest),
      fingerprint: id => {
        const entry = entries.get(id);
        return !checkpointIdentity || ["syntax", "installer"].includes(entry.suite) ? null : declaredFingerprint(entry.file, entry.cwd, manifest);
      },
      run: id => {
        const entry = entries.get(id);
        if (entry.suite === "syntax") return execute(process.execPath, ["--no-warnings", "--experimental-vm-modules", "syntax-check.mjs"]);
        if (entry.suite === "installer") return execute(python, ["-m", "unittest", "install_test.py"]);
        return runWindowsTestFile(entry.file, { ...entry, execute });
      },
    });
    return { plan, status: "completed" };
  } catch (error) { failure = error; throw error; }
  finally {
    if (admission) try { report(await admission.close()); } catch (error) {
      if (failure) throw new AggregateError([failure, error], "Test execution and accounting closure failed");
      throw error;
    }
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const mode = String(process.argv[2] ?? "unit").trim().toLowerCase();
  if (mode.startsWith("--plan-tests=")) console.log(JSON.stringify(resolveTestSelection(JSON.parse(process.argv[2].slice(13)), await discoverReleaseTestInventory(ROOT)), null, 2));
  else if (mode === "--list-tests") console.log(JSON.stringify(await discoverReleaseTestInventory(ROOT), null, 2));
  else {
    const selectionArgument = process.argv.slice(2).find(arg => arg.startsWith("--selection="));
    await runTestSuite(selectionArgument ? "selected" : mode, { selection: selectionArgument ? JSON.parse(selectionArgument.slice(12)) : null });
  }
}

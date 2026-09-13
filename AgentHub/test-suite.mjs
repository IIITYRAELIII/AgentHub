import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintTestInputs } from "./src/infrastructure/persistence/test-input-fingerprint.mjs";

import {
  runCheckpointedTestFiles,
  testFileCheckpointStore,
} from "./src/infrastructure/persistence/test-file-checkpoint.mjs";
import { clearInheritedPublicationOwnership } from "./src/infrastructure/process/publication-lock.mjs";

const ROOT = import.meta.dirname;
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
  await execute(process.execPath, args, { cwd, env });
}

async function declaredFingerprint(file, cwd) {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "tests/test-cache-inputs.json"), "utf8"));
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
  return testFingerprint(file, { cwd, root: ROOT, declaration, browserFile });
}

export async function runTestSuite(mode, {
  checkpointIdentity = String(process.env.AGENT_HUB_FULL_TEST_CHECKPOINT_ID ?? "").trim(),
  checkpoint = checkpointIdentity ? testFileCheckpointStore() : null,
  execute = run,
  discover = discoverTestFiles,
} = {}) {
  const options = { checkpointIdentity, checkpoint, execute, discover };
  if (mode === "all") {
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

  if (checkpointIdentity) {
    await runCheckpointedTestFiles(selected.files, {
      suite: mode,
      identity: checkpointIdentity,
      checkpoint,
      fingerprint: (file) => declaredFingerprint(file, selected.cwd),
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
      run: (file) => runWindowsTestFile(file, { ...selected, execute }),
    });
    return;
  }

  const concurrency = mode === "e2e" ? "1" : "4";
  await execute(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...selected.files], selected);
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const mode = String(process.argv[2] ?? "unit").trim().toLowerCase();
  await runTestSuite(mode);
}

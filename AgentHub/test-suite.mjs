import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runCheckpointedTestFiles,
  testFileCheckpointStore,
} from "./src/infrastructure/persistence/test-file-checkpoint.mjs";

const ROOT = import.meta.dirname;
const IGNORED_DIRECTORIES = new Set(["node_modules", "build", "dist", ".wrangler"]);
const E2E_FILES = [
  "tests/e2e/agent-hub-server.e2e.test.mjs",
  "tests/e2e/agent-hub-server.claude.e2e.test.mjs",
  "tests/e2e/agent-hub-server.local-control.e2e.test.mjs",
  "tests/e2e/agent-hub-server.journal.e2e.test.mjs",
];
const VSCODE_FILES = [
  "render.test.js",
  "agent-hub-bridge.test.js",
  "runtime-reload-policy.test.js",
  "activity-bar-launch.test.js",
];
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

function run(command, args, { cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Тестовый этап завершён с ${signal ?? `кодом ${code}`}.`));
    });
  });
}

async function testFingerprint(file, { cwd, sourceFingerprint = "" } = {}) {
  const visited = new Set();
  const hash = createHash("sha256").update(`runner-v2\0${sourceFingerprint}\0`);
  async function visit(absolute) {
    const normalized = path.resolve(absolute);
    if (visited.has(normalized)) return false;
    visited.add(normalized);
    let source;
    try {
      source = await readFile(normalized);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    hash.update(normalized).update("\0").update(source).update("\0");
    const text = source.toString("utf8");
    const imports = text.matchAll(/(?:from\s*|import\s*\(|require\s*\()\s*["'](\.{1,2}\/[^"']+)["']/gu);
    for (const match of imports) {
      const base = path.resolve(path.dirname(normalized), match[1]);
      const candidates = path.extname(base)
        ? [base]
        : [`${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, "index.mjs")];
      for (const candidate of candidates) {
        if (await visit(candidate)) break;
      }
    }
    return true;
  }
  await visit(path.resolve(cwd, file));
  return hash.digest("hex");
}

async function runWindowsTestFile(file, {
  cwd = ROOT,
  isolation = true,
  maxAttempts = 1,
} = {}) {
  const args = ["--test", "--test-concurrency=1", ...(isolation ? ["--test-isolation=none"] : []), file];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await run(process.execPath, args, { cwd });
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      console.warn(
        `Повтор Windows test-file после временного файлового сбоя (${attempt}/${maxAttempts - 1}): ${file}`,
      );
    }
  }
}

export async function runTestSuite(mode, {
  checkpointIdentity = String(process.env.AGENT_HUB_FULL_TEST_CHECKPOINT_ID ?? "").trim(),
  checkpoint = checkpointIdentity ? testFileCheckpointStore() : null,
  sourceFingerprint = String(process.env.AGENT_HUB_FULL_TEST_SOURCE_FINGERPRINT ?? "").trim(),
} = {}) {
  if (mode === "all") {
    const failures = [];
    const stages = [
      ["syntax", () => runCheckpointedTestFiles(["syntax-check.mjs"], {
        suite: "syntax",
        identity: checkpointIdentity,
        checkpoint,
        fingerprint: (file) => testFingerprint(file, { cwd: ROOT, sourceFingerprint }),
        run: () => run(process.execPath, ["--no-warnings", "--experimental-vm-modules", "syntax-check.mjs"]),
      })],
      ["architecture", () => runTestSuite("architecture", { checkpointIdentity, checkpoint, sourceFingerprint })],
      ["unit", () => runTestSuite("unit", { checkpointIdentity, checkpoint, sourceFingerprint })],
      ["installer", () => runCheckpointedTestFiles(["install_test.py"], {
        suite: "installer",
        identity: checkpointIdentity,
        checkpoint,
        fingerprint: async (file) => {
          const hash = createHash("sha256").update(sourceFingerprint);
          for (const dependency of [file, "install.py"]) hash.update(await readFile(path.join(ROOT, dependency)));
          return hash.digest("hex");
        },
        run: () => run(python, ["-m", "unittest", "install_test.py"]),
      })],
      ["e2e", () => runTestSuite("e2e", { checkpointIdentity, checkpoint, sourceFingerprint })],
      ["vscode", () => runTestSuite("vscode", { checkpointIdentity, checkpoint, sourceFingerprint })],
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
    if (checkpointIdentity) await checkpoint.clear();
    return;
  }
  const allTestFiles = await discoverTestFiles();
  const architectureFiles = allTestFiles.filter((file) => file.startsWith("tests/composition/"));
  const unitFiles = allTestFiles.filter((file) => !file.startsWith("tests/composition/"));
  const suites = {
    architecture: { files: architectureFiles, cwd: ROOT, isolation: true, maxAttempts: 4 },
    unit: { files: unitFiles, cwd: ROOT, isolation: true, maxAttempts: 4 },
    e2e: { files: E2E_FILES, cwd: ROOT, isolation: false },
    vscode: { files: VSCODE_FILES, cwd: path.join(ROOT, "VSCodeExtension"), isolation: false },
  };
  const selected = suites[mode];
  if (!selected) throw new Error(`Неизвестная группа тестов: ${mode}.`);
  if (selected.files.length === 0) throw new Error(`Группа тестов ${mode} пуста.`);

  if (checkpointIdentity) {
    await runCheckpointedTestFiles(selected.files, {
      suite: mode,
      identity: checkpointIdentity,
      checkpoint,
      fingerprint: (file) => testFingerprint(file, {
        cwd: selected.cwd,
        sourceFingerprint,
      }),
      run: (file) => runWindowsTestFile(file, selected),
    });
    return;
  }

  if (process.platform === "win32" && ["architecture", "unit"].includes(mode)) {
    // Separate processes release SQLite and antivirus-observed temporary files
    // before the next test module starts. A single process can retain a Windows
    // file handle briefly even with test concurrency set to one.
    await runCheckpointedTestFiles(selected.files, {
      suite: mode,
      run: (file) => runWindowsTestFile(file, selected),
    });
    return;
  }

  const concurrency = mode === "e2e" ? "1" : "4";
  await run(process.execPath, ["--test", `--test-concurrency=${concurrency}`, ...selected.files], selected);
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  const mode = String(process.argv[2] ?? "unit").trim().toLowerCase();
  await runTestSuite(mode);
}

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

const ROOT = import.meta.dirname;
const mode = String(process.argv[2] ?? "unit").trim().toLowerCase();
const IGNORED_DIRECTORIES = new Set(["node_modules", "build", "dist", ".wrangler"]);

async function discoverTestFiles(directory = ROOT) {
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

const allTestFiles = await discoverTestFiles();
const architectureFiles = allTestFiles.filter((file) => file.startsWith("tests/composition/"));
const unitFiles = allTestFiles.filter((file) => !file.startsWith("tests/composition/"));
const selectedFiles = mode === "architecture" ? architectureFiles : unitFiles;
if (!["architecture", "unit"].includes(mode)) throw new Error(`Неизвестная группа тестов: ${mode}.`);
if (selectedFiles.length === 0) throw new Error(`Группа тестов ${mode} пуста.`);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Тестовый этап завершён с ${signal ?? `кодом ${code}`}.`));
    });
  });
}

async function runWindowsTestFile(file) {
  const args = ["--test", "--test-concurrency=1", "--test-isolation=none", file];
  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await run(process.execPath, args);
      return;
    } catch (error) {
      if (attempt === maxAttempts) throw error;
      console.warn(
        `Повтор Windows test-file после временного файлового сбоя (${attempt}/${maxAttempts - 1}): ${file}`,
      );
    }
  }
}

if (process.platform === "win32") {
  // Separate processes release SQLite and antivirus-observed temporary files
  // before the next test module starts. A single process can retain a Windows
  // file handle briefly even with test concurrency set to one.
  for (const file of selectedFiles) {
    await runWindowsTestFile(file);
  }
} else {
  await run(process.execPath, ["--test", "--test-concurrency=4", ...selectedFiles]);
}

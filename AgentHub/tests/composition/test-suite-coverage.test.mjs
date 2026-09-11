import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  discoverTestFiles,
  E2E_FILES,
  IGNORED_DIRECTORIES,
  PROFILE_FILES,
  RELIABILITY_E2E_FILES,
  VISUAL_FILES,
  VSCODE_FILES,
} from "../../test-suite.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const REGISTRY_FILE = path.join(ROOT, "tests/unreachable-tests.json");

async function everyTestFileOnDisk(directory = ROOT) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) result.push(...await everyTestFileOnDisk(absolute));
      continue;
    }
    if (!/\.test\.(mjs|js)$/u.test(entry.name)) continue;
    result.push(path.relative(ROOT, absolute).split(path.sep).join("/"));
  }
  return result.toSorted();
}

async function vscodePackageTestFiles() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "VSCodeExtension/package.json"), "utf8"));
  const script = String(manifest.scripts?.test ?? "");
  return script.split(/\s+/u)
    .filter((token) => /\.test\.(mjs|js)$/u.test(token))
    .map((token) => `VSCodeExtension/${token}`);
}

async function registry() {
  const parsed = JSON.parse(await readFile(REGISTRY_FILE, "utf8"));
  const entries = [
    ...(parsed.externalEntrypoints ?? []),
    ...(parsed.notInDefaultRun ?? []),
    ...(parsed.unreachable ?? []),
  ];
  return { parsed, entries };
}

test("каждый тестовый файл на диске достижим группой раннера или объявлен в реестре", async () => {
  const [onDisk, discovered, fromVscodePackage, { entries }] = await Promise.all([
    everyTestFileOnDisk(),
    discoverTestFiles(),
    vscodePackageTestFiles(),
    registry(),
  ]);

  const reachable = new Set([
    ...discovered,
    ...E2E_FILES,
    ...RELIABILITY_E2E_FILES,
    ...VISUAL_FILES,
    ...Object.values(PROFILE_FILES).flat(),
    ...VSCODE_FILES.map((file) => `VSCodeExtension/${file}`),
    ...fromVscodePackage,
  ]);
  const declared = new Set(entries.map((entry) => entry.file));

  const orphans = onDisk.filter((file) => !reachable.has(file) && !declared.has(file));
  assert.deepEqual(orphans, [], "Ни один тестовый файл не должен быть недостижим молча. "
    + `Внесите его в группу test-suite.mjs или в ${path.basename(REGISTRY_FILE)} с причиной и владельцем: `
    + orphans.join(", "));
});

test("реестр исключений не устаревает: каждая запись ссылается на существующий файл и объясняет себя", async () => {
  const { entries } = await registry();
  // Реестр вправе ссылаться и на Python-тесты, поэтому существование
  // проверяется файловой системой, а не перечнем Node-тестов.
  const exists = await Promise.all(entries.map((entry) => stat(path.join(ROOT, entry.file)).then(
    (info) => info.isFile(),
    () => false,
  )));
  for (const [index, entry] of entries.entries()) {
    assert.ok(exists[index], `Реестр ссылается на отсутствующий файл: ${entry.file}`);
    assert.ok(String(entry.reason ?? "").trim().length >= 20, `Запись реестра без внятной причины: ${entry.file}`);
    assert.ok(String(entry.owner ?? entry.entrypoint ?? "").trim(), `Запись реестра без владельца: ${entry.file}`);
  }
  const files = entries.map((entry) => entry.file);
  assert.deepEqual(files, [...new Set(files)], "Файл не должен встречаться в реестре дважды.");
});

test("списки групп раннера ссылаются только на существующие файлы", async () => {
  const onDisk = new Set(await everyTestFileOnDisk());
  for (const file of [...E2E_FILES, ...RELIABILITY_E2E_FILES, ...VISUAL_FILES, ...Object.values(PROFILE_FILES).flat()]) {
    assert.ok(onDisk.has(file), `Группа раннера ссылается на отсутствующий файл: ${file}`);
  }
  for (const file of VSCODE_FILES) {
    assert.ok(onDisk.has(`VSCodeExtension/${file}`), `VSCODE_FILES ссылается на отсутствующий файл: ${file}`);
  }
});

test("WIP исключён из discovery, поэтому случайный временный тест не попадёт в unit", async () => {
  assert.ok(IGNORED_DIRECTORIES.has("WIP"));
  const discovered = await discoverTestFiles();
  assert.deepEqual(discovered.filter((file) => file.split("/").includes("WIP")), []);
});

test("файл под профилем объявлен ровно одним профилем", () => {
  const seen = new Map();
  for (const [profile, files] of Object.entries(PROFILE_FILES)) {
    for (const file of files) {
      const previous = seen.get(file);
      assert.equal(previous, undefined,
        `${file} объявлен и профилем ${previous}, и профилем ${profile}.`);
      seen.set(file, profile);
    }
  }
});

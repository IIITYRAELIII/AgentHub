import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  SharedSqliteRecoveryCoordinator,
  SQLITE_RECOVERY_RESTART_REQUIRED,
  writeAtomicJson,
} from "../../../src/infrastructure/persistence/shared-sqlite-recovery.mjs";

async function fixture(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const databaseFile = path.join(root, "journal.sqlite");
  await fs.writeFile(databaseFile, "not a sqlite database", "utf8");
  return { root, databaseFile };
}

function coordinator(databaseFile, overrides = {}) {
  return new SharedSqliteRecoveryCoordinator({
    databaseFile,
    instanceId: "instance-a",
    now: () => new Date("2026-08-14T01:02:03.000Z"),
    idFactory: (() => {
      let value = 0;
      return () => `recovery-${value += 1}`;
    })(),
    ...overrides,
  });
}

test("partial quarantine rename rolls every moved SQLite file back", async () => {
  const { root, databaseFile } = await fixture("sqlite-recovery-partial");
  const walFile = `${databaseFile}-wal`;
  await fs.writeFile(walFile, "wal", "utf8");
  const fileSystem = {
    ...fs,
    rename: async (source, destination) => {
      if (source === walFile && destination.includes(".quarantine-")) {
        const error = new Error("rename fault");
        error.code = "EIO";
        throw error;
      }
      return fs.rename(source, destination);
    },
  };
  try {
    await assert.rejects(coordinator(databaseFile, { fileSystem }).prepare(), /rename fault/u);
    assert.equal(await fs.readFile(databaseFile, "utf8"), "not a sqlite database");
    assert.equal(await fs.readFile(walFile, "utf8"), "wal");
    await assert.rejects(fs.stat(`${databaseFile}.recovery-marker.json`), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("evidence write failure restores DB, WAL and SHM", async () => {
  const { root, databaseFile } = await fixture("sqlite-recovery-evidence");
  await fs.writeFile(`${databaseFile}-wal`, "wal", "utf8");
  await fs.writeFile(`${databaseFile}-shm`, "shm", "utf8");
  const writeJson = async (file, value, fileSystem) => {
    if (path.basename(file) === "evidence.json") throw new Error("evidence fault");
    return writeAtomicJson(file, value, fileSystem);
  };
  try {
    await assert.rejects(coordinator(databaseFile, { writeJson }).prepare(), /evidence fault/u);
    assert.equal(await fs.readFile(databaseFile, "utf8"), "not a sqlite database");
    assert.equal(await fs.readFile(`${databaseFile}-wal`, "utf8"), "wal");
    assert.equal(await fs.readFile(`${databaseFile}-shm`, "utf8"), "shm");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recovery lock rejects a concurrent coordinator", async () => {
  const { root, databaseFile } = await fixture("sqlite-recovery-concurrent");
  let releaseRename;
  let renameStarted;
  const gate = new Promise((resolve) => { releaseRename = resolve; });
  const started = new Promise((resolve) => { renameStarted = resolve; });
  const fileSystem = {
    ...fs,
    rename: async (source, destination) => {
      if (source === databaseFile && destination.includes(".quarantine-")) {
        renameStarted();
        await gate;
      }
      return fs.rename(source, destination);
    },
  };
  const withoutDatabaseLock = (operation) => operation();
  try {
    const first = coordinator(databaseFile, { fileSystem, withDatabaseLock: withoutDatabaseLock }).prepare();
    await started;
    await assert.rejects(
      coordinator(databaseFile, { withDatabaseLock: withoutDatabaseLock }).prepare(),
      (error) => error?.code === "SQLITE_RECOVERY_LOCKED",
    );
    releaseRename();
    await assert.rejects(first, (error) => error?.code === SQLITE_RECOVERY_RESTART_REQUIRED);
  } finally {
    releaseRename?.();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a new instance creates one replacement from the committed marker", async () => {
  const { root, databaseFile } = await fixture("sqlite-recovery-restart");
  const first = coordinator(databaseFile);
  try {
    await assert.rejects(first.prepare(), (error) => error?.code === SQLITE_RECOVERY_RESTART_REQUIRED);
    await assert.rejects(fs.stat(databaseFile), { code: "ENOENT" });
    await assert.rejects(first.prepare(), (error) => error?.code === SQLITE_RECOVERY_RESTART_REQUIRED);

    const next = coordinator(databaseFile, { instanceId: "instance-b" });
    const recovery = await next.prepare();
    assert.equal(recovery.degraded, true);
    const database = new DatabaseSync(databaseFile, { readOnly: true });
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    database.close();
    await assert.rejects(fs.stat(`${databaseFile}.recovery-replacement.tmp`), { code: "ENOENT" });
    assert.equal(await next.acknowledge(recovery), true);
    await assert.rejects(fs.stat(next.markerFile), { code: "ENOENT" });
    assert.ok((await fs.stat(recovery.evidenceFile)).isFile());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

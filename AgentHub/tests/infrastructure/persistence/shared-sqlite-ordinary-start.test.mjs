import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SharedSqliteRecoveryCoordinator } from "../../../src/infrastructure/persistence/shared-sqlite-recovery.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { measureStartupBeforeTrace } from "../../../src/composition/command-trace-composition.mjs";

test("ordinary existing DB/WAL starts without inspection, copying or replacement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-ordinary-sqlite-"));
  const file = path.join(root, "journal.sqlite");
  const database = new DatabaseSync(file);
  t.after(async () => {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample(id); PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO sample VALUES(42)");
  const names = [file, `${file}-wal`, `${file}-shm`];
  const before = await Promise.all(names.map(name => fs.readFile(name)));
  const unexpected = () => { throw new Error("ordinary start attempted inspection or replacement"); };
  const logs = [];
  const coordinator = new SharedSqliteRecoveryCoordinator({ databaseFile: file,
    fileSystem: { ...fs, copyFile: unexpected }, inspectFile: unexpected, databaseFactory: unexpected });
  const measured = await measureStartupBeforeTrace("sqlite-recovery",
    recordPhase => coordinator.prepare({ recordPhase }), {
      providePhaseRecorder: true, logger: { info: (_prefix, body) => logs.push(JSON.parse(body)) },
    });
  assert.deepEqual(measured.value, { degraded: false });
  assert.deepEqual(await Promise.all(names.map(name => fs.readFile(name))), before);
  assert.deepEqual((await fs.readdir(root)).sort(), names.map(name => path.basename(name)).sort());
  assert.equal(database.prepare("SELECT id FROM sample").get().id, 42);
  assert.equal(logs.some(p => /copy|inspection|database-check|quarantine/u.test(p.phase ?? "")), false);
  assert.equal(new Set(logs.map(p => p.operationSpanId)).size, 1);
  assert.equal(logs.at(-1).outcome, "succeeded");
  t.diagnostic(JSON.stringify({ operationSpanId: logs[0].operationSpanId,
    durationMs: logs.at(-1).durationMs, qualification: "tiny isolated DB/WAL, not production startup timing" }));
});

test("ordinary corrupt DB remains in place and the real storage open error surfaces", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-ordinary-open-error-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.sqlite");
  const original = Buffer.from("not a sqlite database");
  await fs.writeFile(file, original);
  assert.deepEqual(await new SharedSqliteRecoveryCoordinator({ databaseFile: file }).prepare(), { degraded: false });
  const store = new WorkspaceCatalogStore({ databaseFile: file });
  try { await assert.rejects(store.load(), /not a database/u); }
  finally { store.close(); }
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await fs.readdir(root), ["journal.sqlite"]);
});

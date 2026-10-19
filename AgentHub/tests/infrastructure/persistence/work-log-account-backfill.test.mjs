import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { UsageSyncAutoService } from "../../../src/application/usage-sync-auto-service.mjs";
import { deleteVerifiedWindowsEntry } from "../../../src/infrastructure/persistence/windows-delete-verified-entry.mjs";

import { JournalDatabase } from "../../../src/infrastructure/persistence/journal-database.mjs";
import { RateLimitHistoryStore } from "../../../src/infrastructure/persistence/rate-limit-history.mjs";
import { applyWorkLogAccountBackfill } from "../../../src/infrastructure/persistence/work-log-account-backfill.mjs";
import {
  ensureWorkLogAccountBackupReceipts,
  setWorkLogAccountBackupHold,
  startWorkLogAccountBackup,
} from "../../../src/infrastructure/persistence/work-log-account-backup-retention.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-work-log-account-backfill-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const limits = new RateLimitHistoryStore({
    databaseFile,
    rawFile: path.join(directory, "rate-limits-raw.jsonl"),
    csvFile: path.join(directory, "rate-limits.csv"),
  });
  try {
    await journal.replaceLedger({
      version: 8,
      turns: {
        "codex\0thread-a\0turn-1": {
          provider: "codex",
          threadId: "thread-a",
          turnId: "turn-1",
          completedAt: "2026-08-01T00:05:00.000Z",
          status: "completed",
        },
        "codex\0thread-a\0turn-2": {
          provider: "codex",
          threadId: "thread-a",
          turnId: "turn-2",
          completedAt: "2026-08-01T01:05:00.000Z",
          status: "completed",
          accountKey: "chatgpt:exact",
          accountAttribution: "exact",
        },
        "claude\0thread-b\0turn-1": {
          provider: "claude",
          threadId: "thread-b",
          turnId: "turn-1",
          completedAt: "2026-08-01T00:10:00.000Z",
          status: "completed",
        },
      },
    });
    await limits.recordAccountEvent(
      { type: "chatgpt", email: "owner@example.com", planType: "plus" },
      "2026-08-01T00:00:00.000Z",
      "test",
    );
  } finally {
    await limits.close();
    journal.close();
  }
  return { directory, databaseFile };
}

function records(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return Object.fromEntries(database.prepare(`
      SELECT provider || char(0) || thread_id || char(0) || turn_id AS key, record_json
      FROM journal_records ORDER BY provider, thread_id, turn_id
    `).all().map((row) => [row.key, JSON.parse(row.record_json)]));
  } finally {
    database.close();
  }
}

test("work-log account backfill infers Codex account from rate-limit account timeline", async () => {
  const state = await fixture();
  try {
    const result = await applyWorkLogAccountBackfill({
      databaseFile: state.databaseFile,
      backupRoot: path.join(state.directory, "migrations"),
      now: new Date("2026-08-01T02:00:00.000Z"),
    });
    assert.equal(result.applied, true);
    assert.equal(result.updated, 2);
    assert.equal(result.inferredAssigned, 1);
    assert.equal(result.exactPreserved, 1);
    const after = records(state.databaseFile);
    assert.match(after["codex\0thread-a\0turn-1"].accountKey, /^chatgpt:/u);
    assert.equal(after["codex\0thread-a\0turn-1"].accountAttribution, "inferred");
    assert.equal(after["codex\0thread-a\0turn-1"].observedAt, "2026-08-01T02:00:00.000Z");
    assert.equal(after["codex\0thread-a\0turn-2"].accountKey, "chatgpt:exact");
    assert.equal(after["codex\0thread-a\0turn-2"].accountAttribution, "exact");
    assert.notEqual(after["codex\0thread-a\0turn-2"].observedAt, "2026-08-01T02:00:00.000Z");
    assert.equal(after["claude\0thread-b\0turn-1"].accountKey, "");
    assert.equal(after["claude\0thread-b\0turn-1"].accountAttribution, "inferred");
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("work-log account backfill attaches the current Claude account when available", async () => {
  const state = await fixture();
  try {
    const result = await applyWorkLogAccountBackfill({
      databaseFile: state.databaseFile,
      backupRoot: path.join(state.directory, "migrations"),
      providerAccounts: [{
        provider: "claude",
        key: "anthropic:account-1",
        label: "owner@anthropic.example",
        type: "oauth",
        planType: "pro",
      }],
      now: new Date("2026-08-01T02:00:00.000Z"),
    });

    assert.equal(result.applied, true);
    assert.equal(result.inferredAssigned, 2);
    const after = records(state.databaseFile);
    assert.equal(after["claude\0thread-b\0turn-1"].accountKey, "anthropic:account-1");
    assert.equal(after["claude\0thread-b\0turn-1"].accountLabel, "owner@anthropic.example");
    assert.equal(after["claude\0thread-b\0turn-1"].accountType, "oauth");
    assert.equal(after["claude\0thread-b\0turn-1"].accountPlan, "pro");
    assert.equal(after["claude\0thread-b\0turn-1"].accountAttribution, "inferred");
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function backupRows(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    return database.prepare("SELECT * FROM work_log_account_backup_receipts ORDER BY created_at_ms, id").all();
  } finally {
    database.close();
  }
}

async function rotate(state, index, options = {}) {
  return applyWorkLogAccountBackfill({
    databaseFile: state.databaseFile,
    backupRoot: path.join(state.directory, "migrations"),
    providerAccounts: [{ provider: "claude", key: `anthropic:account-${index}` }],
    now: new Date(Date.UTC(2026, 7, 1, index, 0, 0)),
    ...options,
  });
}

test("account backups retain three restorable committed copies, held copies, and unknown legacy files", async () => {
  const state = await fixture();
  const root = path.join(state.directory, "migrations");
  try {
    await mkdir(path.join(root, "work-log-account-unknown-legacy"), { recursive: true });
    await writeFile(path.join(root, "work-log-account-unknown-legacy", "journal.sqlite"), "unknown");
    for (let index = 2; index <= 4; index += 1) {
      assert.equal((await rotate(state, index)).applied, true);
    }
    const first = backupRows(state.databaseFile)[0];
    await setWorkLogAccountBackupHold({ databaseFile: state.databaseFile, backupId: first.id, reason: "audit" });
    assert.equal((await rotate(state, 5)).retention.deleted, 0);
    assert.equal((await rotate(state, 6)).retention.deleted, 1);
    assert.equal(backupRows(state.databaseFile).filter((row) => row.state === "committed").length, 4);
    assert.equal(await readFile(path.join(root, "work-log-account-unknown-legacy", "journal.sqlite"), "utf8"), "unknown");
    for (const row of backupRows(state.databaseFile).filter((item) => item.state === "committed")) {
      const backup = new DatabaseSync(path.join(root, row.directory_name, row.file_name), { readOnly: true });
      try {
        assert.equal(backup.prepare("PRAGMA quick_check").get().quick_check, "ok");
        const snapshot = backup.prepare(`SELECT record_json FROM journal_records
          WHERE provider='claude' AND thread_id='thread-b' AND turn_id='turn-1'`).get();
        assert.notEqual(JSON.parse(snapshot.record_json).accountKey,
          `anthropic:account-${new Date(Number(row.created_at_ms)).getUTCHours()}`);
      }
      finally { backup.close(); }
    }
    await setWorkLogAccountBackupHold({ databaseFile: state.databaseFile, backupId: first.id });
    assert.equal((await rotate(state, 7)).retention.deleted, 2);
    assert.equal(backupRows(state.databaseFile).filter((row) => row.state === "committed").length, 3);
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("failed backup and failed update never create a prunable success receipt", async () => {
  const state = await fixture();
  try {
    const blockedRoot = path.join(state.directory, "not-a-directory");
    await writeFile(blockedRoot, "blocked");
    await assert.rejects(rotate(state, 2, { backupRoot: blockedRoot }));
    assert.equal(backupRows(state.databaseFile)[0].state, "failed");

    const database = new DatabaseSync(state.databaseFile);
    database.exec(`CREATE TRIGGER reject_backfill BEFORE UPDATE ON journal_records
      BEGIN SELECT RAISE(ABORT, 'test update failure'); END`);
    database.close();
    await assert.rejects(rotate(state, 3), /test update failure/u);
    assert.deepEqual(backupRows(state.databaseFile).map((row) => row.state), ["failed", "failed"]);
    const retry = new DatabaseSync(state.databaseFile);
    retry.exec("DROP TRIGGER reject_backfill");
    retry.close();
    assert.equal((await rotate(state, 4)).applied, true);
    assert.deepEqual(backupRows(state.databaseFile).map((row) => row.state),
      ["failed", "failed", "committed"]);
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a crash-left pending receipt remains held after restart and later rotations", async () => {
  const state = await fixture();
  try {
    const database = new DatabaseSync(state.databaseFile);
    ensureWorkLogAccountBackupReceipts(database);
    const pending = startWorkLogAccountBackup(database, {
      now: new Date("2026-08-01T01:00:00.000Z"), fileName: "journal.sqlite",
    });
    database.close();
    for (let index = 2; index <= 5; index += 1) await rotate(state, index);
    const rows = backupRows(state.databaseFile);
    assert.equal(rows.find((row) => row.id === pending.id).state, "pending");
    assert.equal(rows.filter((row) => row.state === "committed").length, 3);
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("prune failure after commit stays visible and restart resumes exact receipt", async () => {
  const state = await fixture();
  try {
    for (let index = 2; index <= 4; index += 1) await rotate(state, index);
    const failed = await rotate(state, 5, {
      retentionDeleteEntry: async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); },
    });
    assert.equal(failed.applied, true);
    assert.equal(failed.retention.errors, 1);
    assert.equal(backupRows(state.databaseFile)[0].state, "pruning");
    const resumed = await rotate(state, 5);
    assert.equal(resumed.applied, false);
    assert.equal(resumed.retention.deleted, 1);
    assert.equal(backupRows(state.databaseFile)[0].state, "pruned", JSON.stringify(resumed.retention));
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("auto-sync never enters legacy retention backlog", async () => {
  const state = await fixture();
  try {
    for (let index = 2; index <= 4; index += 1) await rotate(state, index);
    for (let index = 5; index <= 18; index += 1) {
      await rotate(state, index, {
        retentionDeleteEntry: async () => { throw new Error("helper unavailable"); },
      });
    }
    const attempts = [];
    const events = [];
    let clock = 0;
    const service = new UsageSyncAutoService({
      timers: { schedule: () => events.push("scheduled") },
      remoteConfigStore: {
        load: async () => ({ serverUrl: "https://sync.example.test", enrolledAt: "2026-08-01T00:00:00Z",
          lastUsageHistoryResendVersion: 1, lastUsageAntiEntropyAt: "2026-08-20T04:00:00Z" }),
        rememberPush: async () => {},
        rememberPull: async () => {},
      },
      identityStore: { deviceId: "test-device", label: "test-device" },
      workLogUsageStore: {
        usageSyncState: async () => ({}),
        usageSyncSnapshot: async () => ({ journalRevision: 1, events: [] }),
      },
      clientFactory: () => ({
        push: async () => { events.push("push"); return { ok: true, added: 0, rejected: 0 }; },
        pull: async () => ({ serverRevision: 1, events: [] }),
      }),
      accountBackfill: () => rotate(state, 18, {
        retentionPruneClock: () => clock,
        retentionDeleteEntry: async (target) => {
          attempts.push(target);
          clock += 21_000;
          throw new Error("slow helper failure");
        },
      }),
      now: () => new Date("2026-08-20T04:00:00Z"),
      logger: { info: () => {}, warn: () => {} },
    });

    const first = await service.sync();
    assert.equal(first.synced, true);
    assert.equal(attempts.length, 0, "automatic sync never invokes legacy writer or prune owner");
    assert.deepEqual(events, ["push", "scheduled"]);

    const second = await service.sync();
    assert.equal(second.synced, true);
    assert.equal(attempts.length, 0);
    assert.equal(events.filter((event) => event === "push").length, 2);
    assert.equal(backupRows(state.databaseFile).filter((row) => row.state === "committed").length, 3);
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("concurrent callers serialize and never reuse one backup name", async () => {
  const state = await fixture();
  try {
    const results = await Promise.all([rotate(state, 2), rotate(state, 3)]);
    assert.equal(results.filter((result) => result.applied).length, 2);
    const rows = backupRows(state.databaseFile);
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((row) => row.directory_name)).size, 2);
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("changed backup files and reparse directories are not pruned", async (context) => {
  const state = await fixture();
  let outside = null;
  try {
    for (let index = 2; index <= 4; index += 1) await rotate(state, index);
    const row = backupRows(state.databaseFile)[0];
    const root = path.join(state.directory, "migrations");
    const file = path.join(root, row.directory_name, row.file_name);
    await writeFile(file, "not the captured SQLite backup");
    assert.equal((await rotate(state, 5)).retention.skipped, 1);
    assert.equal(backupRows(state.databaseFile)[0].state, "committed");

    const replaceRow = backupRows(state.databaseFile)[1];
    const replaceDirectory = path.join(root, replaceRow.directory_name);
    outside = await mkdtemp(path.join(os.tmpdir(), "agent-hub-backup-reparse-target-"));
    await writeFile(path.join(outside, "marker"), "untouched");
    await rm(replaceDirectory, { recursive: true });
    try { await symlink(outside, replaceDirectory, "junction"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        context.diagnostic("junction creation unavailable on this Windows host");
        return;
      }
      throw error;
    }
    assert.equal((await rotate(state, 6)).retention.skipped, 2);
    assert.equal(await readFile(path.join(outside, "marker"), "utf8"), "untouched");
    assert.ok((await readdir(root)).includes(replaceRow.directory_name));
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    if (outside) await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("content-free tracing survives telemetry failure without changing the committed update", async () => {
  const state = await fixture();
  const spans = [];
  try {
    const result = await rotate(state, 2, {
      trace: { recordBestEffort: (span) => {
        spans.push(span);
        throw new Error("telemetry unavailable");
      } },
    });
    assert.equal(result.applied, true);
    assert.deepEqual(spans.map((span) => span.stage), [
      "work-log-account-backup", "work-log-account-backfill-commit", "work-log-account-backup-prune",
    ]);
    assert.ok(spans.every((span) => !JSON.stringify(span).includes("account-2")));
    assert.equal(backupRows(state.databaseFile)[0].state, "committed");
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("directory swapped to a junction after inspection cannot delete an outside file", async (context) => {
  const state = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-hub-backup-swap-target-"));
  try {
    for (let index = 2; index <= 4; index += 1) await rotate(state, index);
    const victim = backupRows(state.databaseFile)[0];
    const owned = path.join(state.directory, "migrations", victim.directory_name, victim.file_name);
    const marker = path.join(outside, "journal.sqlite");
    const foreignBytes = Buffer.alloc((await stat(owned)).size, 0x65);
    await writeFile(marker, foreignBytes);
    let swapped = false;
    const result = await rotate(state, 5, {
      retentionBeforeDelete: async ({ directory, kind }) => {
        if (kind !== "file") return;
        const displaced = path.join(state.directory, "displaced-owned-backup");
        await rename(directory, displaced);
        try { await symlink(outside, directory, "junction"); }
        catch (error) {
          if (["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
            context.diagnostic("junction creation unavailable on this Windows host");
            await rename(displaced, directory);
            return;
          }
          throw error;
        }
        swapped = true;
      },
    });
    if (swapped) {
      assert.equal(result.retention.deleted, 0);
      assert.equal(result.retention.errors, 1);
      assert.ok(result.retention.failureKinds.includes("identity-index"), JSON.stringify(result.retention));
      assert.equal(backupRows(state.databaseFile)[0].state, "pruning");
      assert.deepEqual(await readFile(marker), foreignBytes);
      const original = path.join(state.directory, "migrations", backupRows(state.databaseFile)[0].directory_name);
      await rmdir(original);
      await rename(path.join(state.directory, "displaced-owned-backup"), original);
      assert.equal((await rotate(state, 5)).retention.errors, 0);
    }
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("junction swap after handle verification deletes only the receipt object", async (context) => {
  const state = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-hub-backup-isolated-target-"));
  try {
    for (let index = 2; index <= 4; index += 1) await rotate(state, index);
    const victim = backupRows(state.databaseFile)[0];
    const original = path.join(state.directory, "migrations", victim.directory_name);
    const marker = path.join(outside, "journal.sqlite");
    const foreignBytes = Buffer.alloc((await stat(path.join(original, victim.file_name))).size, 0x66);
    await writeFile(marker, foreignBytes);
    const displaced = path.join(state.directory, "displaced-open-backup");
    const barrier = path.join(state.directory, "handle-barrier");
    const pending = rotate(state, 5, { retentionHandleTestBarrier: barrier });
    let ready = false;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await stat(`${barrier}.ready`).then(() => true, () => false)) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(ready, true, "helper must hold a verified open handle");
    let swapped = false;
    let blocked = false;
    try {
      try { await rename(original, displaced); }
      catch (error) {
        if (!["EBUSY", "EACCES", "EPERM"].includes(error?.code)) throw error;
        blocked = true;
      }
      if (!blocked) {
        try { await symlink(outside, original, "junction"); swapped = true; }
        catch (error) {
          if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
          context.diagnostic("junction creation unavailable on this Windows host");
          await rename(displaced, original);
        }
      }
    } finally {
      await writeFile(`${barrier}.go`, "go");
    }
    const result = await pending;
    assert.deepEqual(await readFile(marker), foreignBytes);
    if (blocked) {
      assert.equal(result.retention.errors, 0);
      assert.equal(backupRows(state.databaseFile)[0].state, "pruned");
    }
    if (swapped) {
      assert.equal(result.retention.errors, 1);
      assert.equal(backupRows(state.databaseFile)[0].prune_file_removed, 1);
      await rmdir(original);
      await rename(displaced, original);
      const resumed = await rotate(state, 5);
      assert.equal(resumed.retention.errors, 0);
      assert.equal(backupRows(state.databaseFile)[0].state, "pruned");
    }
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("empty directory swap before handle deletion leaves foreign directory intact", async (context) => {
  const state = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "agent-hub-backup-dir-swap-target-"));
  try {
    for (let index = 2; index <= 4; index += 1) await rotate(state, index);
    const foreign = path.join(outside, "foreign-empty");
    await mkdir(foreign);
    const victim = backupRows(state.databaseFile)[0];
    const original = path.join(state.directory, "migrations", victim.directory_name);
    const displaced = path.join(state.directory, "displaced-empty-owned");
    let swapped = false;
    const result = await rotate(state, 5, {
      retentionBeforeDelete: async ({ kind }) => {
        if (kind !== "directory") return;
        await rename(original, displaced);
        try { await symlink(foreign, original, "junction"); }
        catch (error) {
          if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
          context.diagnostic("junction creation unavailable on this Windows host");
          await rename(displaced, original);
          return;
        }
        swapped = true;
      },
    });
    if (swapped) {
      assert.equal(result.retention.errors, 1);
      assert.ok(result.retention.failureKinds.includes("identity-type"), JSON.stringify(result.retention));
      assert.equal(backupRows(state.databaseFile)[0].prune_file_removed, 1);
      assert.equal((await stat(foreign)).isDirectory(), true);
      await rmdir(original);
      await rename(displaced, original);
      assert.equal((await rotate(state, 5)).retention.errors, 0);
      assert.equal(backupRows(state.databaseFile)[0].state, "pruned");
    }
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await rm(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("pruning resumes after handle deletion before receipt finalization", async () => {
  const state = await fixture();
  try {
    for (let index = 2; index <= 4; index += 1) await rotate(state, index);
    const unlinked = await rotate(state, 6, {
      retentionDeleteEntry: async (target, identity, options) => {
        await deleteVerifiedWindowsEntry(target, identity, options);
        if (!identity.directory) throw new Error("simulated process stop after handle delete");
      },
    });
    assert.equal(unlinked.applied, true);
    assert.equal(unlinked.retention.errors, 1);
    assert.equal(backupRows(state.databaseFile).find((row) => row.state === "pruning").prune_file_removed, 0);
    const finished = await rotate(state, 6);
    assert.equal(finished.applied, false);
    assert.equal(finished.retention.errors, 0);
    assert.equal(backupRows(state.databaseFile).filter((row) => row.state === "committed").length, 3);

    const directoryDeleted = await rotate(state, 7, {
      retentionDeleteEntry: async (target, identity, options) => {
        await deleteVerifiedWindowsEntry(target, identity, options);
        if (identity.directory) throw new Error("simulated process stop after directory handle delete");
      },
    });
    assert.equal(directoryDeleted.applied, true);
    assert.equal(directoryDeleted.retention.errors, 1);
    assert.equal(backupRows(state.databaseFile).find((row) => row.state === "pruning").prune_file_removed, 1);
    assert.equal((await rotate(state, 7)).retention.errors, 0);
    assert.equal(backupRows(state.databaseFile).filter((row) => row.state === "committed").length, 3);
  } finally {
    await rm(state.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

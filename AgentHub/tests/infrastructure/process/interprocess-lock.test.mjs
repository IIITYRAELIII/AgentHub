import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  withInterprocessLocks,
} from "../../../src/infrastructure/process/interprocess-lock.mjs";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

function ownerPath(lock, token) {
  const digest = createHash("sha256").update(String(token)).digest("hex");
  return path.join(lock, `owner-${digest}.json`);
}

async function writeOwner(lock, value) {
  await mkdir(lock, { recursive: true });
  await writeFile(ownerPath(lock, value.token), JSON.stringify(value));
}

async function writeLegacyOwner(lock, value) {
  await mkdir(lock, { recursive: true });
  await writeFile(path.join(lock, "owner.json"), JSON.stringify(value));
}

async function currentOwner(lock) {
  const [file] = (await readdir(lock)).filter((entry) => entry.startsWith("owner-"));
  return JSON.parse(await readFile(path.join(lock, file), "utf8"));
}

test("interprocess lock recovers a stale dead owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-stale-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await writeOwner(lock, {
      token: "dead-owner",
      pid: 999_999,
      processInstanceId: "dead-process",
      createdAt: Date.now(),
    });
    let entered = false;
    await withInterprocessLocks([target], async () => { entered = true; }, {
      isProcessAlive: () => false,
      staleMs: 60_000,
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent acquisitions do not enter the same lock together", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-concurrent-"));
  const target = path.join(root, "ledger.json");
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all(Array.from({ length: 10 }, () => withInterprocessLocks([target], async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    }, { retryDelayMs: 1 })));
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interprocess lock does not steal a live owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-live-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await writeOwner(lock, {
      token: "live-owner",
      pid: 42,
      processInstanceId: "live-process",
      createdAt: 0,
    });
    await assert.rejects(
      withInterprocessLocks([target], async () => {}, {
        isProcessAlive: () => true,
        timeoutMs: 25,
        retryDelayMs: 1,
        staleMs: 0,
      }),
      /Timed out waiting/u,
    );
    assert.equal((await currentOwner(lock)).token, "live-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interprocess lock recovers a fresh ownerless directory before the main stale timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-ownerless-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await mkdir(lock);
    let entered = false;
    await withInterprocessLocks([target], async () => { entered = true; }, {
      timeoutMs: 250,
      retryDelayMs: 2,
      staleMs: 60_000,
      ownerlessStaleMs: 20,
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release cannot retire a replacement swapped after exact owner validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-replacement-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  const displaced = `${lock}.displaced`;
  try {
    const diagnostics = [];
    const result = await withInterprocessLocks([target], async () => "first-result", {
      tokenFactory: () => "first-owner",
      beforeOwnerRemove: async () => {
        await rename(lock, displaced);
        await writeOwner(lock, {
          token: "replacement-owner",
          pid: process.pid,
          processInstanceId: "replacement-process",
          createdAt: Date.now(),
        });
      },
      onReleaseError: (items) => diagnostics.push(...items),
    });
    assert.equal(result, "first-result");
    assert.equal(diagnostics.length, 1);
    assert.equal((await currentOwner(lock)).token, "replacement-owner");
    assert.equal(Number.isFinite((await currentOwner(displaced)).releasedAt), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interprocess lock safely quarantines and replaces a proven-dead legacy owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-legacy-dead-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await writeLegacyOwner(lock, {
      token: "legacy-dead", pid: 999_999, processInstanceId: "dead-process", createdAt: 0,
    });
    let entered = false;
    await withInterprocessLocks([target], async () => { entered = true; }, {
      isProcessAlive: () => false,
      timeoutMs: 100,
      retryDelayMs: 1,
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interprocess lock never retires a live legacy owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-legacy-live-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await writeLegacyOwner(lock, {
      token: "legacy-live", pid: 42, processInstanceId: "live-process", createdAt: 0,
    });
    await assert.rejects(withInterprocessLocks([target], async () => {}, {
      isProcessAlive: () => true,
      timeoutMs: 25,
      retryDelayMs: 1,
    }), /Timed out waiting/u);
    assert.equal(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).token, "legacy-live");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interprocess lock fails closed for ambiguous legacy process identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-legacy-unknown-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await writeLegacyOwner(lock, {
      token: "legacy-unknown", pid: 42, processInstanceId: "unknown-process", createdAt: 0,
    });
    await assert.rejects(withInterprocessLocks([target], async () => {}, {
      processIdentityState: async () => "unknown",
      timeoutMs: 25,
      retryDelayMs: 1,
    }), /Timed out waiting/u);
    assert.equal(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).token, "legacy-unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy quarantine failure is bounded and actionable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-legacy-quarantine-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await writeLegacyOwner(lock, {
      token: "legacy-dead-busy", pid: 999_999, processInstanceId: "dead-process", createdAt: 0,
    });
    const busy = Object.assign(new Error("legacy lock busy"), { code: "EBUSY" });
    await assert.rejects(withInterprocessLocks([target], async () => {}, {
      isProcessAlive: () => false,
      moveLegacyLock: async () => { throw busy; },
      timeoutMs: 25,
      retryDelayMs: 1,
    }), /Cannot quarantine stale interprocess lock before deadline/u);
    assert.equal(JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8")).token, "legacy-dead-busy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Windows lock removal leaves an owned-handle release marker for safe recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-release-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    const busyError = Object.assign(new Error("busy"), { code: "EBUSY" });
    const diagnostics = [];
    const result = await withInterprocessLocks([target], async () => "released-result", {
      tokenFactory: () => "release-owner",
      removeOwnerPath: async () => { throw busyError; },
      retryDelaysMs: [0],
      onReleaseError: (items) => diagnostics.push(...items),
    });
    assert.equal(result, "released-result");
    assert.equal(diagnostics.length, 1);
    const retiredOwner = await currentOwner(lock);
    assert.equal(retiredOwner.token, "release-owner");
    assert.equal(Number.isFinite(retiredOwner.releasedAt), true);

    let entered = false;
    await withInterprocessLocks([target], async () => { entered = true; }, {
      timeoutMs: 250,
      retryDelayMs: 1,
      staleMs: 60_000,
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired mismatched process identity recovers despite a reused live PID or EPERM", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-pid-reuse-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await writeOwner(lock, {
      token: "previous-process", pid: process.pid, processInstanceId: "different-process-instance",
      createdAt: 0, leaseExpiresAt: 0,
    });
    let entered = false;
    await withInterprocessLocks([target], async () => { entered = true; }, {
      isProcessAlive: () => true,
      processInstanceId: "current-process-instance",
      timeoutMs: 100,
      retryDelayMs: 1,
    });
    assert.equal(entered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permanent stale-lock quarantine failure stops at a bounded actionable deadline", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-quarantine-"));
  const target = path.join(root, "ledger.json");
  const lock = `${target}.lock`;
  try {
    await writeOwner(lock, {
      token: "dead-owner", pid: 999_999, createdAt: 0, leaseExpiresAt: 0,
      processInstanceId: "old-process",
    });
    const startedAt = Date.now();
    await assert.rejects(
      withInterprocessLocks([target], async () => {}, {
        isProcessAlive: () => false,
        quarantine: async () => false,
        timeoutMs: 30,
        retryDelayMs: 5,
      }),
      /Cannot quarantine stale interprocess lock before deadline/u,
    );
    assert.ok(Date.now() - startedAt >= 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lock release diagnostics never replace a successful protected operation result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-release-result-"));
  const target = path.join(root, "ledger.json");
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" });
  const diagnostics = [];
  try {
    const result = await withInterprocessLocks([target], async () => "protected-result", {
      removeOwnerPath: async () => { throw busy; },
      retryDelaysMs: [0],
      onReleaseError: (items) => diagnostics.push(...items),
    });
    assert.equal(result, "protected-result");
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0].error.message, /busy/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renewal loss fences the old owner before its lease expires", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-renewal-loss-"));
  const target = path.join(root, "lifecycle");
  let sideEffect = false;
  try {
    const startedAt = Date.now();
    await assert.rejects(
      withInterprocessLocks([target], async ({ signal, assertOwned }) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        await assertOwned();
        sideEffect = true;
      }, {
        staleMs: 500,
        renewLease: async () => false,
      }),
      /lease ownership was lost/u,
    );
    assert.equal(sideEffect, false);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease loss interrupts a long Git process and forbids stale mutations after replacement acquisition", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-git-fence-"));
  const target = path.join(root, "task-lifecycle");
  let staleMutation = false;
  let replacementMutation = false;
  try {
    const first = withInterprocessLocks([target], async (lease) => {
      await runTaskGitCommand(["-e", "setInterval(() => {}, 1000)"], {
        executable: process.execPath,
        cwd: root,
        timeoutMs: 5_000,
        signal: lease.signal,
      });
      await lease.assertOwned();
      staleMutation = true;
    }, {
      staleMs: 120,
      retryDelayMs: 2,
      renewLease: async () => false,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const replacement = withInterprocessLocks([target], async () => {
      replacementMutation = true;
    }, { staleMs: 120, retryDelayMs: 2, timeoutMs: 2_000 });

    await assert.rejects(first, /lease ownership was lost|was fenced/u);
    await replacement;
    assert.equal(staleMutation, false);
    assert.equal(replacementMutation, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live exact owner survives an event-loop stall beyond staleMs", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-lock-stall-"));
  const target = path.join(root, "lifecycle");
  const moduleUrl = new URL("../../../src/infrastructure/process/interprocess-lock.mjs", import.meta.url).href;
  const script = `
    import { withInterprocessLocks } from ${JSON.stringify(moduleUrl)};
    const target = process.argv[1];
    await withInterprocessLocks([target], async ({ assertOwned }) => {
      await new Promise((resolve) => process.stdout.write("acquired\\n", resolve));
      const until = Date.now() + 700;
      while (Date.now() < until) {}
      await assertOwned();
      process.stdout.write("resumed\\n");
    }, { staleMs: 50, retryDelayMs: 2 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, target], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  context.after(() => child.kill());
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  try {
    while (!stdout.includes("acquired")) {
      if (child.exitCode != null) throw new Error(`stall owner exited early: ${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    let replacementEntered = false;
    await assert.rejects(
      withInterprocessLocks([target], async () => { replacementEntered = true; }, {
        staleMs: 50,
        retryDelayMs: 2,
        timeoutMs: 150,
      }),
      /Timed out waiting/u,
    );
    assert.equal(replacementEntered, false);
    await once(child, "close");
    assert.equal(child.exitCode, 0);
    assert.match(stdout, /resumed/u);
    await withInterprocessLocks([target], async () => { replacementEntered = true; }, {
      retryDelayMs: 2,
      timeoutMs: 500,
    });
    assert.equal(replacementEntered, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

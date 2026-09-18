import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  PUBLICATION_STAGE_DELEGATION_ENV,
  withPublicationLock,
} from "../../../src/infrastructure/process/publication-lock.mjs";

const execFileAsync = promisify(execFile);
const moduleUrl = pathToFileURL(path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/infrastructure/process/publication-lock.mjs",
)).href;

function delegatedChildScript(lockTarget) {
  return `
    import { withPublicationLock } from ${JSON.stringify(moduleUrl)};
    try {
      const value = await withPublicationLock(async () => "child-stage-entered", {
        lockTarget: ${JSON.stringify(lockTarget)},
        timeoutMs: 250,
      });
      console.log(JSON.stringify({ entered: true, value }));
    } catch (error) {
      console.log(JSON.stringify({ entered: false, message: error.message }));
    }
  `;
}

function decodeDelegation(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function encodeDelegation(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function runChild(script, env) {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 2_000,
  });
  return JSON.parse(stdout.trim());
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("publication lock serializes deployments from concurrent worktrees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-"));
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all(Array.from({ length: 4 }, () => withPublicationLock(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    }, {
      environment: {},
      lockTarget: path.join(root, "publication"),
      timeoutMs: 1_000,
    })));
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested publication steps reuse the owning publication session", async () => {
  const environment = {};
  let lockCalls = 0;
  const result = await withPublicationLock(async () => withPublicationLock(async () => "done", {
    environment,
    lock: async () => { lockCalls += 1; throw new Error("nested call must not acquire another lock"); },
  }), {
    environment,
    lock: async (_paths, operation) => {
      lockCalls += 1;
      return operation();
    },
  });
  assert.equal(result, "done");
  assert.equal(lockCalls, 1);
});

test("same-process publication operations do not reuse another operation's environment token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-reentrant-"));
  let active = 0;
  let maximum = 0;
  try {
    await Promise.all(Array.from({ length: 2 }, () => withPublicationLock(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
    }, {
      environment: process.env,
      lockTarget: path.join(root, "publication"),
      timeoutMs: 1_000,
    })));
    assert.equal(maximum, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("escaped async descendants cannot reuse a completed publication lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-escaped-"));
  const lockTarget = path.join(root, "publication");
  const gate = deferred();
  let escaped = null;
  let active = false;
  let overlap = false;
  try {
    await withPublicationLock(async () => {
      escaped = gate.promise.then(() => withPublicationLock(async () => {
        overlap = active;
      }, {
        lockTarget,
        timeoutMs: 1_000,
      }));
    }, {
      lockTarget,
      timeoutMs: 1_000,
    });

    await withPublicationLock(async () => {
      active = true;
      gate.resolve();
      await Promise.race([escaped, delay(150)]);
      active = false;
    }, {
      lockTarget,
      timeoutMs: 1_000,
    });
    await escaped;
    assert.equal(overlap, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("escaped async descendants cannot reuse a failed publication lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-escaped-failed-"));
  const lockTarget = path.join(root, "publication");
  const gate = deferred();
  let escaped = null;
  let active = false;
  let overlap = false;
  try {
    await assert.rejects(withPublicationLock(async () => {
      escaped = gate.promise.then(() => withPublicationLock(async () => {
        overlap = active;
      }, {
        lockTarget,
        timeoutMs: 1_000,
      }));
      throw new Error("synthetic publication failure");
    }, {
      lockTarget,
      timeoutMs: 1_000,
    }), /synthetic publication failure/u);

    await withPublicationLock(async () => {
      active = true;
      gate.resolve();
      await Promise.race([escaped, delay(150)]);
      active = false;
    }, {
      lockTarget,
      timeoutMs: 1_000,
    });
    await escaped;
    assert.equal(overlap, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication lock delegates an owned stage to a real child process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-child-"));
  const lockTarget = path.join(root, "publication");
  try {
    let capturedDelegation = "";
    const child = await withPublicationLock(async () => {
      capturedDelegation = process.env[PUBLICATION_STAGE_DELEGATION_ENV] ?? "";
      assert.ok(capturedDelegation);
      return runChild(delegatedChildScript(lockTarget), { ...process.env });
    }, {
      environment: process.env,
      lockTarget,
      timeoutMs: 1_000,
    });
    assert.deepEqual(child, { entered: true, value: "child-stage-entered" });

    const stale = await runChild(delegatedChildScript(lockTarget), {
      ...process.env,
      AGENT_HUB_PUBLICATION_SESSION: decodeDelegation(capturedDelegation).session,
      [PUBLICATION_STAGE_DELEGATION_ENV]: capturedDelegation,
    });
    assert.equal(stale.entered, false);
    assert.match(stale.message, /delegation owner is not live/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plain inherited publication session does not delegate a child process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-child-plain-"));
  const lockTarget = path.join(root, "publication");
  try {
    const child = await withPublicationLock(async () => {
      const env = { ...process.env };
      delete env[PUBLICATION_STAGE_DELEGATION_ENV];
      return runChild(delegatedChildScript(lockTarget), env);
    }, {
      environment: process.env,
      lockTarget,
      timeoutMs: 1_000,
    });
    assert.equal(child.entered, false);
    assert.match(child.message, /Timed out waiting for interprocess lock/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication stage delegation refuses wrong target and forged owner token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-child-forged-"));
  const lockTarget = path.join(root, "publication");
  const otherTarget = path.join(root, "other-publication");
  try {
    await withPublicationLock(async () => {
      const captured = process.env[PUBLICATION_STAGE_DELEGATION_ENV] ?? "";
      assert.ok(captured);
      const delegation = decodeDelegation(captured);
      const wrongTarget = await runChild(delegatedChildScript(otherTarget), { ...process.env });
      assert.equal(wrongTarget.entered, false);
      assert.match(wrongTarget.message, /different publication lock/u);

      const forged = encodeDelegation({ ...delegation, token: "forged-token" });
      const wrongOwner = await runChild(delegatedChildScript(lockTarget), {
        ...process.env,
        [PUBLICATION_STAGE_DELEGATION_ENV]: forged,
      });
      assert.equal(wrongOwner.entered, false);
      assert.match(wrongOwner.message, /delegation owner is not live/u);
    }, {
      environment: process.env,
      lockTarget,
      timeoutMs: 1_000,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

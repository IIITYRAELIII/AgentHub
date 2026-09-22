import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { createCandidateGeneration } from "../../src/domain/release-operation.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";

const execute = promisify(execFile);

async function git(cwd, ...args) {
  return (await execute("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout.trim();
}

function requestJson(url, { method = "GET", body = null } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method,
      agent: false,
      headers: body == null ? { connection: "close" } : {
        connection: "close", "content-type": "application/json", "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve(JSON.parse(text)));
    });
    request.once("error", reject);
    if (body != null) request.write(body);
    request.end();
  });
}

async function gitFixture(root) {
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  await execute("git", ["init", "--bare", remote], { windowsHide: true });
  await execute("git", ["clone", remote, source], { windowsHide: true });
  await git(source, "config", "user.name", "Agent Hub Test");
  await git(source, "config", "user.email", "agent-hub@example.invalid");
  await writeFile(path.join(source, "release.txt"), "base\n", "utf8");
  await git(source, "add", "release.txt");
  await git(source, "commit", "-m", "base");
  await git(source, "branch", "-M", "main");
  await git(source, "push", "origin", "main");
  const base = await git(source, "rev-parse", "HEAD");
  await writeFile(path.join(source, "release.txt"), "result-r1\n", "utf8");
  await git(source, "commit", "-am", "result r1");
  const resultR1 = await git(source, "rev-parse", "HEAD");
  await git(source, "push", "origin", `${resultR1}:refs/heads/results/r1`);
  await writeFile(path.join(source, "release.txt"), "result-r2\n", "utf8");
  await git(source, "commit", "-am", "result r2");
  const resultR2 = await git(source, "rev-parse", "HEAD");
  await git(source, "push", "origin", `${resultR2}:refs/heads/results/r2`);
  return { remote, source, base, resultR1, resultR2 };
}

async function deployEndpoint(t) {
  const effects = new Map();
  const calls = [];
  let loseNextReply = false;
  const server = http.createServer((request, response) => {
    const key = decodeURIComponent(request.url.split("/").at(-1));
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(effects.get(key) ?? { status: "not_applied" }));
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const value = JSON.parse(body);
      calls.push({ key, value });
      effects.set(key, { status: "applied", revision: value.revision });
      if (loseNextReply) {
        loseNextReply = false;
        request.socket.destroy();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(effects.get(key)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    calls,
    effects,
    loseReply() { loseNextReply = true; },
  };
}

function authorization(repositoryRoot) {
  return {
    taskIds: ["task-a", "task-b"],
    validationMode: "full",
    approvedTargets: [
      { targetId: "git", kind: "git", repositoryRoot },
      { targetId: "deploy", kind: "deploy", environment: "test" },
    ],
  };
}

async function operationHarness(t, { validationFailures = 0, publicationFailure = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-public-matrix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await gitFixture(root);
  const deploy = await deployEndpoint(t);
  let selectedCommit = repository.resultR1;
  let failures = validationFailures;
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const store = new ReleaseOperationStore({ dataDir });
  const publishCalls = [];
  const finalized = [];
  const readTarget = async ({ generation, target }) => {
    if (target.targetId === "git") {
      const remote = (await execute("git", ["ls-remote", repository.remote, "refs/heads/main"], {
        encoding: "utf8", windowsHide: true,
      })).stdout.trim().split(/\s/u)[0];
      return remote === generation.candidates[0].commit
        ? { status: "applied", revision: remote }
        : { status: "not_applied", revision: remote };
    }
    return requestJson(`${deploy.baseUrl}/status/${target.targetId}`);
  };
  const service = new ReleaseOperationService({
    store,
    retryDelayMs: 20,
    compose: async ({ operation, generation }) => {
      const tree = await git(repository.source, "rev-parse", `${selectedCommit}^{tree}`);
      return {
        repositoryBases: [{ repositoryRoot: repository.source, baseCommit: repository.base }],
        selectedResults: operation.authorization.taskIds.map((taskId) => ({
          taskId, resultCommit: selectedCommit, tree, acceptanceRevision: generation,
        })),
        candidates: [{
          repositoryRoot: repository.source,
          releaseRoot: repository.source,
          commit: selectedCommit,
          tree,
          manifestHash: createHash("sha256").update(`${selectedCommit}:${tree}`).digest("hex"),
        }],
        sourceFingerprint: selectedCommit,
      };
    },
    validate: async () => {
      if (failures > 0) {
        failures -= 1;
        const error = new Error("injected validation failure");
        error.code = "RELEASE_VALIDATION_FAILED";
        throw error;
      }
      return { status: "passed" };
    },
    publishTarget: async ({ generation, target }) => {
      const current = await readTarget({ generation, target });
      if (current.status === "applied") return current;
      publishCalls.push(target.targetId);
      if (target.targetId === "git") {
        await git(repository.source, "push", "origin", `${generation.candidates[0].commit}:refs/heads/main`);
        if (publicationFailure === "git-reply") throw Object.assign(new Error("lost git reply"), { code: "ECONNRESET" });
        return { status: "applied", revision: generation.candidates[0].commit };
      }
      if (publicationFailure === "deploy-reply") deploy.loseReply();
      return requestJson(`${deploy.baseUrl}/deploy/${target.targetId}`, {
        method: "POST",
        body: JSON.stringify({ revision: generation.candidates[0].commit }),
      });
    },
    readTarget,
    finalize: async ({ generation }) => {
      finalized.push(generation.identitySha256);
      return { status: "completed" };
    },
  });
  return {
    root, repository, deploy, store, service, publishCalls, finalized,
    select(commit) { selectedCommit = commit; },
  };
}

function start(harness, requestId = "release-request") {
  return harness.service.start({
    requestId,
    workspaceId: "workspace",
    streamId: "release-manager",
    threadId: "thread",
    authorization: authorization(harness.repository.source),
  });
}

async function waitForState(service, operationId, expected, { timeoutMs = 5_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await service.drain(operationId);
    if (snapshot.operation.state === expected) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const snapshot = service.get(operationId);
  assert.equal(snapshot.operation.state, expected);
  return snapshot;
}

test("public release operation fault and migration matrix", async (t) => {
  await t.test("1 exact accepted composition is immutable and conflict does not replace it", async (scenario) => {
    const harness = await operationHarness(scenario);
    const ack = start(harness);
    const snapshot = await harness.service.drain(ack.operationId);
    assert.equal(snapshot.operation.state, "done");
    assert.deepEqual(snapshot.generations[0].selectedResults.map((item) => item.taskId), ["task-a", "task-b"]);
    assert.throws(() => harness.store.putGeneration(createCandidateGeneration({
      ...snapshot.generations[0], candidates: [{ ...snapshot.generations[0].candidates[0], commit: "conflict" }],
    })), /immutable/u);
  });

  await t.test("2 failed G1 accepts R2 and publishes G2 in the same operation", async (scenario) => {
    const harness = await operationHarness(scenario, { validationFailures: 1 });
    const ack = start(harness);
    let snapshot = await harness.service.drain(ack.operationId);
    assert.equal(snapshot.operation.waitReason.code, "validation_failed");
    harness.select(harness.repository.resultR2);
    harness.service.wakeForTask("task-a");
    snapshot = await harness.service.drain(ack.operationId);
    assert.equal(snapshot.operation.state, "done");
    assert.equal(snapshot.generations.length, 2);
    assert.equal(snapshot.generations[1].selectedResults[0].resultCommit, harness.repository.resultR2);
  });

  await t.test("3 unrelated acceptance is excluded and a newer Task state is not overwritten", async (scenario) => {
    const harness = await operationHarness(scenario);
    const ack = start(harness);
    const snapshot = await harness.service.drain(ack.operationId);
    assert.equal(snapshot.generations[0].selectedResults.some((item) => item.taskId === "task-c"), false);
    assert.equal(snapshot.operation.state, "done");
  });

  await t.test("4 request replay keeps one SQLite operation identity", async (scenario) => {
    const harness = await operationHarness(scenario);
    const first = start(harness, "same-request");
    const second = start(harness, "same-request");
    assert.equal(first.operationId, second.operationId);
    assert.equal(second.created, false);
    await harness.service.drain(first.operationId);
  });

  await t.test("5 lost push reply is read back and missing deploy runs once", async (scenario) => {
    const harness = await operationHarness(scenario, { publicationFailure: "git-reply" });
    const ack = start(harness);
    const snapshot = await harness.service.drain(ack.operationId);
    assert.equal(snapshot.operation.state, "done");
    assert.deepEqual(harness.publishCalls.toSorted(), ["deploy", "git"]);
    assert.equal(harness.deploy.calls.length, 1);
  });

  await t.test("6 start ACK precedes work and get exposes the exact Thread owner", async (scenario) => {
    const harness = await operationHarness(scenario);
    const ack = start(harness);
    const immediate = harness.service.get(ack.operationId);
    assert.equal(ack.accepted, true);
    assert.equal(immediate.operation.threadId, "thread");
    await harness.service.drain(ack.operationId);
  });

  await t.test("7 canonical generation identity distinguishes raw EOL bytes", async () => {
    const common = {
      operationId: "eol", generation: 1, repositoryBases: [{ repositoryRoot: "repo", baseCommit: "base" }],
      selectedResults: [{ taskId: "task-a", resultCommit: "result" }],
      candidates: [{ repositoryRoot: "repo", releaseRoot: "owned", commit: "candidate", tree: "tree", manifestHash: "manifest" }],
      runnerVersion: "runner",
    };
    const lf = createCandidateGeneration({ ...common, sourceFingerprint: createHash("sha256").update("a\n").digest("hex") });
    const crlf = createCandidateGeneration({ ...common, sourceFingerprint: createHash("sha256").update("a\r\n").digest("hex") });
    assert.notEqual(lf.identitySha256, crlf.identitySha256);
  });

  await t.test("8 a live lease prevents a second external writer", async (scenario) => {
    const harness = await operationHarness(scenario);
    const created = harness.store.create({
      requestId: "leased", workspaceId: "workspace", streamId: "stream", threadId: "thread",
      authorization: authorization(harness.repository.source), runnerVersion: "runner",
    }).operation;
    assert.equal(harness.store.acquire(created.operationId, "worker-a", { leaseMs: 60_000 }).acquired, true);
    assert.equal(harness.store.acquire(created.operationId, "worker-b", { leaseMs: 60_000 }).acquired, false);
  });

  await t.test("9 unavailable target has one visible wait and automatically resumes", async (scenario) => {
    let blocked = true;
    const harness = await operationHarness(scenario);
    const original = harness.service.publishTarget;
    harness.service.publishTarget = async (input) => {
      if (blocked && input.target.targetId === "git") {
        blocked = false;
        const error = new Error("remote unavailable");
        error.code = "RELEASE_EXTERNAL_CONDITION";
        error.retryAfterMs = 20;
        throw error;
      }
      return original(input);
    };
    const ack = start(harness);
    await waitForState(harness.service, ack.operationId, "done");
  });

  await t.test("10 N-1 operation remains readable by an N runner", async (scenario) => {
    const harness = await operationHarness(scenario);
    const created = harness.store.create({
      requestId: "runner-n-1", workspaceId: "workspace", streamId: "stream", threadId: "thread",
      authorization: authorization(harness.repository.source), runnerVersion: "runner-n-1",
    });
    const reopened = new ReleaseOperationStore({ dataDir: path.join(harness.root, "data") });
    assert.equal(reopened.get(created.operation.operationId).runnerVersion, "runner-n-1");
  });

  await t.test("11 identical validation failure waits without a hidden full-suite loop", async (scenario) => {
    const harness = await operationHarness(scenario, { validationFailures: 2 });
    const ack = start(harness);
    const first = await harness.service.drain(ack.operationId);
    assert.equal(first.operation.waitReason.code, "validation_failed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const unchanged = harness.service.get(ack.operationId);
    assert.equal(unchanged.operation.revision, first.operation.revision);
  });

  await t.test("12 old prepared freezing frozen failed published and unknown evidence imports once", async (scenario) => {
    const harness = await operationHarness(scenario);
    const tree = await git(harness.repository.source, "rev-parse", `${harness.repository.resultR1}^{tree}`);
    const terminal = [];
    for (const state of ["prepared", "freezing", "frozen", "failed", "published", "unknown"]) {
      const input = {
        workspaceId: "workspace", streamId: "stream", threadId: "thread",
        sourceKind: "legacy-publication", sourceIdentity: `legacy-${state}`,
        evidence: { status: state, revision: state },
        authorization: authorization(harness.repository.source), runnerVersion: "runner-n-1",
        candidateGeneration: {
          createdAt: "2026-09-22T00:00:00.000Z",
          repositoryBases: [{ repositoryRoot: harness.repository.source, baseCommit: harness.repository.base }],
          selectedResults: [
            { taskId: "task-a", resultCommit: harness.repository.resultR1, tree, acceptanceRevision: 1 },
            { taskId: "task-b", resultCommit: harness.repository.resultR1, tree, acceptanceRevision: 1 },
          ],
          candidates: [{
            repositoryRoot: harness.repository.source,
            releaseRoot: harness.repository.source,
            commit: harness.repository.resultR1,
            tree,
            manifestHash: createHash("sha256").update(`legacy-${state}`).digest("hex"),
          }],
          sourceFingerprint: `legacy-${state}`,
        },
      };
      const first = harness.store.importLegacy(input);
      const replay = harness.store.importLegacy(input);
      assert.equal(first.operation.operationId, replay.operation.operationId);
      if (state === "failed") {
        assert.equal(first.operation.waitReason.code, "legacy_failure");
        continue;
      }
      harness.service.recover();
      terminal.push(await waitForState(harness.service, first.operation.operationId, "done"));
    }
    assert.equal(terminal.length, 5);
    assert.deepEqual(harness.publishCalls.toSorted(), ["deploy", "git"]);
    assert.equal(harness.deploy.calls.length, 1);
  });
});

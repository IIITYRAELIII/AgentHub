import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  enableLocalPublicationReceiptBaseline,
  previewLocalPublicationReceiptBaseline,
} from "../../../src/infrastructure/persistence/local-publication-receipt-baseline.mjs";
import { readPublicationState, writePublicationState } from "../../../src/infrastructure/persistence/publication-state.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture(t, { otherRepository = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-publication-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const runtimeRoot = path.join(root, "runtime");
  await git(root, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "Agent Hub Test");
  await git(repo, "config", "user.email", "agent-hub@example.invalid");
  await git(repo, "remote", "add", "origin", "https://github.com/Example/Utilities.git");
  await writeFile(path.join(repo, "published.txt"), "published\n", "utf8");
  await git(repo, "add", "published.txt");
  await git(repo, "commit", "-m", "published");
  const revision = await git(repo, "rev-parse", "HEAD");
  const tree = await git(repo, "rev-parse", "HEAD^{tree}");
  const originMain = await git(repo, "commit-tree", tree, "-p", revision, "-m", "origin descendant");
  await git(repo, "update-ref", "refs/remotes/origin/main", originMain);

  const stateFile = path.join(runtimeRoot, "publication-state.json");
  const statusFile = path.join(runtimeRoot, "publication-status.json");
  const releaseId = "20260911162032-test";
  const worktreeRoot = path.join(root, "release-checkout");
  const sourceRoot = path.join(worktreeRoot, "AgentHub");
  const state = {
    revision,
    files: ["AgentHub/app.mjs"],
    plan: { runtime: true, fullTests: true },
    validationMode: "full",
    generation: "generation-1",
    publishedAt: "2026-09-11T16:24:23.662Z",
    ...(otherRepository ? { repositories: [{ root: path.join(root, "other"), revision: "b".repeat(40) }] } : {}),
  };
  const receipt = {
    version: 2,
    runId: "publisher-run-1",
    status: "succeeded",
    error: null,
    identity: {
      revision,
      worktreeRoot,
      release: {
        workspaceId: "workspace-1",
        primaryRoot: repo,
        planRevision: "plan-1",
        manifestHash: "manifest-1",
        baseCommit: "a".repeat(40),
        preReleaseHead: revision,
      },
    },
    progress: {
      publicationState: Object.fromEntries(Object.entries(state).filter(([key]) => key !== "repositories")),
      expectedReleaseId: releaseId,
      finalizationCommandId: "finalize-1",
    },
  };
  await mkdir(path.join(runtimeRoot, "releases", releaseId), { recursive: true });
  const stateRaw = `${JSON.stringify(state, null, 2)}\n`;
  const receiptRaw = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(stateFile, stateRaw, "utf8");
  await writeFile(statusFile, receiptRaw, "utf8");
  await writeFile(path.join(runtimeRoot, "active.json"), `${JSON.stringify({
    release: releaseId,
    activatedAt: "2026-09-11T16:24:23.386Z",
    sourceRoot,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(runtimeRoot, "releases", releaseId, "runtime-manifest.json"), `${JSON.stringify({
    releaseId, sourceRoot,
  }, null, 2)}\n`, "utf8");
  const request = {
    projectRoot: repo,
    workspaceId: "workspace-1",
    runId: "publisher-run-1",
    expectedRevision: revision,
    expectedGeneration: "generation-1",
    expectedPublishedAt: "2026-09-11T16:24:23.662Z",
    expectedStateSha256: sha256(stateRaw),
    expectedReceiptSha256: sha256(receiptRaw),
    expectedReleaseId: releaseId,
    expectedOriginUrl: "git@github.com:example/Utilities.git",
    expectedOriginMainCommit: originMain,
    requestId: "operator-adoption-1",
  };
  const dependencies = {
    stateFile,
    statusFile,
    lock: async (operation) => operation(),
    writeState: (value) => writePublicationState(value, stateFile),
  };
  return { root, repo, runtimeRoot, stateFile, statusFile, state, receipt, request, dependencies, revision, originMain };
}

test("local publisher receipt preview is zero-write and enable appends exact scoped evidence idempotently", async (t) => {
  const setup = await fixture(t, { otherRepository: true });
  const before = await readFile(setup.stateFile, "utf8");
  const preview = await previewLocalPublicationReceiptBaseline(setup.request, setup.dependencies);
  assert.equal(preview.status, "preview");
  assert.equal(await readFile(setup.stateFile, "utf8"), before);

  const enabled = await enableLocalPublicationReceiptBaseline(setup.request, setup.dependencies);
  assert.equal(enabled.status, "adopted");
  const state = await readPublicationState(setup.stateFile);
  assert.equal(state.revision, setup.revision);
  assert.equal(state.generation, "generation-1");
  assert.equal(state.repositories.length, 2);
  const adopted = state.repositories.find((entry) => path.resolve(entry.root) === path.resolve(setup.repo));
  assert.equal(adopted.revision, setup.revision);
  assert.equal(adopted.adoptedFrom, "local-publisher-receipt");
  assert.equal(adopted.publisher.runId, "publisher-run-1");
  assert.equal(adopted.publisher.legacyStateSha256, setup.request.expectedStateSha256);
  assert.equal(adopted.publisher.receiptSha256, setup.request.expectedReceiptSha256);

  const retried = await enableLocalPublicationReceiptBaseline(setup.request, setup.dependencies);
  assert.equal(retried.status, "already_adopted");
  assert.equal((await readPublicationState(setup.stateFile)).repositories.length, 2);
});

test("local publisher receipt enable reenters the real publication lock through the default state writer", async (t) => {
  const setup = await fixture(t);
  const previousLocalAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = setup.root;
  try {
    const result = await enableLocalPublicationReceiptBaseline(setup.request, {
      stateFile: setup.stateFile,
      statusFile: setup.statusFile,
      writeState: (value) => writePublicationState(value, setup.stateFile),
    });
    assert.equal(result.status, "adopted");
    assert.equal((await readPublicationState(setup.stateFile)).repositories[0].revision, setup.revision);
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
  }
});

test("local publisher receipt rejects mismatched durable publication and deployment identities without writing", async (t) => {
  const cases = [
    ["generation", async (setup) => ({ ...setup.request, expectedGeneration: "other" }), /identity changed/u],
    ["repository", async (setup) => ({ ...setup.request, projectRoot: setup.root }), /another repository|origin URL/u],
    ["release", async (setup) => ({ ...setup.request, expectedReleaseId: "other-release" }), /ENOENT|active installed release/u],
    ["receipt status", async (setup) => {
      const changed = { ...setup.receipt, status: "failed" };
      const raw = `${JSON.stringify(changed, null, 2)}\n`;
      await writeFile(setup.statusFile, raw, "utf8");
      return { ...setup.request, expectedReceiptSha256: sha256(raw) };
    }, /successful terminal/u],
    ["missing release", async (setup) => {
      const changed = structuredClone(setup.receipt);
      delete changed.identity.release;
      const raw = `${JSON.stringify(changed, null, 2)}\n`;
      await writeFile(setup.statusFile, raw, "utf8");
      return { ...setup.request, expectedReceiptSha256: sha256(raw) };
    }, /identity does not match/u],
  ];
  for (const [name, mutate, pattern] of cases) {
    await t.test(name, async (subtest) => {
      const setup = await fixture(subtest);
      const before = await readFile(setup.stateFile, "utf8");
      const request = await mutate(setup);
      await assert.rejects(
        () => previewLocalPublicationReceiptBaseline(request, setup.dependencies),
        pattern,
      );
      assert.equal(await readFile(setup.stateFile, "utf8"), before);
    });
  }
});

test("local publisher receipt rejects moved refs, remote, raw evidence and runtime source", async (t) => {
  await t.test("local main", async (subtest) => {
    const setup = await fixture(subtest);
    await git(setup.repo, "update-ref", "refs/heads/main", setup.originMain);
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline(setup.request, setup.dependencies),
      /local main moved/u,
    );
  });
  await t.test("origin main", async (subtest) => {
    const setup = await fixture(subtest);
    await git(setup.repo, "update-ref", "refs/remotes/origin/main", setup.revision);
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline(setup.request, setup.dependencies),
      /origin\/main moved/u,
    );
  });
  await t.test("published revision absent from origin", async (subtest) => {
    const setup = await fixture(subtest);
    const tree = await git(setup.repo, "rev-parse", "HEAD^{tree}");
    const unrelated = await git(setup.repo, "commit-tree", tree, "-m", "unrelated origin");
    await git(setup.repo, "update-ref", "refs/remotes/origin/main", unrelated);
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline({
        ...setup.request, expectedOriginMainCommit: unrelated,
      }, setup.dependencies),
      /not contained in origin\/main/u,
    );
  });
  await t.test("remote", async (subtest) => {
    const setup = await fixture(subtest);
    await git(setup.repo, "remote", "set-url", "origin", "https://github.com/Other/Utilities.git");
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline(setup.request, setup.dependencies),
      /another canonical origin/u,
    );
  });
  await t.test("state bytes", async (subtest) => {
    const setup = await fixture(subtest);
    await writeFile(setup.stateFile, `${JSON.stringify(setup.state)}\n`, "utf8");
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline(setup.request, setup.dependencies),
      /raw bytes changed/u,
    );
  });
  await t.test("receipt bytes", async (subtest) => {
    const setup = await fixture(subtest);
    await writeFile(setup.statusFile, `${JSON.stringify(setup.receipt)}\n`, "utf8");
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline(setup.request, setup.dependencies),
      /receipt raw bytes changed/u,
    );
  });
  await t.test("incomplete legacy state", async (subtest) => {
    const setup = await fixture(subtest);
    const incomplete = { ...setup.state, plan: null };
    const raw = `${JSON.stringify(incomplete, null, 2)}\n`;
    await writeFile(setup.stateFile, raw, "utf8");
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline({
        ...setup.request, expectedStateSha256: sha256(raw),
      }, setup.dependencies),
      /state is incomplete/u,
    );
  });
  await t.test("malformed legacy state", async (subtest) => {
    const setup = await fixture(subtest);
    const raw = "{not-json\n";
    await writeFile(setup.stateFile, raw, "utf8");
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline({
        ...setup.request, expectedStateSha256: sha256(raw),
      }, setup.dependencies),
      /not valid JSON/u,
    );
  });
  await t.test("runtime source", async (subtest) => {
    const setup = await fixture(subtest);
    await writeFile(path.join(setup.runtimeRoot, "active.json"), `${JSON.stringify({
      release: setup.request.expectedReleaseId,
      activatedAt: setup.request.expectedPublishedAt,
      sourceRoot: path.join(setup.root, "foreign"),
    })}\n`, "utf8");
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline(setup.request, setup.dependencies),
      /runtime source/u,
    );
  });
});

test("local publisher receipt fences concurrent state drift and conflicting scoped evidence", async (t) => {
  await t.test("state drift", async (subtest) => {
    const setup = await fixture(subtest);
    let entered = false;
    await assert.rejects(
      () => enableLocalPublicationReceiptBaseline(setup.request, {
        ...setup.dependencies,
        lock: async (operation) => {
          entered = true;
          await writeFile(setup.stateFile, `${JSON.stringify(setup.state)}\n`, "utf8");
          return operation();
        },
      }),
      /raw bytes changed/u,
    );
    assert.equal(entered, true);
  });
  await t.test("conflicting scoped record", async (subtest) => {
    const setup = await fixture(subtest);
    const state = { ...setup.state, repositories: [{ root: setup.repo, revision: "c".repeat(40) }] };
    const raw = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(setup.stateFile, raw, "utf8");
    await assert.rejects(
      () => previewLocalPublicationReceiptBaseline({
        ...setup.request, expectedStateSha256: sha256(raw),
      }, setup.dependencies),
      /conflicting repository-scoped/u,
    );
  });
});

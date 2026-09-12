import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";

import {
  readPublicationState,
  writePublicationState,
} from "../../../src/infrastructure/persistence/publication-state.mjs";
import { withPublicationLock } from "../../../src/infrastructure/process/publication-lock.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-publication-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, "publication-state.json");
}

test("repository-scoped publication writes retain independent repository evidence", async (t) => {
  const file = await fixture(t);
  const repoA = path.resolve("D:/repo-a");
  const repoB = path.resolve("D:/repo-b");

  await writePublicationState({
    revision: "a".repeat(40),
    repositories: [{ root: repoA, revision: "a".repeat(40), planRevision: "plan-a" }],
  }, file);
  await writePublicationState({
    revision: "b".repeat(40),
    repositories: [{ root: repoB, revision: "b".repeat(40), planRevision: "plan-b" }],
  }, file);

  const state = await readPublicationState(file);
  assert.deepEqual(state.repositories.map((entry) => entry.root).sort(), [repoA, repoB].sort());
  assert.equal(state.repositories.find((entry) => entry.root === repoA).revision, "a".repeat(40));
  assert.equal(state.repositories.find((entry) => entry.root === repoB).revision, "b".repeat(40));
  assert.equal(state.revision, "b".repeat(40));
});

test("concurrent repository-scoped publication writes retain every root", async (t) => {
  const file = await fixture(t);
  const roots = Array.from({ length: 5 }, (_item, index) => path.resolve(`D:/repo-${index}`));

  await Promise.all(roots.map((root, index) => writePublicationState({
    repositories: [{ root, revision: String(index).repeat(40).slice(0, 40), planRevision: `plan-${index}` }],
  }, file)));

  const state = await readPublicationState(file);
  assert.equal(state.repositories.length, roots.length);
  assert.deepEqual(state.repositories.map((entry) => entry.root).sort(), roots.sort());
});

test("legacy publication record adoption requires bounded repository identity", async (t) => {
  const file = await fixture(t);
  const repo = path.resolve("D:/bookworm");
  await writeFile(file, `${JSON.stringify({
    revision: "c".repeat(40),
    release: {
      primaryRoot: repo,
      planRevision: "plan",
      manifestHash: "manifest",
      baseCommit: "base",
      preReleaseHead: "c".repeat(40),
    },
  }, null, 2)}\n`, "utf8");

  const state = await readPublicationState(file);

  assert.equal(state.repositories.length, 1);
  assert.equal(state.repositories[0].root, repo);
  assert.equal(state.repositories[0].revision, "c".repeat(40));
  assert.equal(state.repositories[0].adoptedFrom, "legacy-publication-record");
});

test("conflicting duplicate publication evidence fails closed", async (t) => {
  const file = await fixture(t);
  const repo = path.resolve("D:/repo");
  await writeFile(file, `${JSON.stringify({
    repositories: [
      { root: repo, revision: "a".repeat(40) },
      { root: repo, revision: "b".repeat(40) },
    ],
  }, null, 2)}\n`, "utf8");

  await assert.rejects(readPublicationState(file), /conflicting duplicate publication evidence/u);
});

test("nested publication evidence differences remain conflicting", async (t) => {
  const file = await fixture(t);
  const repo = path.resolve("D:/repo-nested");
  await writeFile(file, `${JSON.stringify({
    repositories: [
      { root: repo, revision: "a".repeat(40), publisher: { provider: "codex", receipt: { id: "one" } } },
      { root: repo, revision: "a".repeat(40), publisher: { provider: "codex", receipt: { id: "two" } } },
    ],
  }, null, 2)}\n`, "utf8");

  await assert.rejects(readPublicationState(file), /conflicting duplicate publication evidence/u);
});

test("publication lock is acquired before the per-file write turn", async (t) => {
  const file = await fixture(t);
  const repoA = path.resolve("D:/repo-owner");
  const repoB = path.resolve("D:/repo-outside");
  let startOutside;
  const outsideGate = new Promise((resolve) => { startOutside = resolve; });
  let outsideFinished = false;
  const outsideWrite = outsideGate.then(async () => {
    await writePublicationState({ repositories: [{ root: repoB, revision: "b".repeat(40) }] }, file);
    outsideFinished = true;
  });

  await withPublicationLock(async () => {
    startOutside();
    await wait(50);
    assert.equal(outsideFinished, false);
    await Promise.race([
      writePublicationState({ repositories: [{ root: repoA, revision: "a".repeat(40) }] }, file),
      wait(2_000).then(() => { throw new Error("nested owner write waited behind the outside writer"); }),
    ]);
    assert.equal(outsideFinished, false);
  });
  await outsideWrite;

  const state = await readPublicationState(file);
  assert.deepEqual(state.repositories.map((entry) => entry.root).sort(), [repoA, repoB].sort());
});

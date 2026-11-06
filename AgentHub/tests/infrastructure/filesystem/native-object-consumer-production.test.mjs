import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { OwnedNativeObjectStore } from "../../../src/infrastructure/filesystem/owned-native-object-store.mjs";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { preparationGitInvocation, withPreparationGitIsolation } from "../../../src/infrastructure/filesystem/preparation-git-isolation.mjs";

const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });
const hash = x => createHash("sha256").update(x).digest("hex");

test("a deep Windows native consumer serves its complete input to a real fetch child", { skip: process.platform !== "win32" }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-long-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const source = path.join(root, "source"), dataDir = path.join(root, "data");
  await mkdir(source);
  await gitAt(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "selected.txt"), "one exact native input\n");
  await gitAt(source, ["add", "."]);
  await gitAt(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", "input"]);
  const selected = await gitAt(source, ["rev-parse", "HEAD"]);
  let repository = path.join(root, "consumer");
  while (path.join(repository, ".git", "objects", "ab", "c".repeat(38)).length < 286) {
    repository = path.join(repository, "deep-native-consumer");
  }
  await mkdir(path.dirname(repository), { recursive: true });
  await withPreparationGitIsolation(dataDir, async () => {
    // Use the real preparation caller policy, including its clean Git config
    // environment. An inherited user setting must not repair this fixture.
    const producerGit = (cwd, args, options = {}) => {
      const invocation = preparationGitInvocation(args, cwd);
      return runTaskGitCommand(invocation.args, { ...options, cwd, env: invocation.env });
    };
    const objects = new OwnedNativeObjectStore({ dataDir, gitAt: producerGit });
    const identityHash = hash("deep consumer");
    const storage = await objects.provision({ sourceRoot: source, repository, inputs: [selected], identityHash });
    await objects.assertConsumer({ repository, inputs: [selected], identityHash, storage });
    await assert.rejects(readFile(path.join(repository, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
    const tree = await producerGit(repository, ["rev-parse", `${selected}^{tree}`]);
    const output = await producerGit(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid",
      "commit-tree", tree, "-p", selected], { input: "owned native output\n" });
    await producerGit(repository, ["update-ref", "refs/heads/main", output]);
    await producerGit(repository, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    const receiver = path.join(root, "receiver.git");
    await producerGit(root, ["init", "--bare", receiver]);
    // The client -c cannot replace the child server's persistent path policy.
    await producerGit(receiver, ["fetch", "--no-tags", repository, output]);
    assert.equal(await producerGit(receiver, ["rev-parse", "FETCH_HEAD"]), output);
    assert.equal(await producerGit(receiver, ["show", `${output}:selected.txt`]), "one exact native input");
    await producerGit(receiver, ["merge-base", "--is-ancestor", selected, output]);
    await producerGit(receiver, ["fsck", "--connectivity-only", "--no-dangling", output]);
    await objects.assertConsumer({ repository, inputs: [selected], identityHash, storage });
  });
});

test("new native consumer links only its input closure, preserving shared pool and original custody", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-object-producer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), dataDir = path.join(root, "data");
  await mkdir(source); await mkdir(dataDir);
  await gitAt(source, ["init", "-b", "main"]);
  const commit = async message => {
    await gitAt(source, ["add", "."]);
    await gitAt(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", message]);
    return gitAt(source, ["rev-parse", "HEAD"]);
  };
  await writeFile(path.join(source, "selected.txt"), "selected exact body\n");
  const selected = await commit("selected base");
  const objects = new OwnedNativeObjectStore({ dataDir, gitAt });
  const first = path.join(root, "first");
  const firstStorage = await objects.provision({ sourceRoot: source, repository: first,
    inputs: [selected], identityHash: hash("first") });
  // Put a different immutable history and a raw archive-like blob in this tiny
  // fixture pool. Neither is authority/input for the next selected consumer.
  await writeFile(path.join(source, "foreign.txt"), "another input's private bytes\n");
  const unrelated = await commit("unrelated history");
  await objects.provision({ sourceRoot: source, repository: path.join(root, "foreign-consumer"),
    inputs: [unrelated], identityHash: hash("foreign") });
  const loose = await gitAt(objects.repository, ["hash-object", "-w", "--stdin"], { input: "retained archive raw payload" });
  const poolBefore = await gitAt(objects.repository, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
  const second = path.join(root, "second"), secondId = hash("second");
  const storage = await objects.provision({ sourceRoot: source, repository: second,
    inputs: [selected], identityHash: secondId });
  assert.equal(await gitAt(second, ["show", `${selected}:selected.txt`]), "selected exact body");
  await gitAt(second, ["fsck", "--connectivity-only", "--no-dangling", selected]);
  await assert.rejects(gitAt(second, ["cat-file", "-e", loose]), "archive-only raw blob must not spread into a new source consumer");
  await assert.rejects(gitAt(second, ["cat-file", "-e", unrelated]), "another input pack must not spread into this consumer");
  assert.equal(await gitAt(objects.repository, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]), poolBefore);
  await objects.assertConsumer({ repository: first, identityHash: hash("first"), storage: firstStorage, inputs: [selected] });
  await objects.assertConsumer({ repository: second, identityHash: secondId, storage, inputs: [selected] });
  assert.deepEqual(await objects.provision({ sourceRoot: source, repository: second, inputs: [selected], identityHash: secondId }), storage);
  await assert.rejects(readFile(path.join(second, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  const ownPacks = (await readdir(path.join(second, ".git", "objects", "pack"))).filter(x => x.endsWith(".pack"));
  for (const file of ownPacks) {
    const [pool, consumer] = await Promise.all([
      lstat(path.join(objects.repository, "objects", "pack", file), { bigint: true }),
      lstat(path.join(second, ".git", "objects", "pack", file), { bigint: true }),
    ]);
    assert.equal(consumer.ino, pool.ino); assert.equal(consumer.dev, pool.dev);
    assert.ok(consumer.nlink >= 2n);
  }
  // An unpaired foreign pack cannot turn an incomplete new consumer into a
  // success, and clearing that fixture obstruction does not replay its intent.
  const broken = path.join(objects.repository, "objects", "pack", "pack-" + "a".repeat(40) + ".pack");
  await writeFile(broken, "partial unrelated pack");
  const failedConsumer = path.join(root, "failed"), failedId = hash("failed");
  await assert.rejects(objects.provision({ sourceRoot: source, repository: failedConsumer,
    inputs: [selected], identityHash: failedId }), /pack pair is incomplete/u);
  await rm(broken);
  await assert.rejects(objects.provision({ sourceRoot: source, repository: failedConsumer,
    inputs: [selected], identityHash: failedId }), /original recovery/u);
  await objects.assertConsumer({ repository: second, identityHash: secondId, storage, inputs: [selected] });
  t.diagnostic(JSON.stringify({ requiredCommitCount: 1, requiredPackFiles: ownPacks.length, archiveBlobPropagated: false,
    unrelatedPackPropagated: false, newlyAllocatedPackPayloads: 0, poolObjectsUnchanged: true,
    originalConsumerUnchanged: true, incompletePackRefused: true, failedOriginalNotReplayed: true }));
});

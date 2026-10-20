import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
const { createSelectedGitBundle } = await import(process.env.AGENT_HUB_SELECTED_BUNDLE_MODULE
  ? pathToFileURL(process.env.AGENT_HUB_SELECTED_BUNDLE_MODULE).href
  : "../../../src/infrastructure/filesystem/selected-git-bundle.mjs");
const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { cwd, ...options });

for (const format of ["sha1", "sha256"]) test(`selected ${format} transport includes dangling result ancestry and excludes unrelated refs/objects`, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-selected-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); await mkdir(source);
  await gitAt(source, ["init", `--object-format=${format}`, "-b", "main"]);
  const commit = async name => {
    await gitAt(source, ["add", "."]);
    await gitAt(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", name]);
    return gitAt(source, ["rev-parse", "HEAD"]);
  };
  await writeFile(path.join(source, "base"), "base data"); const base = await commit("base");
  await gitAt(source, ["checkout", "--detach"]);
  await writeFile(path.join(source, "accepted"), "accepted result"); const selected = await commit("selected");
  await gitAt(source, ["checkout", "main"]);
  await gitAt(source, ["checkout", "-b", "unrelated"]);
  await writeFile(path.join(source, "large"), Buffer.alloc(250_000, "unrelated")); const unrelated = await commit("unrelated");
  const unrelatedBlob = await gitAt(source, ["rev-parse", `${unrelated}:large`]);
  await gitAt(source, ["checkout", "main"]);
  const refs = await gitAt(source, ["show-ref"]);
  const bundle = path.join(root, "source.bundle");
  await createSelectedGitBundle({ root, sourceRoot: source, bundle, inputs: [base, selected], gitAt });
  assert.equal(await gitAt(source, ["show-ref"]), refs);
  assert.equal(await gitAt(source, ["status", "--porcelain"]), "");
  assert.equal((await readdir(root)).some(n => n.startsWith(".bundle-source-")), false);
  const clone = path.join(root, "independent");
  await gitAt(root, ["clone", "--no-local", "--no-hardlinks", "--no-checkout", bundle, clone]);
  await gitAt(clone, ["cat-file", "-e", `${base}^{commit}`]);
  await gitAt(clone, ["cat-file", "-e", `${selected}^{commit}`]);
  await assert.rejects(gitAt(clone, ["cat-file", "-e", `${unrelated}^{commit}`]));
  await assert.rejects(gitAt(clone, ["cat-file", "-e", unrelatedBlob]));
  await assert.rejects(readFile(path.join(clone, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  await assert.rejects(createSelectedGitBundle({ root, sourceRoot: source, bundle, inputs: [base], gitAt }), /original owner's recovery/u);
  await gitAt(clone, ["checkout", "--detach", selected]);
  assert.equal(await readFile(path.join(clone, "accepted"), "utf8"), "accepted result");
});

test("plain directory ABA preserves original and foreign replacement at actual Git completion", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "hub-bundle-plain-aba-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, "source"), root = path.join(base, "capture"), held = path.join(base, "held-original");
  await mkdir(source); await mkdir(root);
  const unrelated = path.join(root, ".bundle-source-foreign"); await mkdir(unrelated);
  await writeFile(path.join(unrelated, "original-evidence.txt"), "useful original data");
  await gitAt(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "text"), "owned tracked body"); await gitAt(source, ["add", "."]);
  await gitAt(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const commit = await gitAt(source, ["rev-parse", "HEAD"]);
  let foreign, originalIdentity, replacementIdentity;
  const boundary = async (cwd, args, options = {}) => {
    const result = await gitAt(cwd, args, options);
    if (args[0] === "pack-objects" || (args[0] === "bundle" && args[1] === "create")) {
      const createdPool = (await readdir(root)).find(n => n.startsWith(".bundle-source-") && n !== ".bundle-source-foreign");
      const foreignRoot = createdPool ? path.join(root, createdPool) : unrelated;
      originalIdentity = String((await lstat(foreignRoot, { bigint: true })).ino);
      await rename(foreignRoot, held); await mkdir(foreignRoot);
      replacementIdentity = String((await lstat(foreignRoot, { bigint: true })).ino);
      foreign = path.join(foreignRoot, "foreign-evidence.txt"); await writeFile(foreign, "unique replacement evidence");
    }
    return result;
  };
  let error = null;
  try { await createSelectedGitBundle({ root, sourceRoot: source, bundle: path.join(root, "source.bundle"), inputs: [commit], gitAt: boundary }); }
  catch (caught) { error = caught; }
  const foreignBytes = await readFile(foreign, "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
  assert.equal(foreignBytes, "unique replacement evidence");
  assert.notEqual(originalIdentity, replacementIdentity);
  assert.equal(error, null, error?.stack);
  await gitAt(source, ["bundle", "verify", path.join(root, "source.bundle")]);
});

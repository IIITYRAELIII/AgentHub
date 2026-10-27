import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, unlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectCodexExecutableBundle, validCodexBundle } from "../../../src/infrastructure/process/codex-executable-bundle.mjs";

test("effective code-mode feature requires its own trusted helper, independent of unchanged version/main bytes", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub348-inspection-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "codex.exe"), helper = path.join(root, "codex-code-mode-host.exe");
  await writeFile(executable, "fixture-main");
  const hashFile = async file => createHash("sha256").update(await readFile(file)).digest("hex").toUpperCase();
  const candidate = { path: executable, sha256: await hashFile(executable), publisher: "OpenAI", version: "same-version" };
  let enabled = true, signatureValid = true, seenArgs;
  const options = { hashFile, installRoot: root, executableArgs: ["--enable", "code_mode_host"],
    readFeatures: async (_path, args) => { seenArgs = args.executableArgs; return { codeModeHost: enabled }; },
    verifySignature: async () => ({ valid: signatureValid, publisher: "OpenAI" }) };
  await assert.rejects(inspectCodexExecutableBundle(candidate, options), { code: "CODEX_BUNDLE_UNAVAILABLE" });
  await writeFile(helper, "helper-A");
  const original = await inspectCodexExecutableBundle(candidate, options);
  assert.equal(validCodexBundle(original), true);
  assert.deepEqual(seenArgs, options.executableArgs);
  await writeFile(helper, "helper-B");
  const changed = await inspectCodexExecutableBundle(candidate, options);
  assert.notEqual(original.digest, changed.digest);
  assert.equal(candidate.sha256, await hashFile(executable));
  signatureValid = false;
  await assert.rejects(inspectCodexExecutableBundle(candidate, options), /signature/u);
  await unlink(helper); enabled = false;
  assert.equal((await inspectCodexExecutableBundle(candidate, options)).codeModeHost, false);
});

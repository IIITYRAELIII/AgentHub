import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildWindowsRuntimeHost, runtimeHostCompilerCandidates } from "../helpers/external-runtime-builder.fixture.mjs";

const execute = promisify(execFile);

test("native package retirement proves stopped members with held references and bounded exact Job force", {
  skip: process.platform !== "win32", timeout: 60000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub429-package-retirement-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const source = path.resolve(import.meta.dirname, "../..");
  const host = path.join(root, "AgentHub.RuntimeHost.exe"), driver = path.join(root, "probe.exe");
  await buildWindowsRuntimeHost({ sourceRoot: source, outputFile: host });
  await execute(runtimeHostCompilerCandidates()[0], ["/nologo", "/target:exe", `/out:${driver}`,
    "/reference:System.dll", "/reference:System.Web.Extensions.dll",
    path.join(source, "tests/fixtures/runtime-package-retirement.cs")], { windowsHide: true });
  for (const mode of ["held-references", "forced", "denied", "foreign"]) await t.test(mode, async () => {
    const result = await execute(driver, [host, process.execPath, mode], { windowsHide: true, timeout: 15000 });
    assert.equal(result.stderr, "");
    const proof = JSON.parse(result.stdout);
    t.diagnostic(JSON.stringify({ mode, ...proof }));
    assert.equal(proof.liveRefused, true);
    assert.equal(proof.heldReferencesValid, true);
    assert.equal(proof.foreignAlive, true);
    assert.equal(proof.nullJobRefused, true);
    if (mode === "held-references" || mode === "forced") {
      assert.equal(proof.stoppedProof, true);
      assert.equal(proof.nodeExited, true);
      assert.equal(proof.hostExited, true);
      assert.equal(proof.forcedAdmissions, mode === "forced" ? 1 : 0);
    } else {
      assert.equal(proof.stoppedProof, false);
      assert.equal(proof.nodeExited, false);
      assert.equal(proof.hostExited, false);
      assert.equal(proof.forcedAdmissions, mode === "denied" ? 1 : 0);
    }
  });
});

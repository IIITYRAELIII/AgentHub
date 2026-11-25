import assert from "node:assert/strict";
import test from "node:test";
import { waitForPackageReplacement } from "../../src/runtime/runtime-package-handoff.mjs";
import { packageBindingDigest } from "../../src/infrastructure/filesystem/runtime-package-target.mjs";

function fixture() {
  const binding = { operationId: "slow-original", dataDir: "unused", runtimeRoot: "unused",
    old: { pid: 1 }, target: { releaseId: "replacement" } };
  const current = { operationId: binding.operationId, kind: "restart", metadata: {
    packageHandoff: { schema: 1, binding, sha256: packageBindingDigest(binding) },
  } };
  return { binding, current, store: { getReadonly: () => structuredClone(current) } };
}

test("Host verification and Node Ready have separate original-bound observation budgets", async () => {
  const f = fixture();
  let clock = 0, probes = 0;
  const result = await waitForPackageReplacement({ ...f, replacement: { pid: 20 }, now: () => clock,
    wait: async milliseconds => {
      clock += milliseconds;
      if (clock >= 45_000) f.current.metadata.packageLaunchAdmission = { hostPid: 20, hostStarted: "123" };
    },
    waitLock: async input => {
      assert.equal(clock, 45_000);
      assert.equal(input.timeoutMs, 120_000);
      assert.equal(input.expectedOperationId, f.binding.operationId);
      clock += 100_000;
      return { pid: 21, instanceToken: "exact-instance" };
    }, verifyReady: async input => { probes++; assert.equal(input.expectedReleaseId, "replacement"); },
  });
  assert.equal(clock, 145_000);
  assert.equal(probes, 1);
  assert.equal(result.pid, 21);
});

test("unobserved admission remains unknown and a late SAME receipt can be read without launch", async () => {
  const f = fixture(); let clock = 0, ready = 0;
  const options = { ...f, replacement: { pid: 20 }, now: () => clock,
    admissionTimeoutMs: 100, wait: async ms => { clock += ms; },
    waitLock: async () => { ready++; return { pid: 21, instanceToken: "same" }; }, verifyReady: async () => {} };
  await assert.rejects(waitForPackageReplacement(options), /admission is unknown/u);
  assert.equal(ready, 0);
  f.current.metadata.packageLaunchAdmission = { hostPid: 20, hostStarted: "123" };
  assert.equal((await waitForPackageReplacement(options)).pid, 21);
  assert.equal(ready, 1);
});

test("foreign Host, changed original and drift during Ready refuse", async t => {
  for (const fault of ["foreign-host", "changed-original", "admission-drift"]) await t.test(fault, async () => {
    const f = fixture();
    f.current.metadata.packageLaunchAdmission = { hostPid: fault === "foreign-host" ? 99 : 20, hostStarted: "123" };
    if (fault === "changed-original") f.current.metadata.packageHandoff.binding.target.releaseId = "foreign";
    await assert.rejects(waitForPackageReplacement({ ...f, binding: structuredClone({ ...f.binding,
      target: { releaseId: "replacement" } }), replacement: { pid: 20 },
      waitLock: async () => ({ pid: 21, instanceToken: "same" }), verifyReady: async () => {
        if (fault === "admission-drift") f.current.metadata.packageLaunchAdmission.hostStarted = "456";
      } }), /binding changed|exact admitted|admission changed/u);
  });
});

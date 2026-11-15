import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MaintenanceOperationStore } from "../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { RestartRequestService } from "../../src/application/restart-request-service.mjs";
import { packageRestartInput, startPackageBootstrap } from "../../src/runtime/runtime-package-handoff.mjs";
import { packageBindingDigest } from "../../src/infrastructure/filesystem/runtime-package-target.mjs";

test("definitive failed package original remains readback-only through service and retained bootstrap after current drift", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "hb398-terminal-"));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(base, "runtime"), packageRoot = path.join(base, "package"), dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true }); await mkdir(path.join(packageRoot, "runtime"), { recursive: true });
  const input = packageRestartInput({ operationId: "same-original", tag: "2.1.3",
    archive: path.join(base, "release.zip"), descriptor: path.join(base, "release.json"), installer: path.join(base, "install.py") });
  const store = new MaintenanceOperationStore({ dataDir });
  const binding = { operationId: input.operationId, runtimeRoot: root, old: { releaseId: "prior-instance" } };
  const prior = store.create({ operationId: input.operationId, kind: "restart", streamId: "agent-hub-runtime",
    threadId: "agent-hub-runtime", status: "failed", phase: "failed", outcome: "failed",
    metadata: { packageInputSha256: packageBindingDigest(input), error: "ENOENT preflight fixture",
      packageHandoff: { schema: 1, binding, sha256: packageBindingDigest(binding) } } });
  await writeFile(path.join(root, "current.json"), '{"current":"later-reviewed-runtime"}');
  const forbidden = () => assert.fail("terminal readback must not prepare/project/save/schedule/launch");
  const service = new RestartRequestService({ operationStore: store, currentTarget: () => ({}),
    preparePackage: forbidden, setRequest: forbidden, saveState: forbidden, scheduleRestart: forbidden });
  assert.deepEqual(await service.fromPackage(input), { accepted: false, operationId: input.operationId, status: "failed", phase: "failed" });
  await assert.rejects(service.fromPackage({ ...input, tag: "2.1.4" }), /input changed/u);
  const bootstrapFile = path.join(base, "update-request.json");
  await writeFile(bootstrapFile, JSON.stringify({ schema: 1, runtimeRoot: root, packageRoot, ...input }));
  assert.deepEqual(await startPackageBootstrap(bootstrapFile, { control: forbidden, spawnImpl: forbidden,
    readMetadata: forbidden, confirmManualStop: forbidden }), {
    operationId: input.operationId, status: "failed", phase: "failed", effectsReplayed: false,
  });
  const transition = store.transition(input.operationId, { status: "requested", phase: "requested" }, { expectedRevision: prior.revision });
  assert.equal(transition.applied, false); assert.equal(transition.reason, "terminal");
  assert.deepEqual(store.getReadonly(input.operationId), prior);
});

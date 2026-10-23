import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { preparationEnvelope } from "../helpers/release-preparation-envelope.mjs";
import { readPreparationSourceClosure, validatePreparationEnvelope } from "../../src/application/release-preparation-admission.mjs";
import { localSourceSelectionHash } from "../../src/domain/release-base-provenance.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";
import { validatePreparationForward, inspectPreparationForwardCustody } from "../../src/application/release-preparation-forward.mjs";

test("preparation-only local source binding is exact and keeps native review bounded", () => {
  const value = preparationEnvelope();
  const repository = value.repositories[0];
  repository.approvedBaseCommit = "c".repeat(40);
  repository.localSourceBaseline = { schemaVersion: 1, kind: "installed-local-source-v1",
    publishedBaseCommit: repository.publishedRevision, agreedMainCommit: repository.primaryMainCommit,
    sourceBaseCommit: repository.approvedBaseCommit, sourceBaseTree: "b".repeat(40),
    sourcePatchSha256: "d".repeat(64), installedReleaseId: "installed-repair",
    installedManifestSha256: "e".repeat(64), planRevision: value.planRevision,
    selectionHash: localSourceSelectionHash(value.tasks) };
  repository.originMainCommit = repository.publishedRevision;
  repository.nativeResolutionReview = { requestId: "exact-review", text: "Exact independently authenticated verdict" };
  assert.deepEqual(validatePreparationEnvelope(value), value);
  for (const mutate of [
    v => { v.repositories[0].localSourceBaseline.skipIntegrity = true; },
    v => { v.repositories[0].localSourceBaseline.sourceBaseCommit = "a".repeat(40); },
    v => { v.repositories[0].localSourceBaseline.planRevision = "changed"; },
    v => { v.repositories[0].originMainCommit = "a".repeat(40); },
    v => { v.repositories[0].nativeResolutionReview.approved = true; },
  ]) {
    const changed = structuredClone(value); mutate(changed);
    assert.throws(() => validatePreparationEnvelope(changed), { code: "RELEASE_PREPARATION_REJECTED" });
  }
});

test("preparation-only input requires exact bounded sets and no publication/selection arguments", () => {
  const value = preparationEnvelope();
  assert.deepEqual(validatePreparationEnvelope(value), value);
  for (const mutation of [
    (v) => { v.publish = true; }, (v) => { v.tasks.push(v.tasks[0]); },
    (v) => { delete v.repositories[0].approvedTree; },
    (v) => { v.tasks[0].rowRevision = -1; },
  ]) {
    const changed = structuredClone(value);
    mutation(changed);
    assert.throws(() => validatePreparationEnvelope(changed), { code: "RELEASE_PREPARATION_REJECTED" });
  }
});

test("forward preparation binds old arguments and cannot expand selection or publication", async () => {
  const originalPreparation = preparationEnvelope(), requestId = "original";
  const record = { requestId, toolName: "hub_release_prepare", operationStatus: "pending", receiptState: "unknown", status: "unknown",
    argumentsHash: mcpArgumentsHash({ request_id: requestId, preparation: originalPreparation }) };
  const check = preparation => validatePreparationForward({ record, originalPreparation, preparation, requestId });
  assert.deepEqual(check(originalPreparation).original, originalPreparation);
  const current = structuredClone(originalPreparation); current.tasks[0].rowRevision++;
  current.sourceCommit = "e".repeat(40); current.sourceTree = "f".repeat(40); current.sourceClosureHash = "a".repeat(64);
  assert.deepEqual(check(current).current, current);
  for (const change of [v => { v.tasks[0].resultCommit = "9".repeat(40); },
    v => { v.tasks[0].taskRevision++; }, v => { v.publicationHash = "e".repeat(64); },
    v => { v.repositories[0].publishedRevision = "e".repeat(40); }]) {
    const value = structuredClone(current); change(value); assert.throws(() => check(value), /selection or publication/u);
  }
  const request = { requestId, argumentsHash: record.argumentsHash, originalPreparation };
  await assert.rejects(inspectPreparationForwardCustody(null, request), /unavailable/u);
  await assert.rejects(inspectPreparationForwardCustody(async () => ({ kind: "missing-job", joinedInvocation: true }), request), /not proved/u);
});

test("preparation-only runtime closure detects added/changed source and excludes documentation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-preparation-closure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "owner.mjs"), "export const owner=1;");
  const first = await readPreparationSourceClosure(root);
  await writeFile(path.join(root, "REPORT.md"), "notes");
  assert.deepEqual(await readPreparationSourceClosure(root), first);
  await writeFile(path.join(root, "src", "owner.mjs"), "export const owner=2;");
  assert.notEqual((await readPreparationSourceClosure(root)).hash, first.hash);
  await symlink(path.join(root, "src"), path.join(root, "src", "link"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readPreparationSourceClosure(root), /link/);
});


test("forward isolated-effects evidence is distinct from terminal proof and binds the owner target plan", async () => {
  const request = { requestId: "original", argumentsHash: "a".repeat(64),
    originalPreparation: { sourceClosureHash: "b".repeat(64) }, isolationPlan: { writeTargetsHash: "c".repeat(64) } };
  const proof = { kind: "preparation-effects-isolated-v1", requestId: request.requestId,
    argumentsHash: request.argumentsHash, originalSourceClosureHash: request.originalPreparation.sourceClosureHash,
    isolationEvidenceSha256: "d".repeat(64), authorizationSha256: "e".repeat(64),
    legacyInvocationTerminal: true, writeTargetsHash: request.isolationPlan.writeTargetsHash };
  assert.deepEqual(await inspectPreparationForwardCustody(async () => proof, request), proof);
  for (const change of [{ joinedChildren: true }, { legacyInvocationTerminal: false }, { writeTargetsHash: "f".repeat(64) },
    { authorizationSha256: "" }, { argumentsHash: "f".repeat(64) }]) {
    await assert.rejects(inspectPreparationForwardCustody(async () => ({ ...proof, ...change }), request), /not proved/u);
  }
  await assert.rejects(inspectPreparationForwardCustody(proof, request), /unavailable/u);
  await assert.rejects(inspectPreparationForwardCustody(async () => ({ ...proof, kind: "preparation-invocation-terminal-v1" }), request), /not proved/u);
});

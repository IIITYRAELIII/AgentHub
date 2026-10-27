import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { partialOwnGitPublication } from "../../fixtures/own-git-publication-fixture.mjs";

test("OWN Git publication read requires exact validated generation and admitted target, never runtime success", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "own-git-fact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pins = { dataDir: root, repositoryRoot: path.join(root, "repo"), localMainCommit: "1".repeat(40),
    publishedRevision: "2".repeat(40), sourceBaseCommit: "3".repeat(40), commit: "4".repeat(40), tree: "5".repeat(40) };
  const f = partialOwnGitPublication(pins);
  const input = { repositoryRoot: pins.repositoryRoot, localMainCommit: pins.localMainCommit,
    publishedRevision: pins.publishedRevision, originCommit: pins.commit, taskIds: ["selected"] };
  const rows = f.rows(), proof = f.read(input);
  assert.equal(proof.operationId, f.operationId);
  assert.equal(proof.commit, pins.commit);
  assert.equal(proof.tree, pins.tree);
  assert.equal(f.store.get(f.operationId).state, "waiting");
  assert.equal(f.store.latestStep(f.operationId, 1, "publish:production").status, "failed");
  assert.equal(f.rows(), rows, "fact read cannot settle partial publication");
  for (const altered of [{ repositoryRoot: path.join(root, "foreign") }, { localMainCommit: "a".repeat(40) },
    { publishedRevision: "b".repeat(40) }, { originCommit: "c".repeat(40) }, { taskIds: ["foreign"] }]) {
    assert.equal(f.read({ ...input, ...altered }), null);
  }
  const saved = f.database(db => ({ op: db.prepare("SELECT operation_json FROM release_operations").get().operation_json,
    gen: db.prepare("SELECT generation_json FROM release_candidate_generations").get().generation_json,
    validate: db.prepare("SELECT receipt_json FROM release_step_receipts WHERE step_id='validate'").get().receipt_json }));
  try {
    f.database(db => db.prepare("UPDATE release_step_receipts SET step_id='hidden-validate' WHERE step_id='validate'").run());
    assert.equal(f.read(input), null);
  } finally { f.database(db => db.prepare("UPDATE release_step_receipts SET step_id='validate' WHERE step_id='hidden-validate'").run()); }
  try {
    f.database(db => db.prepare("UPDATE release_step_receipts SET step_id='hidden-publish' WHERE step_id='publish:production'").run());
    assert.equal(f.read(input), null);
  } finally { f.database(db => db.prepare("UPDATE release_step_receipts SET step_id='publish:production' WHERE step_id='hidden-publish'").run()); }
  try {
    const receipt = { ...JSON.parse(saved.validate), inputSha256: "0".repeat(64) };
    f.database(db => db.prepare("UPDATE release_step_receipts SET receipt_json=? WHERE step_id='validate'").run(JSON.stringify(receipt)));
    assert.equal(f.read(input), null);
  } finally { f.database(db => db.prepare("UPDATE release_step_receipts SET receipt_json=? WHERE step_id='validate'").run(saved.validate)); }
  try {
    const changed = JSON.parse(saved.gen); changed.candidates[0].tree = "e".repeat(40);
    f.database(db => db.prepare("UPDATE release_candidate_generations SET generation_json=?").run(JSON.stringify(changed)));
    assert.throws(() => f.read(input), /generation changed/u);
  } finally { f.database(db => db.prepare("UPDATE release_candidate_generations SET generation_json=?").run(saved.gen)); }
  try {
    const changed = JSON.parse(saved.op); changed.authorization.taskIds = ["foreign"];
    f.database(db => db.prepare("UPDATE release_operations SET operation_json=?").run(JSON.stringify(changed)));
    assert.throws(() => f.read(input), /authorization changed/u);
  } finally { f.database(db => db.prepare("UPDATE release_operations SET operation_json=?").run(saved.op)); }
  assert.deepEqual(f.read(input), proof);
  assert.equal(f.rows(), rows);
  partialOwnGitPublication({ ...pins, operationId: "another-admitted-owner" });
  assert.throws(() => f.read(input), /ambiguous/u);
});

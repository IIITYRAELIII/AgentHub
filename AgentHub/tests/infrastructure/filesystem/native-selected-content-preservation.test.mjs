import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runTaskGitCommand, TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { taskGitIdentityHash } from "../../../src/domain/task-git-reference.mjs";
import { assertNativePreparedComposition, mergeSelectedResults, NATIVE_RELEASE_POLICY }
  from "../../../src/infrastructure/filesystem/native-release-merge.mjs";

const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });
const readJson = async file => JSON.parse(await readFile(file, "utf8").catch(error => {
  if (error.code === "ENOENT") return "null";
  throw error;
}));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value), "utf8");
async function commit(root, message) {
  await gitAt(root, ["add", "."]);
  await gitAt(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message]);
  return gitAt(root, ["rev-parse", "HEAD"]);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-content-preservation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source"); await mkdir(sourceRoot);
  await gitAt(sourceRoot, ["init", "--initial-branch=main"]);
  await writeFile(path.join(sourceRoot, "selection.txt"), "old selected\n");
  const base = await commit(sourceRoot, "main");
  const create = async (name, body, from = base) => {
    await gitAt(sourceRoot, ["checkout", "--detach", from]);
    await writeFile(path.join(sourceRoot, "selection.txt"), body);
    return commit(sourceRoot, name);
  };
  const compose = (baseCommit, tasks, options = {}, folder = "capture") => mergeSelectedResults({
    root: path.join(root, folder), sourceRoot, baseCommit, tasks,
    identity: { policy: NATIVE_RELEASE_POLICY, baseCommit, tasks },
    gitAt, readJson, writeJson, ...options,
  });
  return { root, sourceRoot, base, create, compose };
}

test("an ancestor result cannot silently lose its selected content", async t => {
  const f = await fixture(t);
  const result = await f.create("accepted result", "new head\n");
  const regressed = await f.create("later whole-file rollback", "old selected\n", result);
  assert.equal(await gitAt(f.sourceRoot, ["merge-base", "--is-ancestor", result, regressed]), "");
  await assert.rejects(f.compose(regressed, [{ taskId: "selected", baseCommit: f.base, resultCommit: result }]),
    error => error.code === "RELEASE_SELECTED_CONTENT_MISSING" && error.missingPaths.includes("selection.txt"));
  assert.equal(await gitAt(f.sourceRoot, ["rev-parse", "HEAD"]), regressed);
  assert.equal(await gitAt(f.sourceRoot, ["show-ref", "--heads"]), `${f.base} refs/heads/main`);
});

test("canonical preparation refuses missing selected content before promotion and callback", async t => {
  const f = await fixture(t);
  const result = await f.create("accepted result", "new head\n");
  const regressed = await f.create("later rollback", "old selected\n", result);
  await gitAt(f.sourceRoot, ["branch", "-f", "main", regressed]);
  await gitAt(f.sourceRoot, ["checkout", "main"]);
  const origin = path.join(f.root, "origin.git");
  await gitAt(f.root, ["init", "--bare", "--initial-branch=main", origin]);
  await gitAt(f.sourceRoot, ["remote", "add", "origin", origin]);
  await gitAt(f.sourceRoot, ["push", "origin", "main"]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "release-data"),
    environment: { ...process.env, LOCALAPPDATA: path.join(f.root, "state"), XDG_STATE_HOME: path.join(f.root, "state") } });
  const task = { taskId: "selected", taskRevision: 1, baseCommit: f.base, resultCommit: result };
  let callbacks = 0;
  await assert.rejects(service.prepareCandidate({ projectRoot: f.sourceRoot, workspaceId: "fixture",
    planRevision: "missing-content", approvedBaseCommit: regressed, frozenTasks: [task],
    commitPrepared: async () => { callbacks++; } }), error => error.code === "RELEASE_PREPARATION_REJECTED"
      && error.cause.code === "RELEASE_SELECTED_CONTENT_MISSING"
      && error.selectedContentMissing.missingPaths.includes("selection.txt"));
  assert.equal(callbacks, 0);
  assert.equal(await service.frozenCandidate(f.sourceRoot, { allowAbsent: true }), null);
  assert.equal(await gitAt(f.sourceRoot, ["rev-parse", "HEAD"]), regressed);
  assert.equal(await gitAt(f.sourceRoot, ["status", "--porcelain=v1"]), "");
});

test("native Test combines independent Task bases without treating prior dev content as a deletion", async t => {
  const f = await fixture(t);
  const service = new TaskGitWorkspaceService({ dataDir: path.join(f.root, "task-data"),
    readPublication: async () => null });
  const firstId = "11111111-1111-4111-8111-111111111111";
  const secondId = "22222222-2222-4222-8222-222222222222";
  const first = await service.prepare({ taskId: firstId, projectRoot: f.sourceRoot });
  const second = await service.prepare({ taskId: secondId, projectRoot: f.sourceRoot });
  assert.equal(first.baseCommit, f.base);
  assert.equal(second.baseCommit, f.base);
  await writeFile(path.join(first.projectRoot, "first.txt"), "first independent result\n");
  await commit(first.projectRoot, "first Task result");
  await service.snapshotAndMerge({ taskId: firstId, projectRoot: first.projectRoot });
  await writeFile(path.join(second.projectRoot, "second.txt"), "second independent result\n");
  await commit(second.projectRoot, "second Task result");
  await assert.rejects(gitAt(second.projectRoot, ["cat-file", "-e", "HEAD:first.txt"]));
  await service.snapshotAndMerge({ taskId: secondId, projectRoot: second.projectRoot });
  assert.equal(await gitAt(f.sourceRoot, ["show", "dev:first.txt"]), "first independent result");
  assert.equal(await gitAt(f.sourceRoot, ["show", "dev:second.txt"]), "second independent result");
  assert.equal(await gitAt(f.sourceRoot, ["rev-parse", "main"]), f.base);
});

test("preserved selected code coexists with later unrelated changes", async t => {
  const f = await fixture(t);
  const result = await f.create("accepted result", "new head\n");
  await writeFile(path.join(f.sourceRoot, "later.txt"), "keep this\n");
  const later = await commit(f.sourceRoot, "unrelated later content");
  const tasks = [{ taskId: "selected", baseCommit: f.base, resultCommit: result }];
  const value = await f.compose(later, tasks);
  assert.equal(value.head, later);
  assert.equal(await gitAt(value.root, ["show", "HEAD:later.txt"]), "keep this");
  await assertNativePreparedComposition({ git: (args, options) => gitAt(value.root, args, options),
    baseCommit: later, tasks, merges: value.merges, head: value.head, tree: value.tree });
});

test("a later selected result may restore an earlier contained regression", async t => {
  const f = await fixture(t);
  const accepted = await f.create("accepted result", "new head\n");
  const regressed = await f.create("rollback", "old selected\n", accepted);
  const corrected = await f.create("own corrected result", "new head\n", regressed);
  const value = await f.compose(regressed, [
    { taskId: "original", baseCommit: f.base, resultCommit: accepted },
    { taskId: "correction", baseCommit: f.base, resultCommit: corrected },
  ]);
  assert.equal(await gitAt(value.root, ["show", "HEAD:selection.txt"]), "new head");
});

test("completed legacy journal is checked again rather than trusted", async t => {
  const f = await fixture(t);
  const result = await f.create("accepted result", "new head\n");
  const regressed = await f.create("rollback", "old selected\n", result);
  const tasks = [{ taskId: "selected", baseCommit: f.base, resultCommit: result }];
  await assert.rejects(f.compose(regressed, tasks), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
  const state = await readJson(path.join(f.root, "capture", "merge.json"));
  assert.equal(state.next, 1); assert.equal(state.merges[0].contained, true);
  await assert.rejects(f.compose(regressed, tasks), { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

test("lost selected deletion is not mistaken for already integrated history", async t => {
  const f = await fixture(t);
  await rm(path.join(f.sourceRoot, "selection.txt"));
  const result = await commit(f.sourceRoot, "accepted deletion");
  const regressed = await f.create("accidental resurrection", "old selected\n", result);
  await assert.rejects(f.compose(regressed, [{ taskId: "selected", baseCommit: f.base, resultCommit: result }]),
    { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

test("lost selected mode is checked with content", async t => {
  const f = await fixture(t);
  await gitAt(f.sourceRoot, ["update-index", "--chmod=+x", "selection.txt"]);
  await gitAt(f.sourceRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "accepted mode"]);
  const result = await gitAt(f.sourceRoot, ["rev-parse", "HEAD"]);
  await gitAt(f.sourceRoot, ["update-index", "--chmod=-x", "selection.txt"]);
  await gitAt(f.sourceRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "rollback mode"]);
  const regressed = await gitAt(f.sourceRoot, ["rev-parse", "HEAD"]);
  await assert.rejects(f.compose(regressed, [{ taskId: "selected", baseCommit: f.base, resultCommit: result }]),
    { code: "RELEASE_SELECTED_CONTENT_MISSING" });
});

test("a real conflict does not hide lost clean lines elsewhere in its file", async t => {
  const f = await fixture(t);
  const original = "old\n" + "context\n".repeat(12) + "shared old\n";
  const selected = "accepted\n" + "context\n".repeat(12) + "shared accepted\n";
  await writeFile(path.join(f.sourceRoot, "selection.txt"), original);
  const taskBase = await commit(f.sourceRoot, "larger main");
  const result = await f.create("accepted separate changes", selected, taskBase);
  const regressed = await f.create("rollback clean line and alter shared area", "old\n" + "context\n".repeat(12) + "shared later\n", result);
  await assert.rejects(f.compose(regressed, [{ taskId: "selected", baseCommit: taskBase, resultCommit: result }]),
    error => error.code === "RELEASE_SELECTED_CONTENT_MISSING" && error.missingPaths.includes("selection.txt"));
});

test("whole conflicted file replacement cannot discard clean merged changes", async t => {
  const f = await fixture(t);
  const middle = "context\n".repeat(12);
  const body = (header, shared, footer) => `${header}\n${middle}${shared}\n${middle}${footer}\n`;
  await writeFile(path.join(f.sourceRoot, "selection.txt"), body("header old", "shared old", "footer old"));
  const base = await commit(f.sourceRoot, "conflict main");
  const a = await f.create("A", body("header A", "shared A", "footer old"), base);
  const b = await f.create("B", body("header old", "shared B", "footer B"), base);
  const tasks = [{ taskId: "A", baseCommit: base, resultCommit: a }, { taskId: "B", baseCommit: base, resultCommit: b }];
  let capture;
  await assert.rejects(f.compose(base, tasks), error => {
    assert.equal(error.code, "RELEASE_NATIVE_MERGE_CONFLICT"); capture = error.conflictRoot; return true;
  });
  await writeFile(path.join(capture, "selection.txt"), body("header old", "shared B", "footer B"));
  await commit(capture, "incorrect whole-file side choice");
  await assert.rejects(f.compose(base, tasks), error => error.code === "RELEASE_NATIVE_REVIEW_REQUIRED"
    && error.extraPaths.includes("selection.txt"));
  await writeFile(path.join(capture, "selection.txt"), body("header A", "shared A+B", "footer B"));
  await gitAt(capture, ["add", "."]);
  await gitAt(capture, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit"]);
  const correct = await f.compose(base, tasks);
  assert.equal(await gitAt(correct.root, ["show", "HEAD:selection.txt"]), body("header A", "shared A+B", "footer B").trim());
});

test("exact authenticated compatibility cleanup remains valid", async t => {
  const f = await fixture(t);
  const original = "// top\n\n// middle\n\n// end\n";
  await writeFile(path.join(f.sourceRoot, "selection.txt"), original);
  const base = await commit(f.sourceRoot, "compat main");
  const a = await f.create("A", "// top\nfunction check() {}\n// middle\n\n// end\n", base);
  const b = await f.create("B", "// top\n\n// middle\nfunction check() {}\n// end\n", base);
  const tasks = [{ taskId: "A", baseCommit: base, resultCommit: a }, { taskId: "B", baseCommit: base, resultCommit: b }];
  const automatic = await f.compose(base, tasks);
  await writeFile(path.join(automatic.root, "selection.txt"), "// top\nfunction check() {}\n// middle\n\n// end\n");
  await gitAt(automatic.root, ["add", "."]);
  await gitAt(automatic.root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit"]);
  const target = await gitAt(automatic.root, ["rev-parse", "HEAD"]);
  const identity = { policy: NATIVE_RELEASE_POLICY, baseCommit: base, tasks };
  const binding = { identityHash: taskGitIdentityHash(identity),
    parents: (await gitAt(automatic.root, ["show", "-s", "--format=%P", target])).split(" "),
    commit: target, tree: await gitAt(automatic.root, ["rev-parse", "HEAD^{tree}"]), automaticTree: automatic.tree,
    diffSha256: createHash("sha256").update(await gitAt(automatic.root,
      ["diff", "--binary", "--full-index", "--no-renames", automatic.tree, "HEAD^{tree}"], { rawOutput: true })).digest("hex") };
  const review = { requestId: "independent", text: `<native-merge-review>${JSON.stringify({kind:"native-merge-review-v1",verdict:"ACCEPT",binding})}</native-merge-review>` };
  let verified = 0;
  const verifyReview = async (input, actual) => { assert.deepEqual(input, review); assert.deepEqual(actual, binding); verified++; };
  const value = await f.compose(base, tasks, { resolutionReview: review, verifyReview });
  assert.equal(value.head, target); assert.ok(verified > 0);
  await assertNativePreparedComposition({ git: (args, options) => gitAt(value.root, args, options),
    baseCommit: base, tasks, merges: value.merges, head: target, tree: binding.tree, identity, verifyReview });
});

test("exact signed replay obligations preserve automatic context without widening v1 authority", async t => {
  const f=await fixture(t);
  for(const file of ["registry.txt","context2.txt","context3.txt"]) await writeFile(path.join(f.sourceRoot,file),"base\n");
  const taskBase=await commit(f.sourceRoot,"complete Task base");
  await f.create("dependency context","dependency\n",taskBase);
  for(const file of ["context2.txt","context3.txt"]) await writeFile(path.join(f.sourceRoot,file),"dependency\n");
  const dependency=await commit(f.sourceRoot,"inherited dependency context");
  await f.create("independent dev restoration","old selected\n",dependency);
  for(const file of ["context2.txt","context3.txt"]) await writeFile(path.join(f.sourceRoot,file),"base\n");
  await writeFile(path.join(f.sourceRoot,"registry.txt"),"dev\n");
  const dev=await commit(f.sourceRoot,"dev registry and context");
  await gitAt(f.sourceRoot,["checkout","--detach",dependency]);
  await writeFile(path.join(f.sourceRoot,"feature.txt"),"own feature\n");
  await writeFile(path.join(f.sourceRoot,"registry.txt"),"selected\n");
  const result=await commit(f.sourceRoot,"own feature and registry");
  const tasks=[{taskId:"selected",baseCommit:taskBase,resultCommit:result}];
  let repository;
  await assert.rejects(f.compose(dev,tasks),error=>{
    assert.equal(error.code,"RELEASE_NATIVE_MERGE_CONFLICT");repository=error.conflictRoot;return true;
  });
  await writeFile(path.join(repository,"registry.txt"),"dev+selected\n");
  const head=await commit(repository,"exact registry union");
  const tree=await gitAt(repository,["rev-parse","HEAD^{tree}"]);
  const automaticTree=(await gitAt(repository,["merge-tree","--write-tree","--name-only","-z",dev,result],
    {acceptableExitCodes:[1]})).split("\0")[0];
  const identity={policy:NATIVE_RELEASE_POLICY,baseCommit:dev,tasks};
  const binding={identityHash:taskGitIdentityHash(identity),parents:[dev,result],commit:head,tree,automaticTree,
    diffSha256:createHash("sha256").update(await gitAt(repository,["diff","--binary","--full-index","--no-renames",automaticTree,tree],
      {rawOutput:true})).digest("hex")};
  const text=capability=>`<native-merge-review>${JSON.stringify({kind:"native-merge-review-v1",verdict:"ACCEPT",binding,
    ...(capability?{selectedContentCompatibility:capability}:{})})}</native-merge-review>`;
  const v1={requestId:"independent-v1",text:text(null)};
  const authenticated=new Set([v1.text]);
  const verifyReview=async(input,actual)=>{assert.ok(authenticated.has(input.text),"whole review must be authenticated");assert.deepEqual(actual,binding);};
  let derived;
  await assert.rejects(f.compose(dev,tasks,{resolutionReview:v1,verifyReview}),error=>{
    assert.equal(error.code,"RELEASE_SELECTED_CONTENT_MISSING");derived=error.selectedContentCompatibilityBinding;return true;
  });
  assert.ok(derived,"the owner exposes complete derived replay obligations");
  assert.equal(derived.kind,"selected-content-compatibility-v1");
  assert.deepEqual(derived.selectedTasks,tasks);
  assert.deepEqual(derived.obligations.map(row=>row.path),["context2.txt","context3.txt","selection.txt"]);
  for(const row of derived.obligations){assert.equal(row.retainedEntry,row.automaticEntry);assert.notEqual(row.expectedEntry,row.retainedEntry);
    assert.equal(row.prefixCommit,dev);assert.equal(row.automaticTree,automaticTree);assert.match(row.replayTree,/^[a-f0-9]{40}$/u);}
  const before=await readJson(path.join(f.root,"capture","merge.json"));
  const partial={requestId:"independent-partial",text:text({binding:derived,acceptedObligations:[0,1]})};
  authenticated.add(partial.text);
  await assert.rejects(f.compose(dev,tasks,{resolutionReview:partial,verifyReview}),error=>
    error.code==="RELEASE_SELECTED_CONTENT_MISSING"&&error.missingPaths.includes("selection.txt"));
  assert.deepEqual(await readJson(path.join(f.root,"capture","merge.json")),before,"failed partial proof cannot replace the capture");
  const capability={binding:derived,acceptedObligations:[0,1,2]};
  const approval={requestId:"independent-exact-context",text:text(capability)};authenticated.add(approval.text);
  const value=await f.compose(dev,tasks,{resolutionReview:approval,verifyReview});
  assert.equal(value.head,head);assert.equal(value.tree,tree);
  assert.equal(await gitAt(repository,["show","HEAD:selection.txt"]),"old selected");
  assert.equal(await gitAt(repository,["show","HEAD:feature.txt"]),"own feature");
  const after=await readJson(path.join(f.root,"capture","merge.json"));
  assert.deepEqual(after.merges[0].reviewedResolution.review,v1,"original v1 review stays immutable");
  assert.deepEqual(after.merges[0].reviewedResolution.compatibilityReview,approval);
  const readback={git:(args,options)=>gitAt(repository,args,options),baseCommit:dev,tasks,merges:value.merges,head,tree,identity,verifyReview};
  await assertNativePreparedComposition(readback);
  assert.equal((await f.compose(dev,tasks,{verifyReview})).head,head);
  const noCapability=structuredClone(value.merges);delete noCapability[0].reviewedResolution.compatibilityReview;
  await assert.rejects(assertNativePreparedComposition({...readback,merges:noCapability}),{code:"RELEASE_SELECTED_CONTENT_MISSING"});
  const mutations=[proof=>proof.binding.selectedTasks[0].baseCommit=dependency,
    proof=>proof.binding.selectedTasks.push({taskId:"foreign",baseCommit:taskBase,resultCommit:result}),
    proof=>proof.binding.obligations[0].expectedEntry=null,proof=>proof.binding.obligations[0].retainedEntry=null,
    proof=>proof.binding.obligations[0].replayTree=dependency,proof=>proof.binding.obligations[0].automaticTree=tree,
    proof=>proof.binding.candidateCommit=result,proof=>proof.acceptedObligations=[0,0,1,2]];
  for(const mutate of mutations){const bad=structuredClone(capability);mutate(bad);const badText=text(bad);authenticated.add(badText);
    const merges=structuredClone(value.merges);merges[0].reviewedResolution.compatibilityReview={requestId:"signed-but-stale",text:badText};
    await assert.rejects(assertNativePreparedComposition({...readback,merges}),{code:"RELEASE_NATIVE_REVIEW_REQUIRED"});}
  assert.equal((await f.compose(dev,tasks,{resolutionReview:approval,verifyReview,deliveredHead:head})).head,head);
  const replacement={...approval,requestId:"different fresh authenticated review"};
  await assert.rejects(f.compose(dev,tasks,{resolutionReview:replacement,verifyReview,deliveredHead:head}),
    {code:"RELEASE_NATIVE_CHECKOUT_CHANGED"});
  assert.deepEqual(await readJson(path.join(f.root,"capture","merge.json")),after);
  // The dependency is a separately selected Task in this readback. A proof for
  // the single feature Task cannot authorize its six replay obligations.
  const fullTasks=[{taskId:"dependency",baseCommit:taskBase,resultCommit:dependency},...tasks];
  const fullIdentity={policy:NATIVE_RELEASE_POLICY,baseCommit:dev,tasks:fullTasks};
  const fullBinding={...binding,identityHash:taskGitIdentityHash(fullIdentity)};
  const fullText=capability=>`<native-merge-review>${JSON.stringify({kind:"native-merge-review-v1",verdict:"ACCEPT",binding:fullBinding,
    ...(capability?{selectedContentCompatibility:capability}:{})})}</native-merge-review>`;
  const fullV1={requestId:"independent-full-selection-v1",text:fullText(null)};
  const fullSigned=new Set([fullV1.text]);
  const fullVerifier=async(input,actual)=>{assert.ok(fullSigned.has(input.text));assert.deepEqual(actual,fullBinding);};
  const fullStep=structuredClone(value.merges[0]);
  fullStep.reviewedResolution={...fullStep.reviewedResolution,binding:fullBinding,review:fullV1};
  delete fullStep.reviewedResolution.compatibilityReview;
  const fullMerges=[{taskId:"dependency",resultCommit:dependency,commit:dev,contained:true},fullStep];
  const fullReadback={...readback,tasks:fullTasks,identity:fullIdentity,merges:fullMerges,verifyReview:fullVerifier};
  let fullDerived;
  await assert.rejects(assertNativePreparedComposition(fullReadback),error=>{
    assert.equal(error.code,"RELEASE_SELECTED_CONTENT_MISSING");fullDerived=error.selectedContentCompatibilityBinding;return true;
  });
  assert.equal(fullDerived.obligations.length,6);
  const rejectedOld={requestId:"independent-but-wrong-selection",text:fullText(capability)};fullSigned.add(rejectedOld.text);
  const oldProof=structuredClone(fullMerges);oldProof[1].reviewedResolution.compatibilityReview=rejectedOld;
  await assert.rejects(assertNativePreparedComposition({...fullReadback,merges:oldProof}),{code:"RELEASE_NATIVE_REVIEW_REQUIRED"});
  const onlyFeature={requestId:"independent-feature-only",text:fullText({binding:fullDerived,acceptedObligations:[3,4,5]})};
  fullSigned.add(onlyFeature.text);const partialFull=structuredClone(fullMerges);partialFull[1].reviewedResolution.compatibilityReview=onlyFeature;
  await assert.rejects(assertNativePreparedComposition({...fullReadback,merges:partialFull}),error=>
    error.code==="RELEASE_SELECTED_CONTENT_MISSING"&&error.taskId==="dependency");
  const allFull={requestId:"independent-all-exact-obligations",text:fullText({binding:fullDerived,acceptedObligations:[0,1,2,3,4,5]})};
  fullSigned.add(allFull.text);const acceptedFull=structuredClone(fullMerges);acceptedFull[1].reviewedResolution.compatibilityReview=allFull;
  await assertNativePreparedComposition({...fullReadback,merges:acceptedFull});
  const forged=structuredClone(value.merges);forged[0].reviewedResolution.compatibilityReview={requestId:"forged",text:text({...capability,extra:true})};
  await assert.rejects(assertNativePreparedComposition({...readback,merges:forged}),/whole review must be authenticated/u);
  assert.equal(await gitAt(f.sourceRoot,["show-ref","--heads"]),`${taskBase} refs/heads/main`);
});

test("a later selected deletion needs exact reviewed automatic context rather than restoring the earlier case", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.sourceRoot, "selection.txt"), "old selected\napproved policy case\n");
  await writeFile(path.join(f.sourceRoot, "cleanup.txt"), "retained cleanup behavior\n");
  const earlier = await commit(f.sourceRoot, "earlier cleanup and policy case");
  const later = await f.create("explicit later policy case deletion", "old selected\n", earlier);
  const sourceRefsBefore = await gitAt(f.sourceRoot, ["show-ref", "--heads"]);
  const tasks = [{ taskId: "cleanup", baseCommit: f.base, resultCommit: earlier },
    { taskId: "correction", baseCommit: f.base, resultCommit: later }];
  const identity = { policy: NATIVE_RELEASE_POLICY, baseCommit: f.base, tasks };
  let derived;
  await assert.rejects(f.compose(f.base, tasks), error => {
    assert.equal(error.code, "RELEASE_SELECTED_CONTENT_MISSING");
    derived = error.selectedContentCompatibilityBinding;
    return true;
  });
  assert.equal(derived.obligations.length, 1);
  const obligation = derived.obligations[0];
  assert.equal(obligation.taskId, "cleanup");
  assert.equal(obligation.path, "selection.txt");
  assert.notEqual(obligation.retainedEntry, obligation.automaticEntry);
  const stateFile = path.join(f.root, "capture", "merge.json");
  const before = await readJson(stateFile);
  const repository = path.join(f.root, "capture", "repository");
  const head = before.head;
  const parents = (await gitAt(repository, ["show", "-s", "--format=%P", head])).split(" ");
  const tree = await gitAt(repository, ["rev-parse", "HEAD^{tree}"]);
  const automaticTree = (await gitAt(repository, ["merge-tree", "--write-tree", "--name-only", "-z", ...parents],
    { acceptableExitCodes: [1] })).split("\0")[0];
  const binding = { identityHash: taskGitIdentityHash(identity), parents, commit: head, tree, automaticTree,
    diffSha256: createHash("sha256").update(await gitAt(repository,
      ["diff", "--binary", "--full-index", "--no-renames", automaticTree, tree], { rawOutput: true })).digest("hex") };
  const text = capability => "<native-merge-review>" + JSON.stringify({ kind: "native-merge-review-v1",
    verdict: "ACCEPT", binding, ...(capability ? { selectedContentCompatibility: capability } : {}) }) + "</native-merge-review>";
  const v1 = { requestId: "same-native-without-content-authority", text: text(null) };
  const authenticated = new Set([v1.text]);
  const verifyReview = async (input, actual) => {
    assert.ok(authenticated.has(input.text));
    assert.deepEqual(actual, binding);
  };
  await assert.rejects(f.compose(f.base, tasks, { resolutionReview: v1, verifyReview }),
    { code: "RELEASE_SELECTED_CONTENT_MISSING" });
  assert.deepEqual(await readJson(stateFile), before);
  const capability = { binding: derived, acceptedObligations: [0] };
  const approval = { requestId: "exact-later-selected-deletion", text: text(capability) };
  authenticated.add(approval.text);
  const value = await f.compose(f.base, tasks, { resolutionReview: approval, verifyReview });
  assert.equal(value.head, head);
  assert.equal(value.tree, tree);
  assert.deepEqual(obligation.laterAutomaticContext, { taskId: "correction", baseCommit: f.base,
    resultCommit: later, prefixCommit: parents[0], automaticTree,
    automaticEntry: obligation.retainedEntry });
  assert.equal(await gitAt(repository, ["show", "HEAD:selection.txt"]), "old selected");
  assert.equal(await gitAt(repository, ["show", "HEAD:cleanup.txt"]), "retained cleanup behavior");
  const readback = { git: (args, options) => gitAt(repository, args, options), baseCommit: f.base,
    tasks, merges: value.merges, head, tree, identity, verifyReview };
  await assertNativePreparedComposition(readback);
  assert.equal((await f.compose(f.base, tasks, { verifyReview })).head, head);
  const beforeDrift = await readJson(stateFile);
  const mutations = [
    proof => { delete proof.binding.obligations[0].laterAutomaticContext; },
    proof => { proof.binding.obligations[0].laterAutomaticContext.taskId = "foreign"; },
    proof => { proof.binding.obligations[0].laterAutomaticContext.resultCommit = earlier; },
    proof => { proof.binding.obligations[0].laterAutomaticContext.baseCommit = earlier; },
    proof => { proof.binding.obligations[0].laterAutomaticContext.prefixCommit = f.base; },
    proof => { proof.binding.obligations[0].laterAutomaticContext.automaticTree = f.base; },
    proof => { proof.binding.obligations[0].laterAutomaticContext.automaticEntry = obligation.expectedEntry; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(capability); mutate(changed);
    const review = { requestId: "authenticated-but-drifted", text: text(changed) }; authenticated.add(review.text);
    const merges = structuredClone(value.merges);
    merges.at(-1).reviewedResolution.compatibilityReview = review;
    await assert.rejects(assertNativePreparedComposition({ ...readback, merges }), { code: "RELEASE_NATIVE_REVIEW_REQUIRED" });
  }
  const noCapability = structuredClone(value.merges);
  noCapability.at(-1).reviewedResolution = { review: v1, binding };
  await assert.rejects(assertNativePreparedComposition({ ...readback, merges: noCapability }),
    { code: "RELEASE_SELECTED_CONTENT_MISSING" });
  assert.deepEqual(await readJson(stateFile), beforeDrift);
  assert.equal(await gitAt(f.sourceRoot, ["show-ref", "--heads"]), sourceRefsBefore);
});

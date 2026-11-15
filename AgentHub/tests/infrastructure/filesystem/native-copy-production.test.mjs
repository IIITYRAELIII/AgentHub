import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mergeSelectedResults } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { createSelectedGitBundle } from "../../../src/infrastructure/filesystem/selected-git-bundle.mjs";

const gitAt = (cwd, args, options = {}) => runTaskGitCommand(args, { ...options, cwd });

test("ordinary native prefix reuse transports only absent history, retaining exact content and reopen", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-copy-producer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"); await mkdir(source);
  await gitAt(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "existing.bin"), randomBytes(512 * 1024));
  const commit = async message => {
    await gitAt(source, ["add", "."]);
    await gitAt(source, ["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-m", message]);
    return gitAt(source, ["rev-parse", "HEAD"]);
  };
  const base = await commit("existing history");
  await writeFile(path.join(source, "selected.txt"), "accepted exact contribution\n");
  const a = { taskId: "a", taskRevision: 1, baseCommit: base, resultCommit: await commit("selected a") };
  await gitAt(source, ["checkout", "--detach", base]);
  await writeFile(path.join(source, "tail.txt"), "first\n");
  const b = { taskId: "b", taskRevision: 1, baseCommit: base, resultCommit: await commit("selected b") };
  const context = { repositoryRoot: source, primaryGitCommonDir: path.join(source, ".git"),
    baseProvenance: { schemaVersion: 1, kind: "agreed-main-native-git-v1", agreedMainCommit: base, publishedBaseCommit: base } };
  const captures = path.join(root, "captures"); await mkdir(captures);
  const request = (tasks, revision) => {
    const identity = { policy: "main-selected-git-merge-v1", workspaceId: "fixture", planRevision: revision, baseCommit: base, tasks };
    return { root: path.join(captures, createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24)),
      sourceRoot: source, baseCommit: base, tasks, identity, reuseContext: context, gitAt,
      readJson: file => readFile(file, "utf8").then(JSON.parse, error => { if (error.code === "ENOENT") return null; throw error; }),
      writeJson: (file, value) => writeFile(file, JSON.stringify(value)) };
  };
  const first = await mergeSelectedResults(request([a, b], "first"));
  const oldJournal = await readFile(path.join(path.dirname(first.root), "merge.json"));
  await writeFile(path.join(source, "tail.txt"), "corrected\n");
  const corrected = { ...b, taskRevision: 2, resultCommit: await commit("corrected tail") };
  const input = request([a, corrected], "corrected");
  const result = await mergeSelectedResults(input);
  assert.equal(result.merges[0].commit, first.merges[0].commit);
  assert.equal(await gitAt(result.root, ["show", "HEAD:selected.txt"]), "accepted exact contribution");
  assert.equal(await gitAt(result.root, ["show", "HEAD:tail.txt"]), "corrected");
  assert.equal(await gitAt(result.root, ["rev-parse", "HEAD:existing.bin"]), await gitAt(source, ["rev-parse", `${base}:existing.bin`]));
  assert.deepEqual(await readFile(path.join(path.dirname(first.root), "merge.json")), oldJournal);
  const bundles = (await readdir(input.root)).filter(n => /^retained-.*\.bundle$/u.test(n));
  assert.equal(bundles.length, 1);
  const bundle = path.join(input.root, bundles[0]);
  const bytes = (await stat(bundle)).size;
  const fullBundle = path.join(root, "same-input-full.bundle");
  await createSelectedGitBundle({ root, sourceRoot: first.root, bundle: fullBundle,
    inputs: [first.merges[0].commit], gitAt });
  const fullBytes = (await stat(fullBundle)).size;
  let allocation = null;
  if (process.platform === "win32") {
    // Read FILE_STANDARD_INFO for these two owned fixture files, not a disk scan.
    // Python is supplied by the Windows development environment; no package copy.
    const script = String.raw`import ctypes as c, ctypes.wintypes as w, json, sys
k=c.WinDLL('kernel32', use_last_error=True)
class Standard(c.Structure):
 _fields_=[('allocation',c.c_longlong),('end',c.c_longlong),('links',w.DWORD),('deleted',w.BYTE),('directory',w.BYTE)]
k.CreateFileW.argtypes=[w.LPCWSTR,w.DWORD,w.DWORD,w.LPVOID,w.DWORD,w.DWORD,w.HANDLE]; k.CreateFileW.restype=w.HANDLE
k.GetFileInformationByHandleEx.argtypes=[w.HANDLE,c.c_int,w.LPVOID,w.DWORD]; k.GetFileInformationByHandleEx.restype=w.BOOL
k.CloseHandle.argtypes=[w.HANDLE]
rows=[]
for p in sys.argv[1:]:
 h=k.CreateFileW(p,0x80,7,None,3,0x02000000,None)
 if h==w.HANDLE(-1).value: raise c.WinError(c.get_last_error())
 try:
  s=Standard()
  if not k.GetFileInformationByHandleEx(h,1,c.byref(s),c.sizeof(s)): raise c.WinError(c.get_last_error())
  rows.append({'allocatedBytes':s.allocation,'logicalBytes':s.end,'links':s.links})
 finally: k.CloseHandle(h)
print(json.dumps(rows))`;
    allocation = JSON.parse(execFileSync("python", ["-c", script, fullBundle, bundle], { encoding: "utf8", windowsHide: true }));
    assert.equal(allocation[0].links, 1); assert.equal(allocation[1].links, 1);
    assert.ok(allocation[1].allocatedBytes < allocation[0].allocatedBytes);
  }
  t.diagnostic(JSON.stringify({ fixtureHistoryBytes: 512 * 1024, retainedTransportBytes: bytes,
    sameInputFullTransportBytes: fullBytes, allocation,
    retainedBundleCount: bundles.length, dependencyCopies: 0, unrelatedHistoryCopies: 0 }));
  assert.ok(bytes < 8192, `reuse must not copy the existing 512-KiB graph again; actual ${bytes}`);
  const header = (await readFile(bundle)).subarray(0, 2048).toString("utf8");
  assert.match(header, new RegExp(`^-` + base, "m"), "bundle must declare its already-owned prerequisite");
  const reopened = await mergeSelectedResults(input);
  assert.equal(reopened.head, result.head);
  assert.equal((await stat(bundle)).size, bytes);
  assert.deepEqual(await readFile(path.join(path.dirname(first.root), "merge.json")), oldJournal);
});

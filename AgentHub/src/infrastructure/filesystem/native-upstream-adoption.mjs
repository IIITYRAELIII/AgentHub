import { createHash } from "node:crypto";
import path from "node:path";
import { taskRepositoryKey } from "../../domain/task-git-reference.mjs";

const commit = value => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
const sameRoot = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const reject = () => { throw new Error("Native upstream adoption receipt or current Git identity changed"); };
const prefixes = (id, key) => [`refs/agent-hub/upstream-adoptions/${id}/${key}/`,
  `refs/agent-hub/upstream-adoptions/t-${createHash("sha256").update(id).digest("hex").slice(0, 16)}/${key}/`];

// Read the EXISTING Task adoption records. This module cannot create adoption,
// select a Task or publish a ref. Every call proves current refs and immutable
// objects, so a sealed receipt cannot authorize a later Task snapshot.
export async function readNativeUpstreamAdoptions({ git, tasks, repositoryRoot, localMainCommit }) {
  const key = taskRepositoryKey(repositoryRoot);
  const receipts = [];
  // Read this mutable namespace afresh at each validation boundary. A single
  // traversal replaces two Git processes per selected Task; no refs or receipt
  // facts survive this invocation. Filter exact prefixes before parsing records.
  const currentRefs = tasks.length ? String(await git([
    "for-each-ref", "--format=%(refname)%00%(objectname)", "refs/agent-hub/upstream-adoptions/",
  ])).split(/\r?\n/u).filter(Boolean).map(row => ({ row, ref: row.split("\0")[0] })) : [];
  for (const task of tasks) {
    const rows = [];
    for (const prefix of prefixes(task.taskId, key)) {
      rows.push(...currentRefs.filter(({ ref }) => ref.startsWith(`${prefix}${task.resultCommit}/`))
        .map(({ row }) => row));
    }
    if (!rows.length) continue;
    const hashes = new Set(rows.map(row => row.split("\0")[1]));
    if (hashes.size !== 1 || rows.length > 2) reject();
    const [recordRef, recordHash] = rows[0].split("\0");
    if (!commit(recordHash) || await git(["cat-file", "-t", recordHash]) !== "blob") reject();
    const bytes = String(await git(["cat-file", "-p", recordHash]));
    if (Buffer.byteLength(bytes) > 16 * 1024) reject();
    const r = JSON.parse(bytes);
    if (r.version !== 1 || r.kind !== "task-upstream-adoption" || typeof r.requestId !== "string"
        || !r.requestId.trim() || r.requestId.length > 200 || r.taskId !== task.taskId
        || !sameRoot(r.repositoryRoot, repositoryRoot) || r.repositoryKey !== key
        || r.taskBaseCommit !== task.baseCommit || r.snapshotCommit !== task.resultCommit
        || r.acceptedLocalMainCommit !== localMainCommit || typeof r.branch !== "string"
        || ![r.adoptedCommit, r.snapshotTree, r.proofCommit, r.proofTree].every(commit)
        || r.adoptedCommit === localMainCommit
        || !Array.isArray(r.proofParents) || r.proofParents.length !== 2
        || !r.proofParents.every(commit) || r.proofParents[1] !== r.adoptedCommit
        || rows.some(row => !prefixes(task.taskId, key).some(prefix => row.split("\0")[0]
          === `${prefix}${task.resultCommit}/${r.adoptedCommit}`))) reject();
    const expected = { version: 1, kind: "task-upstream-adoption", requestId: r.requestId,
      taskId: r.taskId, repositoryRoot: r.repositoryRoot, repositoryKey: key, branch: r.branch,
      taskBaseCommit: task.baseCommit, acceptedLocalMainCommit: localMainCommit,
      adoptedCommit: r.adoptedCommit, snapshotCommit: task.resultCommit, snapshotTree: r.snapshotTree,
      proofCommit: r.proofCommit, proofParents: r.proofParents, proofTree: r.proofTree };
    if (JSON.stringify(r) !== JSON.stringify(expected)
        || await git(["hash-object", "--stdin"], { input: `${JSON.stringify(expected)}\n` }) !== recordHash
        || await git(["rev-parse", "refs/heads/main^{commit}"]) !== localMainCommit
        || await git(["rev-parse", `refs/heads/${r.branch}^{commit}`]) !== task.resultCommit
        || await git(["rev-parse", `refs/agent-hub/task-bases/${task.taskId}/${key}^{commit}`]) !== task.baseCommit
        || await git(["rev-parse", `${task.resultCommit}^{tree}`]) !== r.snapshotTree
        || await git(["rev-parse", `${r.proofCommit}^{tree}`]) !== r.proofTree
        || await git(["show", "-s", "--format=%P", r.proofCommit]) !== r.proofParents.join(" ")) reject();
    await git(["merge-base", "--is-ancestor", localMainCommit, r.adoptedCommit]);
    await git(["merge-base", "--is-ancestor", task.baseCommit, r.proofParents[0]]);
    const history = String(await git(["rev-list", "--first-parent", "--parents", "--max-count=513",
      task.resultCommit, `^${task.baseCommit}`])).split(/\r?\n/u).filter(Boolean);
    if (history.length > 512 || history.filter(row => row.split(" ").slice(2).includes(r.adoptedCommit)).length !== 1
        || !history.includes(`${r.proofCommit} ${r.proofParents.join(" ")}`)) reject();
    receipts.push({ taskId: r.taskId, resultCommit: task.resultCommit, recordRef, recordHash,
      adoptedCommit: r.adoptedCommit, acceptedLocalMainCommit: localMainCommit,
      proofCommit: r.proofCommit, proofParents: r.proofParents, record: r });
  }
  return receipts.sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export async function assertNativeUpstreamOrigin({ git, adoptions, originCommit }) {
  if (!adoptions.length || !commit(originCommit)
      || adoptions.some(a => a.adoptedCommit !== originCommit)) reject();
  for (const a of adoptions) {
    if (await git(["rev-parse", "--verify", a.recordRef]) !== a.recordHash) reject();
  }
  if (String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0] !== originCommit) reject();
}

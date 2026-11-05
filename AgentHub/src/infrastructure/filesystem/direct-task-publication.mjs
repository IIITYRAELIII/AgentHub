import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { sourceBlobs } from "./local-source-baseline.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const samePath = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const commit = value => { if (!/^[a-f0-9]{40}$/.test(value ?? "")) throw Error("Exact direct publication commit is required"); return value; };
const tree = async (git, ref) => new Map((await git(["ls-tree", "-r", "-z", ref])).split("\0").filter(Boolean).map(row => {
  const at = row.indexOf("\t"); return [row.slice(at + 1), row.slice(0, at)];
}));

// Only hunk coordinates and whole-file blob IDs may differ after an exact port.
// Added/removed bytes, paths, modes and binary payload remain part of identity.
function changePayload(diff) {
  return diff.split("\n").filter(line => !line.startsWith("index ") && !line.startsWith("@@ ")).join("\n");
}

function hunkSnippets(diff) {
  const result = []; let current = null, previous;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
      current = { before: [], after: [], kinds: [],
        oldStart: Number(match[1]) - (Number(match[2] ?? 1) ? 1 : 0),
        newStart: Number(match[3]) - (Number(match[4] ?? 1) ? 1 : 0) };
      result.push(current); previous = null; continue;
    }
    if (!current) continue;
    const kind = line[0];
    if ([" ", "+", "-"].includes(kind)) {
      current.kinds.push(kind);
      if (kind !== "+") current.before.push(line.slice(1) + "\n");
      if (kind !== "-") current.after.push(line.slice(1) + "\n");
      previous = kind;
    } else if (line.startsWith("\\ No newline")) {
      for (const side of previous === "+" ? ["after"] : previous === "-" ? ["before"] : ["before", "after"]) {
        current[side][current[side].length - 1] = current[side].at(-1).slice(0, -1);
      }
    }
  }
  return result.map(h => ({ ...h, oldCount: h.before.length, newCount: h.after.length,
    before: Buffer.from(h.before.join("")), after: Buffer.from(h.after.join("")) }));
}

function assertOriginalEdits(hunk, publication, oldStart, newStart) {
  let before = 0, after = 0, change = null;
  const flush = () => {
    if (change && !publication.some(p => oldStart + change.before >= p.oldStart
        && oldStart + before <= p.oldStart + p.oldCount
        && newStart + change.after >= p.newStart && newStart + after <= p.newStart + p.newCount)) {
      throw Error("Published composition does not preserve the complete Task delta at its original context");
    }
    change = null;
  };
  for (const kind of hunk.kinds) {
    if (kind === " ") {
      flush();
      const original = oldStart + before;
      let mapped = original;
      for (const p of publication) {
        if (original >= p.oldStart && original < p.oldStart + p.oldCount) {
          throw Error("Published composition replaced Task context");
        }
        if (original >= p.oldStart + p.oldCount) mapped += p.newCount - p.oldCount;
      }
      if (mapped !== newStart + after) throw Error("Published composition moved Task context");
      before++; after++;
    } else {
      change ??= { before, after };
      if (kind === "-") before++; else after++;
    }
  }
  flush();
}

async function assertUniqueProjection({ git, inventories, sourceBase, sourceCommit, publicationBase, revision, composition = false }) {
  const tables = await Promise.all([sourceBase, sourceCommit, publicationBase, revision].map(ref => inventories(ref)));
  const changed = [...new Set([...tables[0].keys(), ...tables[1].keys()])].filter(p => p !== "CHANGELOG.md"
    && tables[0].get(p) !== tables[1].get(p));
  const shape = entry => entry?.split(" ").slice(0, 2).join(" ");
  if (composition) for (const p of changed) {
    if (shape(tables[0].get(p)) !== shape(tables[2].get(p))
        || shape(tables[1].get(p)) !== shape(tables[3].get(p))) throw Error("Published composition path or mode differs");
  }
  const paths = changed.filter(p =>
    !(tables[0].get(p) === tables[2].get(p) && tables[1].get(p) === tables[3].get(p)));
  const entries = new Map();
  for (const p of paths) for (let i = 0; i < 4; i++) {
    const entry = tables[i].get(p)?.split(" ");
    if (entry) entries.set(`${i}\0${p}`, { type: entry[1], oid: entry[2] });
  }
  const blobs = await sourceBlobs(git, entries, [...entries.keys()]);
  const once = (body, snippet) => snippet.length ? body.indexOf(snippet) >= 0
    && body.indexOf(snippet, body.indexOf(snippet) + 1) < 0 : body.length === 0;
  for (const p of paths) {
    const bodies = [0, 1, 2, 3].map(i => blobs.get(`${i}\0${p}`) ?? Buffer.alloc(0));
    if (composition && (tables.some(t => !t.has(p))
        || !/^100(?:644|755) blob /u.test(tables[0].get(p))
        || bodies.some(b => b.length && b.at(-1) !== 10))) {
      throw Error("Published composition requires whole file identity for additions, deletions, links or EOF changes");
    }
    // A pure mode change carries no byte delta. Its exact modes are already
    // bound by the whole patch. Binary/non-UTF8 ports need whole-blob equality.
    if (bodies[0].equals(bodies[1]) && (composition || bodies[2].equals(bodies[3]))) continue;
    const diff = String(await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--unified=3", "--binary", "--full-index",
      sourceBase, sourceCommit, "--", p], { rawOutput: true }));
    if (diff.includes("\nGIT binary patch\n") || bodies.some(b => !Buffer.from(b.toString("utf8")).equals(b))) {
      if (!bodies[0].equals(bodies[2]) || !bodies[1].equals(bodies[3])) throw Error("Binary publication projection differs");
      continue;
    }
    const cursors = [0, 0, 0, 0];
    // Zero-context Git hunks contain only actual original removals/additions.
    // Bind each own edit to ONE such edit and map retained context through it.
    const publication = composition ? hunkSnippets(String(await git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
      "--unified=0", "--inter-hunk-context=0", "--no-indent-heuristic", "--diff-algorithm=myers",
      publicationBase, revision, "--", p], { rawOutput: true }))) : [];
    const hunks = hunkSnippets(diff);
    if (!hunks.length) throw Error("Publication projection has no raw Task edits");
    for (const hunk of hunks) {
      if (![0, 2].every(i => once(bodies[i], hunk.before))
          || ![1, 3].every(i => once(bodies[i], hunk.after))) throw Error("Ambiguous publication projection context");
      if (composition) {
        const lineAt = (body, snippet) => body.subarray(0, body.indexOf(snippet)).filter(byte => byte === 10).length;
        assertOriginalEdits(hunk, publication, lineAt(bodies[2], hunk.before), lineAt(bodies[3], hunk.after));
      }
      if (composition) for (let i = 0; i < 4; i++) {
        const snippet = i % 2 ? hunk.after : hunk.before, at = bodies[i].indexOf(snippet);
        if (at < cursors[i]) throw Error("Published composition reorders Task changes");
        cursors[i] = at + snippet.length;
      }
    }
  }
}

export async function readDirectTaskPublication({ taskId, source, input, git }) {
  const trees = new Map();
  const inventories = ref => { if (!trees.has(ref)) trees.set(ref, tree(git, ref)); return trees.get(ref); };
  if (!input || Object.keys(input).some(k => !["runtimeRoot", "publicationJournalPath", "publicationRunSha256", "preparedSha256", "sourceBaseCommit", "sourceCommit", "publicationBaseCommit"].includes(k))
      || typeof input.runtimeRoot !== "string" || !input.runtimeRoot || input.runtimeRoot.includes("\0")
      || (input.publicationJournalPath !== undefined && (typeof input.publicationJournalPath !== "string"
        || !path.isAbsolute(input.publicationJournalPath) || input.publicationJournalPath.includes("\0")))
      || !/^[a-f0-9]{64}$/.test(input.publicationRunSha256 ?? "") || !/^[a-f0-9]{64}$/.test(input.preparedSha256 ?? "")) {
    throw Error("Exact original direct publication input is required");
  }
  const sourceCommit = commit(input.sourceCommit), sourceBase = commit(input.sourceBaseCommit);
  const publicationBase = commit(input.publicationBaseCommit);
  if (source.headCommit !== sourceCommit) throw Error("Direct publication source HEAD changed");
  const runFile = input.publicationJournalPath ?? path.join(input.runtimeRoot, "publication-status.json"), raw = await readFile(runFile);
  if (sha(raw) !== input.publicationRunSha256) throw Error("Original direct publication journal changed");
  const run = JSON.parse(raw.toString("utf8")), publication = run.progress?.publicationState;
  const revision = commit(run.identity?.revision), from = commit(run.identity?.from);
  if (run.version !== 2 || run.status !== "published" || !run.finishedAt || run.currentStep !== null || run.error
      || run.identity?.mode !== "direct-user-override" || !samePath(run.identity.runtimeRoot, input.runtimeRoot)
      || !publication?.generation || publication.mode !== run.identity.mode || publication.revision !== revision
      || !Array.isArray(publication.tasks) || !publication.tasks.includes(taskId)
      || new Set(publication.tasks).size !== publication.tasks.length
      || !run.steps?.length || run.steps.some(s => !["completed", "reused"].includes(s.status))
      || !publication.repositories?.some(r => samePath(r.root, source.repositoryRoot) && r.revision === revision && r.baseCommit === from)
      || typeof run.identity.artifact !== "string" || run.identity.artifact !== publication.artifact) {
    throw Error("Task has no exact terminal direct publication membership");
  }
  const preparedRaw = await readFile(run.identity.artifact);
  if (sha(preparedRaw) !== input.preparedSha256) throw Error("Original prepared publication artifact changed");
  const prepared = JSON.parse(preparedRaw.toString("utf8"));
  if (prepared.revision !== revision || prepared.base !== from
      || prepared.releaseId !== run.progress.expectedReleaseId
      || prepared.prepared?.releaseId !== prepared.releaseId
      || prepared.tree !== await git(["rev-parse", `${revision}^{tree}`])
      || !/^[a-f0-9]{64}$/.test(prepared.newManifestSha256 ?? "")) {
    throw Error("Original direct publication artifact identity differs");
  }
  const remote = await git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
  await git(["merge-base", "--is-ancestor", revision, remote]);
  await git(["merge-base", "--is-ancestor", sourceBase, sourceCommit]);
  const immutableBase = commit(source.immutableBaseCommit);
  const contained = !(await git(["rev-list", "--max-count=1", sourceCommit, "--not", revision]));
  if (!contained && sourceBase !== immutableBase) {
    const parents = (await git(["show", "-s", "--format=%P", sourceBase])).split(/\s+/);
    if (JSON.stringify(parents) !== JSON.stringify([immutableBase, from])) throw Error("Source range skips its immutable Task baseline");
    const [merged, original, published] = await Promise.all([inventories(sourceBase), inventories(immutableBase), inventories(from)]);
    for (const p of new Set([...merged.keys(), ...original.keys(), ...published.keys()])) {
      if (p === "CHANGELOG.md") continue; // Existing release-owner metadata.
      if (merged.get(p) !== original.get(p) && merged.get(p) !== published.get(p)) throw Error("Source baseline merge contains unrepresented changes");
    }
  }
  const parentLine = (await git(["show", "-s", "--format=%P", revision])).split(/\s+/);
  const composition = publicationBase === from;
  if (composition) {
    // Only the original run's own from→terminal first-parent chain is eligible.
    const chain = (await git(["rev-list", "--first-parent", "--reverse", "--parents", `${from}..${revision}`])).split(/\r?\n/u).filter(Boolean);
    let prior = from;
    for (const row of chain) {
      const [head, parent] = row.split(" ");
      if (parent !== prior) throw Error("Original publication first-parent chain differs");
      prior = head;
    }
    if (!chain.length || prior !== revision) throw Error("Original publication range is not its terminal chain");
  } else if (JSON.stringify(parentLine) !== JSON.stringify([publicationBase])) throw Error("Direct publication projection parent differs");
  const diff = async (base, head) => String(await git(["diff", "--no-ext-diff", "--no-renames", "--unified=3", "--binary", "--full-index", base, head,
    "--", ".", ":(exclude)CHANGELOG.md"], { rawOutput: true }));
  const [sourceDiff, publishedDiff] = contained ? [null, null]
    : await Promise.all([diff(sourceBase, sourceCommit), composition ? null : diff(publicationBase, revision)]);
  const payload = contained ? JSON.stringify({ sourceCommit, revision }) : changePayload(sourceDiff);
  if (!contained && (!payload.trim() || !composition && payload !== changePayload(publishedDiff))) throw Error("Source changes are not the exact original published projection");
  if (!contained) await assertUniqueProjection({ git, inventories, sourceBase, sourceCommit, publicationBase, revision, composition });
  if (!(await readFile(runFile)).equals(raw) || !(await readFile(run.identity.artifact)).equals(preparedRaw)) throw Error("Direct publication evidence changed during readback");
  return { version: 1, kind: "direct-published-task-cleanup-v1", taskId,
    source: { ...source }, input: { ...input }, publication: { runId: run.runId, revision, from, generation: publication.generation,
      releaseId: prepared.releaseId, manifestSha256: prepared.newManifestSha256, tree: prepared.tree },
    projection: contained ? "published-ancestry" : composition ? "exact-original-composition" : "exact-change-payload", changeSha256: sha(payload) };
}

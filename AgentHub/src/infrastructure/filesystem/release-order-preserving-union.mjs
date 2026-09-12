import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_TASK_MERGE_PROOFS = 512;

function bytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
}

async function gitBytes(cwd, args) {
  try {
    const result = await execFileAsync("git", args, {
      cwd, windowsHide: true, encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
    });
    return bytes(result.stdout);
  } catch (error) {
    if (Number.isInteger(error?.code) && error.code > 0 && error.stdout != null) return bytes(error.stdout);
    throw error;
  }
}

async function exactCommit(root, value) {
  const candidate = String(value ?? "").trim();
  if (!/^[a-f0-9]{40,64}$/iu.test(candidate)) return null;
  try {
    const commit = (await gitBytes(root, ["rev-parse", "--verify", `${candidate}^{commit}`]))
      .toString("utf8").trim();
    return /^[a-f0-9]{40,64}$/iu.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

async function exactRefCommit(root, value) {
  const candidate = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9._/-]*$/iu.test(candidate)
      || candidate.includes("..") || candidate.includes("@{")) return null;
  try {
    const commit = (await gitBytes(root, ["rev-parse", "--verify", `${candidate}^{commit}`]))
      .toString("utf8").trim();
    return /^[a-f0-9]{40,64}$/iu.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

function parseTreeEntry(bytesValue, file) {
  const records = bytes(bytesValue).toString("utf8").split("\0").filter(Boolean);
  if (records.length !== 1) return null;
  const match = /^([0-7]{6}) ([^ ]+) ([a-f0-9]{40,64})\t([\s\S]+)$/iu.exec(records[0]);
  if (!match || match[4] !== file || match[2] !== "blob") return null;
  return { mode: match[1], type: match[2], object: match[3] };
}

async function exactTreeEntry(root, revision, file) {
  try {
    return parseTreeEntry(await gitBytes(root, ["ls-tree", "-z", revision, "--", file]), file);
  } catch {
    return null;
  }
}

async function exactIndexStageEntry(root, stage, file) {
  try {
    const records = (await gitBytes(root, ["ls-files", "--stage", "-z", "--", file]))
      .toString("utf8").split("\0").filter(Boolean);
    for (const record of records) {
      const match = /^([0-7]{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/iu.exec(record);
      if (!match || Number(match[3]) !== stage || match[4] !== file) continue;
      const type = (await gitBytes(root, ["cat-file", "-t", match[2]])).toString("utf8").trim();
      return type === "blob" ? { mode: match[1], type, object: match[2] } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function sameEntry(left, right) {
  return Boolean(left && right && left.mode === right.mode
    && left.type === right.type && left.object === right.object);
}

async function isAncestor(root, ancestor, descendant) {
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: root, windowsHide: true, encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function historicalBaseMatchesApprovedPaths(root, historicalBase, approvedBase, stages) {
  if (historicalBase === approvedBase) return true;
  try {
    await execFileAsync("git", ["merge-base", "--is-ancestor", historicalBase, approvedBase], {
      cwd: root, windowsHide: true, encoding: "buffer", maxBuffer: 64 * 1024 * 1024,
    });
    for (const stage of stages) {
      const [historical, approved] = await Promise.all([
        gitBytes(root, ["show", `${historicalBase}:${stage.file}`]),
        gitBytes(root, ["show", `${approvedBase}:${stage.file}`]),
      ]);
      if (!historical.equals(approved)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resolvedPath(root, relative) {
  const target = path.resolve(root, String(relative).replaceAll("/", path.sep));
  const child = path.relative(path.resolve(root), target);
  if (!child || child === ".." || child.startsWith(`..${path.sep}`) || path.isAbsolute(child)) {
    throw new Error("release conflict path escaped its candidate root");
  }
  return target;
}

async function unionBytes(root, temporary, ours, base, theirs) {
  await mkdir(temporary, { recursive: true });
  const files = ["ours", "base", "theirs"].map((name) => path.join(temporary, name));
  await Promise.all([writeFile(files[0], ours), writeFile(files[1], base), writeFile(files[2], theirs)]);
  return gitBytes(root, ["merge-file", "-p", "--union", ...files]);
}

export async function resolveExactOrderPreservingUnion({
  candidateRoot, conflicts = [], approvedBaseCommit, devRef = "refs/remotes/workspace/dev",
} = {}) {
  const root = path.resolve(String(candidateRoot ?? ""));
  const approvedBase = String(approvedBaseCommit ?? "").trim();
  const paths = [...new Set(conflicts.map((value) => String(value ?? "").trim()).filter(Boolean))];
  if (!paths.length || !approvedBase) return false;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-union-"));
  try {
    const stages = [];
    for (const [index, file] of paths.entries()) {
      let base;
      let ours;
      let theirs;
      let accepted;
      try {
        [base, ours, theirs, accepted] = await Promise.all([
          gitBytes(root, ["show", `:1:${file}`]),
          gitBytes(root, ["show", `:2:${file}`]),
          gitBytes(root, ["show", `:3:${file}`]),
          gitBytes(root, ["show", `${devRef}:${file}`]),
        ]);
      } catch {
        return false;
      }
      const itemRoot = path.join(temporary, String(index));
      const [oursFirst, theirsFirst] = await Promise.all([
        unionBytes(root, path.join(itemRoot, "ours-first"), ours, base, theirs),
        unionBytes(root, path.join(itemRoot, "theirs-first"), theirs, base, ours),
      ]);
      stages.push({
        file, target: resolvedPath(root, file), ours, theirs, accepted,
        unionExact: accepted.equals(oursFirst) || accepted.equals(theirsFirst),
      });
    }
    let resolutions = stages;
    if (stages.some((stage) => !stage.unionExact)) {
      resolutions = null;
      const history = (await gitBytes(root, [
        "log", "--first-parent", "--merges", "--format=%H%x00%P", devRef,
      ])).toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
      for (const line of history) {
        const [commit, parentsText = ""] = line.split("\0");
        const parents = parentsText.split(" ").filter(Boolean);
        if (parents.length !== 2 || !await historicalBaseMatchesApprovedPaths(
          root, parents[1], approvedBase, stages,
        )) continue;
        let exact = true;
        for (const stage of stages) {
          try {
            const [firstParent, secondParent, resolved] = await Promise.all([
              gitBytes(root, ["show", `${parents[0]}:${stage.file}`]),
              gitBytes(root, ["show", `${parents[1]}:${stage.file}`]),
              gitBytes(root, ["show", `${commit}:${stage.file}`]),
            ]);
            if (!firstParent.equals(stage.theirs) || !secondParent.equals(stage.ours)
                || !resolved.equals(stage.accepted)) { exact = false; break; }
          } catch {
            exact = false;
            break;
          }
        }
        if (exact) {
          resolutions = stages;
          break;
        }
      }
      if (!resolutions) return false;
    }
    for (const resolution of resolutions) {
      await mkdir(path.dirname(resolution.target), { recursive: true });
      await writeFile(resolution.target, resolution.accepted);
      await gitBytes(root, ["add", "--", resolution.file]);
    }
    return (await gitBytes(root, ["diff", "--name-only", "--diff-filter=U", "-z"])).length === 0;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// A reopened Task can carry an old dev integration whose patch reintroduces
// bytes already present in the approved base. Resolve that conflict only when
// one Task-local merge durably proves the exact accepted result against that
// exact base. Any missing, foreign or ambiguous proof keeps the release blocked.
export async function resolveExactTaskBaseMerge({
  candidateRoot, conflicts = [], approvedBaseCommit, taskResultCommit,
  integrationCommit, devRef = "refs/remotes/workspace/dev",
} = {}) {
  const root = path.resolve(String(candidateRoot ?? ""));
  const paths = [...new Set(conflicts.map((value) => String(value ?? "").trim()).filter(Boolean))];
  if (!paths.length) return false;
  const [approvedBase, taskResult, integration, dev] = await Promise.all([
    exactCommit(root, approvedBaseCommit),
    exactCommit(root, taskResultCommit),
    exactCommit(root, integrationCommit),
    exactRefCommit(root, devRef),
  ]);
  if (!approvedBase || !taskResult || !integration || !dev
      || !await isAncestor(root, integration, dev)) return false;
  const stages = [];
  for (const file of paths) {
    resolvedPath(root, file);
    const [ours, approved, acceptedResult, acceptedIntegration, acceptedDev] = await Promise.all([
      exactIndexStageEntry(root, 2, file),
      exactTreeEntry(root, approvedBase, file),
      exactTreeEntry(root, taskResult, file),
      exactTreeEntry(root, integration, file),
      exactTreeEntry(root, dev, file),
    ]);
    if (!sameEntry(ours, approved) || !sameEntry(acceptedResult, acceptedIntegration)
        || !sameEntry(acceptedResult, acceptedDev)) return false;
    stages.push({ file, ours, accepted: acceptedResult });
  }
  let history;
  try {
    history = (await gitBytes(root, [
      "rev-list", "--first-parent", "--merges",
      `--max-count=${MAX_TASK_MERGE_PROOFS + 1}`, taskResult,
    ])).toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
  } catch {
    return false;
  }
  if (history.length > MAX_TASK_MERGE_PROOFS) return false;
  const proofs = [];
  for (const commit of history) {
    if (!await isAncestor(root, commit, integration)) continue;
    const parents = (await gitBytes(root, ["show", "-s", "--format=%P", commit]))
      .toString("utf8").trim().split(" ").filter(Boolean);
    if (parents.length !== 2 || parents[1] !== approvedBase) continue;
    let exact = true;
    for (const stage of stages) {
      const [approved, resolved] = await Promise.all([
        exactTreeEntry(root, parents[1], stage.file),
        exactTreeEntry(root, commit, stage.file),
      ]);
      if (!sameEntry(approved, stage.ours) || !sameEntry(resolved, stage.accepted)) {
        exact = false;
        break;
      }
    }
    if (exact) proofs.push(commit);
    if (proofs.length > 1) return false;
  }
  if (proofs.length !== 1) return false;
  for (const stage of stages) {
    await gitBytes(root, ["checkout", proofs[0], "--", stage.file]);
  }
  return (await gitBytes(root, ["diff", "--name-only", "--diff-filter=U", "-z"])).length === 0;
}

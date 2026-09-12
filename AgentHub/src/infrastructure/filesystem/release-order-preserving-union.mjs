import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

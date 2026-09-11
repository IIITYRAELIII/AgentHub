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
  candidateRoot, conflicts = [], devRef = "refs/remotes/workspace/dev",
} = {}) {
  const root = path.resolve(String(candidateRoot ?? ""));
  const paths = [...new Set(conflicts.map((value) => String(value ?? "").trim()).filter(Boolean))];
  if (!paths.length) return false;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-union-"));
  try {
    const resolutions = [];
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
      if (!accepted.equals(oursFirst) && !accepted.equals(theirsFirst)) return false;
      resolutions.push({ file, target: resolvedPath(root, file), accepted });
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

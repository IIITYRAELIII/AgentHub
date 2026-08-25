import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function nearestExistingDirectory(candidate) {
  let current = path.dirname(candidate);
  while (true) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

async function git(cwd, args) {
  return execFileAsync("git", ["-C", cwd, ...args], {
    windowsHide: true,
    timeout: 3_000,
    maxBuffer: 64 * 1024,
  });
}

export async function inspectLegacyReleaseFile({ projectRoot, file } = {}) {
  const root = String(projectRoot ?? "").trim();
  const candidate = path.isAbsolute(String(file ?? ""))
    ? path.resolve(String(file))
    : path.resolve(root || ".", String(file ?? ""));
  let exists = true;
  try {
    await access(candidate);
  } catch {
    exists = false;
  }
  const cwd = await nearestExistingDirectory(candidate);
  if (!cwd) return { state: exists ? "unknown" : "missing", path: candidate };
  try {
    const repositoryRoot = String((await git(cwd, ["rev-parse", "--show-toplevel"])).stdout).trim();
    const relative = path.relative(repositoryRoot, candidate).replaceAll("\\", "/");
    if (!relative || relative === ".." || relative.startsWith("../")) {
      return { state: exists ? "unknown" : "missing", path: candidate };
    }
    const { stdout } = await git(repositoryRoot, [
      "status", "--porcelain=v1", "--ignored", "--untracked-files=all", "--", relative,
    ]);
    const status = String(stdout).trim();
    if (status.startsWith("!!")) return { state: "ignored", path: candidate };
    if (status) return { state: "dirty", path: candidate };
    return { state: exists ? "clean" : "missing", path: candidate };
  } catch (error) {
    return {
      state: exists ? "unknown" : "missing",
      path: candidate,
      error: String(error?.stderr ?? error?.message ?? error).trim().slice(0, 500),
    };
  }
}

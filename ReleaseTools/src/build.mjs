import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
const execute = promisify(execFile);

export async function buildPinnedCandidate({ candidate, commit, runtimeRoot, releaseId, artifactVersion }, { run = execute } = {}) {
  if (!/^[a-f0-9]{40}$/u.test(commit ?? "")) throw new Error("Build requires an exact candidate commit");
  const root = path.resolve(candidate);
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = async (...args) => (await run("git", ["-c", "core.longpaths=true", "-C", root, ...args], {
    encoding: "utf8", windowsHide: true, env: environment,
  })).stdout.trim();
  async function source() {
    const head = await git("rev-parse", "HEAD"), tree = await git("rev-parse", "HEAD^{tree}");
    if (head !== commit || await git("status", "--porcelain=v1", "--untracked-files=all")) throw new Error("Build candidate changed or is dirty");
    return { commit: head, tree };
  }
  const before = await source();
  const result = await run(process.execPath, [path.join(root, "AgentHub", "build-runtime.mjs"),
    "--runtime-root", path.resolve(runtimeRoot), "--release-id", releaseId,
    "--source-commit", commit, "--artifact-version", artifactVersion], {
    cwd: path.join(root, "AgentHub"), windowsHide: true, encoding: "utf8", maxBuffer: Infinity, env: environment,
  });
  const after = await source();
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error("Build candidate changed during execution");
  return { candidate: before, prepared: JSON.parse(result.stdout) };
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Used only by synthetic disposable Git fixtures. No live state is copied.
export async function ordinaryPublishedResolutionFixture(f, input) {
  const command = async (args, options = {}) => (await exec("git", args, {
    cwd: f.root, maxBuffer: 16 * 1024 * 1024, ...options,
  })).stdout.trim();
  let automatic;
  try { automatic = await command(["merge-tree", "--write-tree", f.published, f.task]); }
  catch (error) { if (error.code !== 1) throw error; automatic = error.stdout; }
  const baseline = automatic.split(/\r?\n/u)[0];
  const own = (await command(["diff", "--name-only", "-z", f.local, f.task])).split("\0").filter(Boolean);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(f.root, "published-fixture.index") };
  const index = (args) => command(args, { env });
  await index(["read-tree", f.published]);
  for (const name of own) {
    const tree = name === "conflict.txt" ? f.proof : baseline;
    const entry = await command(["ls-tree", tree, "--", name]);
    const [, mode, blob] = /^(\d{6}) blob ([0-9a-f]{40})\t/u.exec(entry);
    await index(["update-index", "--add", "--cacheinfo", mode, blob, name]);
  }
  const tree = await index(["write-tree"]);
  const commit = await command(["commit-tree", tree, "-p", f.published, "-m", "reviewed published own resolution"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  });
  await command(["update-ref", "refs/review/published", commit]);
  const bundle = path.join(f.root, "published-fixture.bundle");
  await command(["bundle", "create", bundle, "refs/review/published"]);
  const blob = await command(["rev-parse", `${commit}:conflict.txt`]);
  const { git: _git, ...identity } = input;
  return { tree, commit, bundle, input: { version: 1, kind: "ordinary-published-resolution-v1",
    ...identity, resolutionCommit: commit, resolutionBundlePath: bundle,
    resolutionBundleSha256: createHash("sha256").update(await readFile(bundle)).digest("hex"),
    resolutions: [{ path: "conflict.txt", mode: "100644", blob }] } };
}

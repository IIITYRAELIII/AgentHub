import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { verifyTestPlan } from "../../domain/test-selection.mjs";
import { assertCleanPublicationTree, currentRevision } from "../persistence/publication-state.mjs";
import { discoverReleaseTestInventory, RELEASE_CHECK_IDS } from "./release-test-inventory.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

// The publication owner has already verified the frozen plan. Retain its whole
// identity in an addressed file so Windows argv size cannot truncate selection.
export async function preparePublicationTestSelection(testPlan, { repositoryRoot, revision }) {
  verifyTestPlan(testPlan);
  if (!/^[a-f0-9]{40,64}$/u.test(revision ?? "")) throw new Error("Invalid selected-test source revision");
  const root = await realpath(repositoryRoot);
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, repositoryRoot: root, revision, testPlan })}\n`);
  const sha256 = digest(bytes);
  const directory = path.join(root, "AgentHub", "WIP", "publication-test-selection");
  const file = path.join(directory, `${sha256}.json`);
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    try {
      // Publish complete bytes without replacing a retained or concurrent file.
      await link(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await readFile(file)).equals(bytes)) throw new Error("Selected-test payload changed");
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return [`--selection-file=${file}`, `--selection-sha256=${sha256}`];
}

export async function readPublicationTestSelection(args, { sourceRoot }) {
  const fileArguments = args.filter(arg => arg.startsWith("--selection-file="));
  const hashes = args.filter(arg => arg.startsWith("--selection-sha256="));
  if (args.length !== 2 || fileArguments.length !== 1 || hashes.length !== 1) {
    throw new Error("Selected-test file requires exactly its path and SHA256");
  }
  const file = fileArguments[0].slice("--selection-file=".length);
  const expectedSha256 = hashes[0].slice("--selection-sha256=".length);
  if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("Invalid selected-test file binding");
  }
  const bytes = await readFile(file);
  if (digest(bytes) !== expectedSha256) throw new Error("Selected-test payload digest changed");
  const payload = JSON.parse(bytes.toString("utf8"));
  if (!payload || payload.schemaVersion !== 1
      || Object.keys(payload).sort().join(",") !== "repositoryRoot,revision,schemaVersion,testPlan"
      || typeof payload.repositoryRoot !== "string"
      || !/^[a-f0-9]{40,64}$/u.test(payload.revision ?? "")) {
    throw new Error("Invalid selected-test payload");
  }
  const root = await realpath(path.resolve(sourceRoot, ".."));
  if (payload.repositoryRoot !== root || await currentRevision({ cwd: root }) !== payload.revision) {
    throw new Error("Selected-test source changed");
  }
  await assertCleanPublicationTree({ cwd: root });
  const plan = verifyTestPlan(payload.testPlan, await discoverReleaseTestInventory(sourceRoot));
  return { mode: "include", ids: plan.selectedIds.filter(id => !RELEASE_CHECK_IDS.includes(id)) };
}

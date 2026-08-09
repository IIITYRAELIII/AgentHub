import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function publicationStateFile(environment = process.env) {
  const root = environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
  return path.join(root, "AgentHub", "publication-state.json");
}

export async function readPublicationState(file = publicationStateFile()) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writePublicationState(value, file = publicationStateFile()) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function gitOutput(args, { cwd } = {}) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

export async function currentRevision({ cwd } = {}) {
  return gitOutput(["rev-parse", "HEAD"], { cwd });
}

export async function changedFiles(fromRevision, { cwd } = {}) {
  const output = await gitOutput(["diff", "--name-only", "--diff-filter=ACMRTUXB", `${fromRevision}..HEAD`], { cwd });
  return output ? output.split(/\r?\n/u).filter(Boolean) : [];
}

export function parseWorkingTreeStatus(output) {
  return String(output ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

export async function assertCleanPublicationTree({ cwd, status = gitOutput } = {}) {
  const output = await status(["status", "--porcelain=v1", "--untracked-files=all", "--", "AgentHub"], { cwd });
  const changes = parseWorkingTreeStatus(output);
  if (changes.length) {
    throw new Error(`Публикация из dirty working tree запрещена: ${changes.join(", ")}`);
  }
  return true;
}

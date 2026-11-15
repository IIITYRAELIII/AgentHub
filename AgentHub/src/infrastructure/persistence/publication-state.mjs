import { ownedGitArguments } from "../filesystem/preparation-git-isolation.mjs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { withPublicationLock } from "../process/publication-lock.mjs";

const execFileAsync = promisify(execFile);
const writeTails = new Map();

export function publicationStateFile(environment = process.env) {
  const root = environment.LOCALAPPDATA
    || environment.XDG_STATE_HOME
    || path.join(os.homedir(), ".local", "state");
  return path.join(root, "AgentHub", "publication-state.json");
}

export async function readPublicationState(file = publicationStateFile()) {
  try {
    return normalizePublicationState(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function canonicalRoot(value) {
  const resolved = path.resolve(String(value ?? "").trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function stable(value) {
  const normalized = (item) => {
    if (Array.isArray(item)) return item.map(normalized);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalized(item[key])]));
  };
  return JSON.stringify(normalized(value));
}

function repositoryRootOf(value) {
  return String(value?.root ?? value?.projectRoot ?? "").trim();
}

function repositoryRevisionOf(value) {
  return String(value?.revision ?? value?.publishedRevision ?? "").trim();
}

function normalizedRepositoryEvidence(entry) {
  const root = repositoryRootOf(entry);
  const revision = repositoryRevisionOf(entry);
  if (!root || !revision) throw new Error("publication repository evidence requires root and revision");
  return { ...entry, root, revision };
}

export function publicationStateRepositories(value = {}) {
  const entries = Array.isArray(value?.repositories) ? value.repositories : [];
  const repositories = new Map();
  for (const raw of entries) {
    const entry = normalizedRepositoryEvidence(raw);
    const key = canonicalRoot(entry.root);
    const existing = repositories.get(key);
    if (existing && stable(existing) !== stable(entry)) {
      throw new Error(`conflicting duplicate publication evidence for ${entry.root}`);
    }
    repositories.set(key, entry);
  }
  if (!repositories.size && repositoryRootOf(value) && repositoryRevisionOf(value)) {
    const entry = normalizedRepositoryEvidence(value);
    repositories.set(canonicalRoot(entry.root), entry);
  }
  const legacyReleaseRoot = String(value?.release?.primaryRoot ?? value?.primaryRoot ?? "").trim();
  if (!repositories.size && legacyReleaseRoot && repositoryRevisionOf(value)) {
    const entry = normalizedRepositoryEvidence({
      root: legacyReleaseRoot,
      revision: repositoryRevisionOf(value),
      planRevision: value?.release?.planRevision ?? value?.planRevision,
      manifestHash: value?.release?.manifestHash ?? value?.manifestHash,
      baseCommit: value?.release?.baseCommit ?? value?.baseCommit,
      preReleaseHead: value?.release?.preReleaseHead ?? value?.preReleaseHead,
      adoptedFrom: "legacy-publication-record",
    });
    repositories.set(canonicalRoot(entry.root), entry);
  }
  return [...repositories.values()].sort((left, right) => canonicalRoot(left.root).localeCompare(canonicalRoot(right.root)));
}

export function normalizePublicationState(value = null) {
  if (!value) return null;
  const repositories = publicationStateRepositories(value);
  return repositories.length ? { ...value, repositories } : value;
}

async function withPublicationStateWriteTurn(file, operation) {
  const key = path.resolve(file);
  const previous = writeTails.get(key)?.catch(() => {}) ?? Promise.resolve();
  const current = previous.then(operation);
  writeTails.set(key, current);
  try {
    return await current;
  } finally {
    if (writeTails.get(key) === current) writeTails.delete(key);
  }
}

async function writePublicationStateUnlocked(value, file) {
  await mkdir(path.dirname(file), { recursive: true });
  const current = await readPublicationState(file);
  const incomingRepositories = publicationStateRepositories(value);
  const retained = new Map((current?.repositories ?? []).map((entry) => [canonicalRoot(entry.root), entry]));
  for (const entry of incomingRepositories) retained.set(canonicalRoot(entry.root), entry);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    ...(current ?? {}),
    ...value,
    ...(retained.size ? { repositories: [...retained.values()].sort((left, right) => (
      canonicalRoot(left.root).localeCompare(canonicalRoot(right.root))
    )) } : {}),
    generation: String(value?.generation ?? current?.generation ?? "").trim() || randomUUID(),
  }, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function writePublicationState(value, file = publicationStateFile()) {
  return withPublicationLock(
    () => withPublicationStateWriteTurn(file, () => writePublicationStateUnlocked(value, file)),
    { environment: process.env },
  );
}

export async function gitOutput(args, { cwd } = {}) {
  const { stdout } = await execFileAsync("git", ownedGitArguments(args), {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

export async function currentRevision({ cwd } = {}) {
  return gitOutput(["rev-parse", "HEAD"], { cwd });
}

async function optionalGitOutput(args, { cwd, revision }) {
  try {
    return await revision(args, { cwd });
  } catch {
    return null;
  }
}

export async function assertCurrentPublicationRevision({ cwd, revision = gitOutput } = {}) {
  const [head, currentBranch, main, originMain] = await Promise.all([
    revision(["rev-parse", "HEAD"], { cwd }),
    optionalGitOutput(["symbolic-ref", "-q", "HEAD"], { cwd, revision }),
    optionalGitOutput(["rev-parse", "refs/heads/main"], { cwd, revision }),
    optionalGitOutput(["rev-parse", "refs/remotes/origin/main"], { cwd, revision }),
  ]);
  const expected = currentBranch === "refs/heads/main" ? main : originMain ?? main;
  if (!expected || head !== expected) {
    throw new Error(
      `Публикация устаревшей ревизии запрещена: HEAD ${head}, `
      + `main ${main ?? "missing"}, origin/main ${originMain ?? "missing"}`,
    );
  }
  return head;
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

import path from "node:path";
import { fileURLToPath } from "node:url";

function threadRepositoryUrl(thread) {
  return String(
    thread?.repositoryUrl
    ?? thread?.gitInfo?.repositoryUrl
    ?? thread?.git?.repository_url
    ?? "",
  ).trim();
}

export function localCodexRepositoryPath(value) {
  const repositoryUrl = String(value ?? "").trim();
  if (!repositoryUrl) return "";
  if (/^file:/iu.test(repositoryUrl)) {
    try {
      return path.resolve(fileURLToPath(repositoryUrl));
    } catch {
      return "";
    }
  }
  return path.isAbsolute(repositoryUrl) ? path.resolve(repositoryUrl) : "";
}

export async function resolveCodexJournalProject(thread, {
  findProject,
  readSession,
  resolveParentProject,
} = {}) {
  if (typeof findProject !== "function") {
    throw new Error("Codex journal project resolution requires findProject");
  }
  const direct = findProject(String(thread?.cwd ?? "").trim());
  if (direct) return direct;

  let repositoryUrl = threadRepositoryUrl(thread);
  if (!repositoryUrl && thread?.path && typeof readSession === "function") {
    try {
      const session = await readSession(thread.path);
      repositoryUrl = threadRepositoryUrl(session);
    } catch {
      repositoryUrl = "";
    }
  }
  const repositoryPath = localCodexRepositoryPath(repositoryUrl);
  const repositoryProject = repositoryPath ? findProject(repositoryPath) : null;
  if (repositoryProject) return repositoryProject;

  const parentThreadId = String(thread?.parentThreadId ?? "").trim();
  if (!parentThreadId || typeof resolveParentProject !== "function") return null;
  return await resolveParentProject(parentThreadId, thread) ?? null;
}

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
      return null;
    }
  }
  const repositoryPath = localCodexRepositoryPath(repositoryUrl);
  return repositoryPath ? findProject(repositoryPath) : null;
}

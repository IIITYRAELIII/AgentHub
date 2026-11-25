import { GitHubAccountService } from "../../application/github-account-service.mjs";
import { githubDirectory } from "../filesystem/github-git-profile.mjs";

// Same protected account as Git and agents. No alternate login or public retry
// after an authenticated refusal. External asset/download hosts get no token.
export async function githubAccountFetch(url, options = {}) {
  const target = new URL(url);
  if (target.origin !== "https://api.github.com" || target.username || target.password) throw new Error("Unsupported GitHub API origin");
  const directory = githubDirectory(process.env);
  if (directory) {
    const service = new GitHubAccountService({ directory });
    if ((await service.snapshot()).status !== "disconnected") return service.request(target.pathname + target.search, options);
  }
  return fetch(url, { ...options, redirect: "error" });
}

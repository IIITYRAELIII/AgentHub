import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GitHubAccountVault } from "../filesystem/github-account-vault.mjs";

export function redactCredentialStream(stream, destination, token) {
  let pending = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    pending += chunk;
    let index;
    while ((index = pending.indexOf(token)) >= 0) {
      destination.write(pending.slice(0, index) + "[REDACTED]");
      pending = pending.slice(index + token.length);
    }
    const safe = Math.max(0, pending.length - token.length + 1);
    if (safe) { destination.write(pending.slice(0, safe)); pending = pending.slice(safe); }
  });
  stream.once("end", () => { destination.write(pending); pending = ""; });
}

export async function runGitHubCli(args, { directory = process.env.AGENT_HUB_GITHUB_DIRECTORY,
  environment = process.env, vault = new GitHubAccountVault({ directory }), spawnProcess = spawn,
  stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  const executable = JSON.parse(await readFile(path.join(directory, "tools.json"), "utf8")).gh;
  if (!executable) throw new Error("GitHub CLI is not installed");
  const row = await vault.read();
  const env = { ...environment };
  let token = null;
  if (row) {
    if (args[0] === "auth" && ["login", "logout", "switch", "refresh", "setup-git", "token"].includes(args[1])) {
      throw new Error("Управляйте общим GitHub-аккаунтом в Hub; токен не выводится и глобальная настройка Git не изменяется");
    }
    // gh treats additional domains as cloud hosts. This connection authorizes
    // github.com only, and must never forward its token to another server.
    const hostnameIndex = args.indexOf("--hostname");
    const hostname = hostnameIndex >= 0 ? args[hostnameIndex + 1]
      : args.find(arg => arg.startsWith("--hostname="))?.slice(11) ?? env.GH_HOST ?? "github.com";
    if (hostname.toLowerCase() !== "github.com" || args.some(arg => /^https?:\/\//iu.test(arg)
      && new URL(arg).hostname !== "github.com" && new URL(arg).hostname !== "api.github.com")) {
      throw new Error("Hub GitHub authorization is limited to github.com");
    }
    const repositoryIndex = args.findIndex(arg => arg === "-R" || arg === "--repo");
    const repository = repositoryIndex >= 0 ? args[repositoryIndex + 1]
      : args.find(arg => arg.startsWith("--repo="))?.slice(7) ?? env.GH_REPO ?? "";
    const qualifiedHost = String(repository).split("/");
    const positionalForeignHost = args.some(arg => /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\/[^/]+\/[^/]+$/u.test(arg)
      && !arg.startsWith("github.com/"));
    if (qualifiedHost.length >= 3 && qualifiedHost[0] !== "github.com" || positionalForeignHost) {
      throw new Error("Hub GitHub authorization is limited to github.com");
    }
    token = await vault.token(row);
    env.GH_TOKEN = token;
    env.GH_HOST = "github.com";
    delete env.GITHUB_TOKEN;
    delete env.GH_ENTERPRISE_TOKEN;
    delete env.GITHUB_ENTERPRISE_TOKEN;
    delete env.GH_DEBUG;
    delete env.DEBUG;
    env.GH_PROMPT_DISABLED = "1";
  }
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { env, cwd: process.cwd(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    if (token) {
      redactCredentialStream(child.stdout, stdout, token);
      redactCredentialStream(child.stderr, stderr, token);
    } else { child.stdout.pipe(stdout, { end: false }); child.stderr.pipe(stderr, { end: false }); }
    stdin.pipe(child.stdin);
    child.stdin.on("error", () => {});
    child.once("error", () => reject(new Error("GitHub CLI could not start")));
    child.once("close", code => { stdin.unpipe(child.stdin); resolve(code ?? 1); });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runGitHubCli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(error.message + "\n"); process.exitCode = 1; }
}

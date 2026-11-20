import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GitHubAccountVault } from "../filesystem/github-account-vault.mjs";
import { githubInvocation } from "./github-gh-arguments.mjs";

const repositoryOperands = new Set(["archive", "clone", "create", "delete", "edit", "fork", "set-default", "sync", "unarchive", "view"]);
const issueOperands = new Set(["close", "comment", "delete", "develop", "edit", "lock", "pin", "reopen", "transfer", "unlock", "unpin", "view"]);
const prOperands = new Set(["checkout", "checks", "close", "comment", "diff", "edit", "lock", "merge", "ready", "reopen", "revert", "review", "unlock", "update-branch", "view"]);
const repositoryOptions = { "repo create": ["--template"], "repo sync": ["--source"], "issue develop": ["--branch-repo"] };

function assertGitHubTarget(value, repository = false) {
  if (!value) return;
  if (/^https?:\/\//iu.test(value)) {
    const url = new URL(value);
    if (["github.com", "api.github.com"].includes(url.hostname)) return;
  } else {
    const parts = value.split("/");
    const qualified = repository && parts.length >= 3;
    if (!qualified || parts[0].toLowerCase() === "github.com") return;
  }
  throw new Error("Hub GitHub authorization is limited to github.com");
}

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
    const { command: commandWords, operands, hostname, repository, values } = githubInvocation(args);
    const [command, operation] = commandWords;
    if (command === "auth" && ["login", "logout", "switch", "refresh", "setup-git", "token"].includes(operation)) {
      throw new Error("Управляйте общим GitHub-аккаунтом в Hub; токен не выводится и глобальная настройка Git не изменяется");
    }
    // gh treats additional domains as cloud hosts. This connection authorizes
    // github.com only, and must never forward its token to another server.
    if ((hostname ?? env.GH_HOST ?? "github.com").toLowerCase() !== "github.com") {
      throw new Error("Hub GitHub authorization is limited to github.com");
    }
    assertGitHubTarget(repository ?? env.GH_REPO ?? "", true);
    for (const flag of repositoryOptions[commandWords.join(" ")] ?? []) {
      for (const value of values.get(flag) ?? []) assertGitHubTarget(value, true);
    }
    // Only command-defined positional resources can select another host.
    // Release tags/assets and search queries are not repository selectors.
    if (command === "api") assertGitHubTarget(operands[0]);
    else if (command === "repo" && repositoryOperands.has(operation)) assertGitHubTarget(operands[0], true);
    else if (command === "issue" && issueOperands.has(operation) || command === "pr" && prOperands.has(operation)) {
      assertGitHubTarget(operands[0]);
      if (command === "issue" && operation === "transfer") assertGitHubTarget(operands[1], true);
    } else if (command === "label" && operation === "clone") assertGitHubTarget(operands[0], true);
    else if (command === "extension" && operation === "install") assertGitHubTarget(operands[0], true);
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

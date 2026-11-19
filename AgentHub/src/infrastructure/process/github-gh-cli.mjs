import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GitHubAccountVault } from "../filesystem/github-account-vault.mjs";

// These values are content, formatting, files or local command options, not
// authorization destinations. In particular a body can itself equal a flag.
const valueFlags = new Set(["--body", "--body-file", "--notes", "--notes-file", "--title",
  "--template", "--jq", "--json", "--field", "--raw-field", "--input", "--header",
  "--method", "--preview", "--cache", "--description", "--homepage", "--label",
  "--assignee", "--milestone", "--project", "--discussion-category", "--target", "--notes-start-tag",
  "--branch", "--base", "--head", "--search", "--limit", "--sort", "--order", "--state", "--author",
  "--app", "--filename", "--name", "--output", "--dir", "--pattern", "--reason", "--reviewer"]);

function shortValueFlag([command, operation], flag) {
  if (command === "api") return ["-F", "-f", "-H", "-X", "-p", "-q", "-t"].includes(flag);
  if (["issue", "pr"].includes(command)) {
    if (["-q", "-L", "-t"].includes(flag)) return true;
    if (["comment", "review"].includes(operation)) return ["-b", "-F"].includes(flag);
    if (["create", "new", "edit"].includes(operation)) {
      return ["-a", "-b", "-F", "-l", "-m", "-p", "-T", "-B", "-H", "-r"].includes(flag);
    }
  }
  if (command === "release") return ["-n", "-F", "-t", "-q", "-L", "-D"].includes(flag)
    || operation === "download" && flag === "-p";
  return command === "repo" && (["-q", "-t"].includes(flag) || operation === "create" && flag === "-d");
}

function githubInvocation(args) {
  const words = [];
  let hostname, repository;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--") { words.push(...args.slice(index + 1)); break; }
    const equal = argument.indexOf("="), flag = equal < 0 ? argument : argument.slice(0, equal);
    if (flag === "--hostname" || flag === "--repo" || flag === "-R") {
      const value = equal < 0 ? args[++index] : argument.slice(equal + 1);
      if (flag === "--hostname") hostname = value ?? ""; else repository = value ?? "";
    } else if (argument.startsWith("-R") && argument.length > 2) repository = argument.slice(2);
    else if (valueFlags.has(flag) || shortValueFlag(words, flag)
      || flag === "--comment" && ["issue", "pr"].includes(words[0]) && ["close", "reopen"].includes(words[1])) {
      if (equal < 0) index++;
    }
    else if (!argument.startsWith("-")) words.push(argument);
  }
  return { words, hostname, repository };
}

function assertGitHubTarget(value, repository = false) {
  if (!value) return;
  if (/^https?:\/\//iu.test(value)) {
    const url = new URL(value);
    if (["github.com", "api.github.com"].includes(url.hostname)) return;
  } else {
    const parts = value.split("/");
    const qualified = repository ? parts.length >= 3 : /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\//u.test(value);
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
    const { words: [command, operation, ...operands], hostname, repository } = githubInvocation(args);
    if (command === "auth" && ["login", "logout", "switch", "refresh", "setup-git", "token"].includes(operation)) {
      throw new Error("Управляйте общим GitHub-аккаунтом в Hub; токен не выводится и глобальная настройка Git не изменяется");
    }
    // gh treats additional domains as cloud hosts. This connection authorizes
    // github.com only, and must never forward its token to another server.
    if ((hostname ?? env.GH_HOST ?? "github.com").toLowerCase() !== "github.com") {
      throw new Error("Hub GitHub authorization is limited to github.com");
    }
    assertGitHubTarget(repository ?? env.GH_REPO ?? "", true);
    // Only command-defined positional resources can select another host.
    // Release tags/assets and search queries are not repository selectors.
    if (command === "api") assertGitHubTarget(operation);
    else if (command === "repo" && operation !== "list") assertGitHubTarget(operands[0], true);
    else if (["issue", "pr"].includes(command) && !["create", "new", "list", "status"].includes(operation)) {
      assertGitHubTarget(operands[0]);
    } else if (command === "label" && operation === "clone") assertGitHubTarget(operands[0], true);
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

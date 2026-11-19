import path from "node:path";
import { fileURLToPath } from "node:url";

const quote = value => '"' + String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n") + '"';
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export const githubDirectory = environment => String(environment.AGENT_HUB_GITHUB_DIRECTORY ?? "");
export const githubProfileFile = environment => githubDirectory(environment) ? path.join(githubDirectory(environment), "gitconfig") : "";

export function withoutGithubAccountEnvironment(environment = process.env) {
  const result = { ...environment }, directory = githubDirectory(result);
  if (!directory) return result;
  let count = Number(result.GIT_CONFIG_COUNT ?? 0);
  // Consume only the exact public include added by our provider boundary.
  // Arbitrary Git redirects/configuration remain for existing isolation guards.
  while (Number.isSafeInteger(count) && count > 0
    && result[`GIT_CONFIG_KEY_${count - 1}`] === "include.path"
    && result[`GIT_CONFIG_VALUE_${count - 1}`] === path.join(directory, "gitconfig")) {
    delete result[`GIT_CONFIG_KEY_${count - 1}`];
    delete result[`GIT_CONFIG_VALUE_${count - 1}`];
    count--;
    if (count) result.GIT_CONFIG_COUNT = String(count); else delete result.GIT_CONFIG_COUNT;
  }
  const pathKey = Object.keys(result).find(key => key.toLowerCase() === "path");
  if (pathKey) {
    const normalized = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    const bin = normalized(path.join(directory, "bin"));
    result[pathKey] = result[pathKey].split(path.delimiter).filter(value => !value || normalized(value) !== bin).join(path.delimiter);
  }
  delete result.AGENT_HUB_GITHUB_DIRECTORY;
  return result;
}

// Public metadata only. The helper decrypts a credential only inside Git's
// private credential pipe. Binding its generation rejects reconnect races.
export function githubGitConfig({ directory, id, account, node = process.execPath }) {
  if (!account) return "# GitHub account disconnected\n";
  const helper = fileURLToPath(new URL("../process/github-credential-helper.mjs", import.meta.url));
  const command = "!" + shellQuote(node.replaceAll("\\", "/")) + " " + shellQuote(helper.replaceAll("\\", "/"))
    + " " + shellQuote(directory.replaceAll("\\", "/")) + " " + shellQuote(id);
  return `[user]\n\tname = ${quote(account.name)}\n\temail = ${quote(account.email)}\n`
    + `[credential "https://github.com"]\n\thelper =\n\thelper = ${quote(command)}\n`
    + '[url "https://github.com/"]\n\tinsteadOf = git@github.com:\n\tinsteadOf = ssh://git@github.com/\n'
    + '\tinsteadOf = ssh://git@github.com:22/\n\tinsteadOf = ssh://git@ssh.github.com:443/\n';
}

export function githubAgentEnvironment(environment = process.env, directory = githubDirectory(environment)) {
  if (!directory) return { ...environment };
  const result = { ...environment, AGENT_HUB_GITHUB_DIRECTORY: directory };
  const count = Number(result.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 100) throw new Error("Invalid inherited Git command configuration");
  // The include path is stable for persistent provider processes. Git reads its
  // latest atomic contents for each new command, including after reconnect.
  result.GIT_CONFIG_COUNT = String(count + 1);
  result[`GIT_CONFIG_KEY_${count}`] = "include.path";
  result[`GIT_CONFIG_VALUE_${count}`] = path.join(directory, "gitconfig");
  // Child shells resolve the account-aware gh launcher; the provider receives
  // only this public locator, never GH_TOKEN or a decrypted credential.
  const pathKey = Object.keys(result).find(key => key.toLowerCase() === "path") ?? "PATH";
  result[pathKey] = path.join(directory, "bin") + path.delimiter + (result[pathKey] ?? "");
  for (const key of Object.keys(result)) if (/^(?:GH|GITHUB)_(?:ENTERPRISE_)?TOKEN$/iu.test(key)) delete result[key];
  return result;
}

export function githubCodexEnvironmentArguments(environment) {
  if (!githubDirectory(environment)) return [];
  const index = Number(environment.GIT_CONFIG_COUNT) - 1;
  const pathKey = Object.keys(environment).find(key => key.toLowerCase() === "path");
  // Codex applies shell exclusions before explicit set values. Forward only
  // this public account include, never inherited arbitrary config/secret values.
  // Existing provider security filters and unrelated set entries stay intact.
  const values = { AGENT_HUB_GITHUB_DIRECTORY: githubDirectory(environment),
    GIT_CONFIG_COUNT: environment.GIT_CONFIG_COUNT,
    [`GIT_CONFIG_KEY_${index}`]: "include.path",
    [`GIT_CONFIG_VALUE_${index}`]: githubProfileFile(environment),
    ...(pathKey ? { PATH: environment[pathKey] } : {}) };
  return Object.entries(values).flatMap(([key, value]) => ["-c", `shell_environment_policy.set.${key}=${JSON.stringify(value)}`]);
}

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function versionParts(value) {
  const match = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

function packageVersion(packageFile) {
  try {
    return String(JSON.parse(readFileSync(packageFile, "utf8"))?.version ?? "");
  } catch {
    return "";
  }
}

function vscodeCandidates(homeDirectory) {
  const candidates = [];
  for (const root of [
    path.join(homeDirectory, ".vscode", "extensions"),
    path.join(homeDirectory, ".vscode-insiders", "extensions"),
  ]) {
    let names = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const match = name.match(/^anthropic\.claude-code-(\d+\.\d+\.\d+)-win32-x64$/i);
      if (!match) continue;
      const command = path.join(root, name, "resources", "native-binary", "claude.exe");
      if (existsSync(command)) candidates.push({ command, prefixArgs: [], version: match[1], source: "vscode" });
    }
  }
  return candidates;
}

function npmCandidates(appData) {
  const packageRoot = path.join(appData, "npm", "node_modules", "@anthropic-ai", "claude-code");
  const version = packageVersion(path.join(packageRoot, "package.json"));
  return [
    { command: path.join(packageRoot, "bin", "claude.exe"), prefixArgs: [], version, source: "npm" },
    { command: process.execPath, prefixArgs: [path.join(packageRoot, "cli.js")], target: path.join(packageRoot, "cli.js"), version, source: "npm" },
    { command: process.execPath, prefixArgs: [path.join(packageRoot, "cli-wrapper.cjs")], target: path.join(packageRoot, "cli-wrapper.cjs"), version, source: "npm" },
  ].filter((candidate) => existsSync(candidate.target ?? candidate.command));
}

export function resolveClaudeInvocation({
  requested = "claude",
  prefixArgs = [],
  platform = process.platform,
  env = process.env,
} = {}) {
  const command = String(requested || "claude");
  if (prefixArgs.length || platform !== "win32" || command !== "claude") {
    return { command, prefixArgs: [...prefixArgs], version: null, source: "configured" };
  }

  const homeDirectory = String(env.USERPROFILE ?? env.HOME ?? "");
  const appData = String(env.APPDATA ?? "");
  const discovered = [
    ...vscodeCandidates(homeDirectory),
    ...npmCandidates(appData),
  ].sort((left, right) => compareVersions(left.version, right.version));
  if (discovered.length) return discovered[0];

  const localNative = path.join(homeDirectory, ".local", "bin", "claude.exe");
  if (existsSync(localNative)) {
    return { command: localNative, prefixArgs: [], version: null, source: "local" };
  }
  return { command, prefixArgs: [], version: null, source: "path" };
}

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function packageVersion(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return String(manifest.devDependencies?.wrangler ?? "").trim();
}

function wranglerCandidate(root) {
  return path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
}

function dependencyRoots(root, environment, gitCommonDirectory) {
  const roots = [root];
  const explicitRoot = String(environment.AGENT_HUB_DEPENDENCY_ROOT ?? "").trim();
  if (explicitRoot) {
    roots.push(explicitRoot, path.join(explicitRoot, "AgentHub"));
  }
  if (gitCommonDirectory) {
    const repositoryRoot = path.dirname(path.resolve(gitCommonDirectory));
    roots.push(repositoryRoot, path.join(repositoryRoot, "AgentHub"));
  }
  return [...new Set(roots.map((item) => path.resolve(item)))];
}

export function detectGitCommonDirectory(root = ROOT) {
  const result = spawnSync(
    "git",
    ["-c", `safe.directory=${path.resolve(root)}`, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    {
      cwd: root,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    },
  );
  return result.status === 0 ? String(result.stdout ?? "").trim() : "";
}

export function resolveWrangler({
  root = ROOT,
  environment = process.env,
  gitCommonDirectory = detectGitCommonDirectory(root),
} = {}) {
  const expectedVersion = packageVersion(root);
  for (const dependencyRoot of dependencyRoots(root, environment, gitCommonDirectory)) {
    const entry = wranglerCandidate(dependencyRoot);
    if (!existsSync(entry)) continue;
    const installedManifest = path.join(dependencyRoot, "node_modules", "wrangler", "package.json");
    const installedVersion = String(JSON.parse(readFileSync(installedManifest, "utf8")).version ?? "").trim();
    if (installedVersion === expectedVersion) return entry;
  }
  throw new Error(
    `Не найден локальный wrangler ${expectedVersion}. Выполните npm install в AgentHub `
      + "или задайте AGENT_HUB_DEPENDENCY_ROOT с уже установленной закреплённой версией.",
  );
}

export function runWrangler(args = process.argv.slice(2), options = {}) {
  const entry = resolveWrangler(options);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: options.root ?? ROOT,
      env: options.environment ?? process.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`wrangler завершён с ${signal ?? `кодом ${code}`}`));
    });
  });
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  runWrangler().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

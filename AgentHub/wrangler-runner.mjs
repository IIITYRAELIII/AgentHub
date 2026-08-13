import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export class WranglerDependencyError extends Error {}

function packageVersion(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  return String(manifest.devDependencies?.wrangler ?? "").trim();
}

function lockedWrangler(root) {
  const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const entry = lock.packages?.["node_modules/wrangler"];
  return {
    version: String(entry?.version ?? "").trim(),
    integrity: String(entry?.integrity ?? "").trim(),
  };
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
  let repositoryRoot = path.resolve(root);
  while (true) {
    const marker = path.join(repositoryRoot, ".git");
    if (existsSync(marker)) {
      if (statSync(marker).isDirectory()) return marker;
      const pointer = String(readFileSync(marker, "utf8")).trim().match(/^gitdir:\s*(.+)$/iu);
      if (pointer) {
        const gitDirectory = path.resolve(repositoryRoot, pointer[1]);
        const commonMarker = path.join(gitDirectory, "commondir");
        return existsSync(commonMarker)
          ? path.resolve(gitDirectory, String(readFileSync(commonMarker, "utf8")).trim())
          : gitDirectory;
      }
    }
    const parent = path.dirname(repositoryRoot);
    if (parent === repositoryRoot) break;
    repositoryRoot = parent;
  }

  /* Не запускаем Git как fallback. В изолированной worktree её служебная
     папка может принадлежать другому Windows SID, и Git намеренно откажется
     её читать. Если marker .git недоступен, явный AGENT_HUB_DEPENDENCY_ROOT
     остаётся безопасным способом указать каталог зависимостей. */
  return "";
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
  throw new WranglerDependencyError(
    `Не найден локальный wrangler ${expectedVersion}. Выполните npm install в AgentHub `
      + "или задайте AGENT_HUB_DEPENDENCY_ROOT с уже установленной закреплённой версией.",
  );
}

function installLockedDependencies({ root = ROOT, environment = process.env } = {}) {
  const npmCli = String(environment.npm_execpath ?? "").trim();
  const command = npmCli
    ? { executable: process.execPath, args: [npmCli, "ci", "--ignore-scripts"] }
    : process.platform === "win32"
      ? {
          executable: environment.ComSpec || "cmd.exe",
          args: ["/d", "/s", "/c", "npm", "ci", "--ignore-scripts"],
        }
      : { executable: "npm", args: ["ci", "--ignore-scripts"] };
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: root,
      env: environment,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ci завершён с ${signal ?? `кодом ${code}`}`));
    });
  });
}

export async function ensureWrangler(options = {}) {
  try {
    return resolveWrangler(options);
  } catch (error) {
    if (!(error instanceof WranglerDependencyError)) throw error;
  }
  const root = options.root ?? ROOT;
  const expectedVersion = packageVersion(root);
  const locked = lockedWrangler(root);
  if (locked.version !== expectedVersion || !locked.integrity) {
    throw new Error(
      `package-lock.json не закрепляет wrangler ${expectedVersion} с integrity; автоматическая установка остановлена.`,
    );
  }
  console.log(`\n==> Подготовка закреплённого wrangler ${expectedVersion}`);
  await (options.install ?? installLockedDependencies)({
    root,
    environment: options.environment ?? process.env,
  });
  return resolveWrangler(options);
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

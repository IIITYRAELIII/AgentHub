import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function findVscodeCodexExecutable({
  environment = process.env,
  platform = process.platform,
  readdirImpl = readdir,
  statImpl = stat,
  existsImpl = existsSync,
} = {}) {
  if (platform !== "win32") return null;
  const home = environment.USERPROFILE ?? "";
  const extensionRoots = [".vscode", ".vscode-insiders"]
    .map((directory) => path.join(home, directory, "extensions"));
  const candidates = [];
  for (const extensionsDir of extensionRoots) {
    let entries;
    try {
      entries = await readdirImpl(extensionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("openai.chatgpt-")) continue;
      const executable = path.join(extensionsDir, entry.name, "bin", "windows-x86_64", "codex.exe");
      if (!existsImpl(executable)) continue;
      const info = await statImpl(executable);
      candidates.push({ executable, mtimeMs: info.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.executable ?? null;
}

export async function resolveCodexExecutable({
  requested = "",
  environment = process.env,
  platform = process.platform,
  ...options
} = {}) {
  if (String(requested).trim()) return String(requested).trim();
  const vscodeExecutable = await findVscodeCodexExecutable({ environment, platform, ...options });
  if (vscodeExecutable) return vscodeExecutable;
  if (platform !== "win32") return "codex";
  const sandboxExecutable = path.join(environment.USERPROFILE ?? "", ".codex", ".sandbox-bin", "codex.exe");
  if ((options.existsImpl ?? existsSync)(sandboxExecutable)) return sandboxExecutable;
  return "codex";
}

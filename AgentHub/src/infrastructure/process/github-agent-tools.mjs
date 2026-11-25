import { access, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicAccountFile } from "../filesystem/github-account-vault.mjs";

export async function prepareGitHubAgentTools(directory, environment = process.env) {
  const bin = path.join(directory, "bin");
  await mkdir(bin, { recursive: true });
  let executable = null;
  for (const folder of String(environment.PATH ?? environment.Path ?? "").split(path.delimiter)) {
    if (!folder || path.resolve(folder) === bin) continue;
    const candidate = path.join(folder, process.platform === "win32" ? "gh.exe" : "gh");
    if (await access(candidate).then(() => true, () => false)) { executable = candidate; break; }
  }
  await atomicAccountFile(path.join(directory, "tools.json"), JSON.stringify({ gh: executable }));
  const runner = fileURLToPath(new URL("./github-gh-cli.mjs", import.meta.url));
  const escapeCmd = value => String(value).replaceAll("%", "%%");
  await atomicAccountFile(path.join(bin, "gh.cmd"), `@echo off\r\n"${escapeCmd(process.execPath)}" "${escapeCmd(runner)}" %*\r\n`);
  const sq = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await atomicAccountFile(path.join(bin, "gh"), `#!/bin/sh\nexec ${sq(process.execPath.replaceAll("\\", "/"))} ${sq(runner.replaceAll("\\", "/"))} "$@"\n`);
  if (process.platform !== "win32") await chmod(path.join(bin, "gh"), 0o700);
}

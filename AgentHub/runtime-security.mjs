import { spawn } from "node:child_process";
import { chmod } from "node:fs/promises";
import process from "node:process";

export function runtimeSecretAclArguments(filePath, environment = process.env) {
  const domain = String(environment.USERDOMAIN ?? "").trim();
  const user = String(environment.USERNAME ?? environment.USER ?? "").trim();
  if (!user) throw new Error("Cannot determine the runtime owner for config ACL");
  const owner = domain ? `${domain}\\${user}` : user;
  return [
    filePath,
    "/inheritance:r",
    "/grant:r",
    `${owner}:(F)`,
    "*S-1-5-18:(F)",
    "*S-1-5-32-544:(F)",
  ];
}

export function runtimeDirectoryAclArguments(directoryPath, environment = process.env) {
  const domain = String(environment.USERDOMAIN ?? "").trim();
  const user = String(environment.USERNAME ?? environment.USER ?? "").trim();
  if (!user) throw new Error("Cannot determine the runtime owner for directory ACL");
  const owner = domain ? `${domain}\\${user}` : user;
  return [
    directoryPath,
    "/inheritance:r",
    "/grant:r",
    `${owner}:(OI)(CI)(F)`,
    "*S-1-5-18:(OI)(CI)(F)",
    "*S-1-5-32-544:(OI)(CI)(F)",
  ];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

export async function protectRuntimeConfig(filePath, {
  platform = process.platform,
  environment = process.env,
  runCommand = run,
} = {}) {
  if (platform === "win32") {
    await runCommand("icacls.exe", runtimeSecretAclArguments(filePath, environment));
    return;
  }
  await chmod(filePath, 0o600);
}

export async function protectRuntimeDirectory(directoryPath, {
  platform = process.platform,
  environment = process.env,
  runCommand = run,
} = {}) {
  if (platform === "win32") {
    await runCommand(
      "icacls.exe",
      runtimeDirectoryAclArguments(directoryPath, environment),
    );
    return;
  }
  await chmod(directoryPath, 0o700);
}

import { execFile, spawn } from "node:child_process";
import { chmod, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execute = promisify(execFile);
// Read only the directory's effective control ACL. No recursion, grant, source
// interpolation or application launch occurs in this bounded metadata child.
const directoryProtectionQuery = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$acl=[System.IO.Directory]::GetAccessControl($env:AGENT_HUB_ACL_DIRECTORY)
$owner=[System.Security.Principal.NTAccount]::new($env:AGENT_HUB_ACL_OWNER).Translate([System.Security.Principal.SecurityIdentifier]).Value
$expected=[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
[void]$expected.Add($owner);[void]$expected.Add('S-1-5-18');[void]$expected.Add('S-1-5-32-544')
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
$valid=$acl.AreAccessRulesProtected -and $acl.AreAccessRulesCanonical -and $rules.Count -eq $expected.Count
$seen=[System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
foreach($rule in $rules) {
 $sid=$rule.IdentityReference.Value
 $valid=$valid -and -not $rule.IsInherited -and $rule.AccessControlType -eq 'Allow' -and
  $rule.FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
  $rule.InheritanceFlags -eq ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit) -and
  $rule.PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and
  $expected.Contains($sid) -and -not $seen.Contains($sid)
 [void]$seen.Add($sid)
}
if($valid){[Console]::Write('true')}else{[Console]::Write('false')}
`;

export async function hasRuntimeDirectoryProtection(directoryPath, environment = process.env) {
  try {
    const before = await stat(directoryPath), resolved = await realpath(directoryPath);
    if (!before.isDirectory()) return false;
    const domain = String(environment.USERDOMAIN ?? "").trim();
    const user = String(environment.USERNAME ?? environment.USER ?? "").trim();
    if (!user) return false;
    const windows = process.env.SystemRoot ?? process.env.WINDIR;
    if (!windows) return false;
    const result = await execute(path.join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", directoryProtectionQuery], {
        windowsHide: true, encoding: "utf8", timeout: 5000, maxBuffer: 16384,
        env: { ...process.env, AGENT_HUB_ACL_DIRECTORY: path.resolve(directoryPath),
          AGENT_HUB_ACL_OWNER: domain ? `${domain}\\${user}` : user },
      });
    const after = await stat(directoryPath);
    return result.stdout.trim() === "true" && after.isDirectory()
      && after.dev === before.dev && after.ino === before.ino && await realpath(directoryPath) === resolved;
  } catch {
    // An unavailable proof never skips protection. The existing mutating owner
    // still applies its ordinary ACL and preserves that operation's failure.
    return false;
  }
}

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
  if (environment.AGENT_HUB_DISABLE_SECRET_ACL === "1") return;
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
  inspectDirectory = hasRuntimeDirectoryProtection,
} = {}) {
  if (environment.AGENT_HUB_DISABLE_SECRET_ACL === "1") return;
  if (platform === "win32") {
    if (await inspectDirectory(directoryPath, environment)) return;
    await runCommand(
      "icacls.exe",
      runtimeDirectoryAclArguments(directoryPath, environment),
    );
    return;
  }
  await chmod(directoryPath, 0o700);
}

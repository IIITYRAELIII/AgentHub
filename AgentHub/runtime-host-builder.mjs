import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  return null;
}

export function runtimeHostCompilerCandidates(environment = process.env) {
  const windows = environment.WINDIR || environment.SystemRoot || "C:\\Windows";
  return [
    path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
}

export async function runtimeHostSourceHash(sourceRoot) {
  const hostRoot = path.join(sourceRoot, "RuntimeHost");
  const hash = createHash("sha256");
  hash.update("agent-hub-runtime-host-build-v1\0", "utf8");
  for (const name of ["AgentHub.RuntimeHost.cs", "app.manifest"]) {
    hash.update(name, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(path.join(hostRoot, name)));
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

export async function buildWindowsRuntimeHost({
  sourceRoot,
  outputFile,
  environment = process.env,
  execute = runFile,
} = {}) {
  if (!sourceRoot || !outputFile) throw new TypeError("sourceRoot and outputFile are required");
  const compiler = await firstExisting(runtimeHostCompilerCandidates(environment));
  if (!compiler) throw new Error("System C# compiler for Agent Hub RuntimeHost was not found");
  const hostRoot = path.join(sourceRoot, "RuntimeHost");
  const source = path.join(hostRoot, "AgentHub.RuntimeHost.cs");
  const manifest = path.join(hostRoot, "app.manifest");
  await access(source);
  await access(manifest);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await execute(compiler, [
    "/nologo",
    "/target:winexe",
    "/optimize+",
    "/platform:anycpu",
    `/out:${outputFile}`,
    `/win32manifest:${manifest}`,
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Management.dll",
    "/reference:System.Web.Extensions.dll",
    source,
  ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  await access(outputFile);
  return outputFile;
}

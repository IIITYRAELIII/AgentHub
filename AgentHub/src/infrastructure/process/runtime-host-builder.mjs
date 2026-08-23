import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const ICON_SOURCE = path.join("VSCodeExtension", "media", "agent-hub-mark.png");

export function windowsIconFromPng(png) {
  if (!Buffer.isBuffer(png) || png.length < 24
    || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Agent Hub RuntimeHost icon must be a PNG image");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 256 || height !== 256) {
    throw new Error(`Agent Hub RuntimeHost icon must be 256x256, received ${width}x${height}`);
  }
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(0, 6);
  header.writeUInt8(0, 7);
  header.writeUInt8(0, 8);
  header.writeUInt8(0, 9);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

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
  hash.update("agent-hub-runtime-host-build-v2\0", "utf8");
  for (const name of ["AgentHub.RuntimeHost.cs", "app.manifest"]) {
    hash.update(name, "utf8");
    hash.update("\0", "utf8");
    hash.update(await readFile(path.join(hostRoot, name)));
    hash.update("\0", "utf8");
  }
  hash.update(ICON_SOURCE, "utf8");
  hash.update("\0", "utf8");
  hash.update(await readFile(path.join(sourceRoot, ICON_SOURCE)));
  hash.update("\0", "utf8");
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
  const iconSource = path.join(sourceRoot, ICON_SOURCE);
  const icon = path.join(path.dirname(outputFile), `AgentHub.RuntimeHost-${randomUUID()}.ico`);
  await access(source);
  await access(manifest);
  await access(iconSource);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(icon, windowsIconFromPng(await readFile(iconSource)));
  try {
    await execute(compiler, [
      "/nologo",
      "/target:winexe",
      "/optimize+",
      "/platform:anycpu",
      `/out:${outputFile}`,
      `/win32manifest:${manifest}`,
      `/win32icon:${icon}`,
      "/reference:System.dll",
      "/reference:System.Core.dll",
      "/reference:System.Management.dll",
      "/reference:System.Web.Extensions.dll",
      source,
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
  } finally {
    await rm(icon, { force: true });
  }
  await access(outputFile);
  return outputFile;
}

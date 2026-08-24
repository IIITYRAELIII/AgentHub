import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const ICON_SOURCE = path.join("VSCodeExtension", "media", "agent-hub-mark.png");
const ICON_BUILDER_SOURCE = path.join("RuntimeHost", "AgentHub.IconBuilder.cs");

export function windowsIconEntries(icon) {
  if (!Buffer.isBuffer(icon) || icon.length < 6
    || icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1) {
    throw new Error("Agent Hub RuntimeHost icon must be a Windows ICO image");
  }
  const count = icon.readUInt16LE(4);
  if (icon.length < 6 + (16 * count)) {
    throw new Error("Agent Hub RuntimeHost icon directory is truncated");
  }
  return Array.from({ length: count }, (_, index) => {
    const entry = 6 + (16 * index);
    const bytes = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    if (offset + bytes > icon.length) {
      throw new Error("Agent Hub RuntimeHost icon layer is truncated");
    }
    return {
      width: icon[entry] || 256,
      height: icon[entry + 1] || 256,
      bitsPerPixel: icon.readUInt16LE(entry + 6),
      bytes,
      offset,
    };
  });
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
  hash.update("agent-hub-runtime-host-build-v3\0", "utf8");
  for (const name of ["AgentHub.RuntimeHost.cs", "AgentHub.IconBuilder.cs", "app.manifest"]) {
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

export async function buildWindowsIcon({
  sourceRoot,
  outputFile,
  environment = process.env,
  execute = runFile,
} = {}) {
  if (!sourceRoot || !outputFile) throw new TypeError("sourceRoot and outputFile are required");
  const compiler = await firstExisting(runtimeHostCompilerCandidates(environment));
  if (!compiler) throw new Error("System C# compiler for Agent Hub RuntimeHost was not found");
  const source = path.join(sourceRoot, ICON_BUILDER_SOURCE);
  const iconSource = path.join(sourceRoot, ICON_SOURCE);
  const builder = path.join(path.dirname(outputFile), `AgentHub.IconBuilder-${randomUUID()}.exe`);
  await access(source);
  await access(iconSource);
  await mkdir(path.dirname(outputFile), { recursive: true });
  try {
    await execute(compiler, [
      "/nologo",
      "/target:exe",
      "/optimize+",
      `/out:${builder}`,
      "/reference:System.dll",
      "/reference:System.Drawing.dll",
      source,
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    await execute(builder, [iconSource, outputFile], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } finally {
    await rm(builder, { force: true });
  }
  await access(outputFile);
  return outputFile;
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
  await buildWindowsIcon({ sourceRoot, outputFile: icon, environment, execute });
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

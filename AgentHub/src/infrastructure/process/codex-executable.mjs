import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const CODEX_VERSION_OUTPUT = /\bcodex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/i;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;

export function isOpenAiSignerSubject(subject) {
  const match = String(subject ?? "").match(/(?:^|,\s*)CN=(?:"([^"]+)"|((?:\\.|[^,])+))/i);
  const commonName = String(match?.[1] ?? match?.[2] ?? "").replaceAll("\\,", ",").trim();
  return commonName.toLowerCase() === "openai opco, llc";
}

function pathInsideOrSame(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function prereleaseParts(value) {
  return value ? value.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part)) : [];
}

export function parseCodexVersion(value) {
  const normalized = String(value ?? "").trim();
  const match = normalized.match(VERSION_PATTERN);
  if (!match) return null;
  return {
    raw: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: prereleaseParts(match[4] ?? ""),
  };
}

export function compareCodexVersions(left, right) {
  const a = typeof left === "string" ? parseCodexVersion(left) : left;
  const b = typeof right === "string" ? parseCodexVersion(right) : right;
  if (!a || !b) throw new TypeError("Both Codex versions must be valid");
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y !== "number") return -1;
    if (typeof x !== "number" && typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

async function runBounded(command, args, {
  timeoutMs = 5_000,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const append = (current, chunk) => `${current}${chunk}`.slice(0, MAX_PROCESS_OUTPUT_BYTES);
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code === 0) finish(null, { stdout, stderr });
      else {
        const detail = String(stderr || stdout).trim().slice(0, 1_000);
        finish(new Error(`Process exited with code=${code} signal=${signal ?? "none"}${detail ? `: ${detail}` : ""}`));
      }
    });
    timer = setTimeout(() => {
      child.kill?.("SIGKILL");
      finish(new Error(`Process timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

export async function verifyOpenAiAuthenticode(executable, options = {}) {
  const literalPath = String(executable).replaceAll("'", "''");
  const script = [
    "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
    `$signature=Get-AuthenticodeSignature -LiteralPath '${literalPath}'`,
    "[pscustomobject]@{Status=$signature.Status.ToString();Subject=$signature.SignerCertificate.Subject}|ConvertTo-Json -Compress",
  ].join(";");
  const { stdout } = await runBounded(
    options.powershellExecutable ?? "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    options,
  );
  const signature = JSON.parse(stdout);
  const publisher = String(signature?.Subject ?? "").trim();
  return {
    valid: signature?.Status === "Valid" && isOpenAiSignerSubject(publisher),
    status: String(signature?.Status ?? "Unknown"),
    publisher,
  };
}

export async function readCodexExecutableVersion(executable, options = {}) {
  const { stdout } = await runBounded(executable, ["--version"], options);
  const match = stdout.match(CODEX_VERSION_OUTPUT);
  if (!match || !parseCodexVersion(match[1])) throw new Error("Codex executable returned an unsupported version");
  return match[1];
}

export function officialCodexInstallRoots({ environment = process.env } = {}) {
  const profile = String(environment.USERPROFILE ?? "").trim();
  const localAppData = String(environment.LOCALAPPDATA ?? "").trim();
  return [
    profile && { source: "vscode", root: path.join(profile, ".vscode", "extensions") },
    profile && { source: "vscode-insiders", root: path.join(profile, ".vscode-insiders", "extensions") },
    localAppData && { source: "desktop", root: path.join(localAppData, "OpenAI", "Codex", "bin") },
  ].filter(Boolean);
}

export async function enumerateOfficialCodexPaths({
  environment = process.env,
  platform = process.platform,
  readdirImpl = readdir,
} = {}) {
  if (platform !== "win32") return [];
  const candidates = [];
  for (const layout of officialCodexInstallRoots({ environment })) {
    let entries;
    try {
      entries = await readdirImpl(layout.root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (layout.source.startsWith("vscode") && !entry.name.startsWith("openai.chatgpt-")) continue;
      const executable = layout.source === "desktop"
        ? path.join(layout.root, entry.name, "codex.exe")
        : path.join(layout.root, entry.name, "bin", "windows-x86_64", "codex.exe");
      candidates.push({ executable, source: layout.source, installRoot: layout.root });
    }
  }
  return candidates;
}

export async function inspectOfficialCodexCandidate(candidate, {
  realpathImpl = realpath,
  statImpl = stat,
  verifySignature = verifyOpenAiAuthenticode,
  readVersion = readCodexExecutableVersion,
  hashFile = sha256File,
} = {}) {
  const canonicalRoot = await realpathImpl(candidate.installRoot);
  const canonicalPath = await realpathImpl(candidate.executable);
  if (!pathInsideOrSame(canonicalPath, canonicalRoot)) throw new Error("Codex executable escapes its official install root");
  const info = await statImpl(canonicalPath);
  if (!info.isFile()) throw new Error("Codex executable candidate is not a file");
  const signature = await verifySignature(canonicalPath);
  if (!signature?.valid) throw new Error(`Codex executable signature is not trusted (${signature?.status ?? "unknown"})`);
  const hashBefore = await hashFile(canonicalPath);
  const version = await readVersion(canonicalPath);
  const hashAfter = await hashFile(canonicalPath);
  if (hashBefore !== hashAfter) throw new Error("Codex executable changed during verification");
  return {
    path: canonicalPath,
    version,
    sha256: hashAfter,
    publisher: signature.publisher,
    signatureStatus: signature.status,
    source: candidate.source,
  };
}

export async function discoverOfficialCodexExecutables({
  platform = process.platform,
  enumerateCandidates = enumerateOfficialCodexPaths,
  inspectCandidate = inspectOfficialCodexCandidate,
  ...options
} = {}) {
  if (platform !== "win32") return { candidates: [], rejected: [] };
  const discovered = await enumerateCandidates({ platform, ...options });
  const candidates = [];
  const rejected = [];
  for (const candidate of discovered) {
    try {
      candidates.push(await inspectCandidate(candidate, options));
    } catch (error) {
      rejected.push({ path: candidate.executable, source: candidate.source, error: error.message });
    }
  }
  candidates.sort((left, right) => {
    const versionOrder = compareCodexVersions(right.version, left.version);
    return versionOrder || left.path.localeCompare(right.path, "en", { sensitivity: "base" });
  });
  return { candidates, rejected };
}

export async function findVscodeCodexExecutable(options = {}) {
  const { candidates } = await discoverOfficialCodexExecutables(options);
  return candidates.find((candidate) => candidate.source.startsWith("vscode"))?.path ?? null;
}

export async function resolveCodexExecutable({
  requested = "",
  environment = process.env,
  platform = process.platform,
  discover = discoverOfficialCodexExecutables,
  ...options
} = {}) {
  if (String(requested).trim()) return String(requested).trim();
  const { candidates } = await discover({ environment, platform, ...options });
  if (candidates.length) return candidates[0].path;
  if (platform !== "win32") return "codex";
  return path.join(environment.USERPROFILE ?? "", ".codex", ".sandbox-bin", "codex.exe");
}

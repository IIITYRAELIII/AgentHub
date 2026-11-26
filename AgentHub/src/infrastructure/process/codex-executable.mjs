import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { CODEX_REQUIRED_HELPER_MISSING, inspectCodexExecutableBundle,
  isCodexBundleSignatureRejectionMessage, sameCodexBundleIdentity, validCodexBundle } from "./codex-executable-bundle.mjs";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const CODEX_VERSION_OUTPUT = /\bcodex-cli\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/i;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const CODEX_HASH_CHUNK_BYTES = 1024 * 1024;
const CODEX_EXECUTABLE_SIGNATURE_REJECTED = "CODEX_EXECUTABLE_SIGNATURE_REJECTED";
export const CODEX_CANDIDATE_MISSING = "CODEX_CANDIDATE_MISSING";
const installPathMissing = error => ["ENOENT", "ENOTDIR"].includes(error?.code);

function definitiveDiscoveryRejection(error) {
  if (error?.code === "CODEX_BUNDLE_UNAVAILABLE") return error.reason === CODEX_REQUIRED_HELPER_MISSING;
  return [CODEX_CANDIDATE_MISSING, CODEX_EXECUTABLE_SIGNATURE_REJECTED].includes(error?.code);
}

export function isCodexExecutableSignatureRejectionMessage(message) {
  return typeof message === "string"
    && /^Codex executable signature is not trusted \((?:Valid|UnknownError|NotSigned|HashMismatch|NotTrusted|NotSupportedFileFormat|Incompatible|unknown)\)$/u.test(message);
}

export function isCodexPreflightRejectionMessage(message) {
  return isCodexExecutableSignatureRejectionMessage(message)
    || message === "Codex executable inspection failed (ENOENT)"
    || message === "Codex executable inspection failed (ENOTDIR)";
}

export function codexExecutableRejectionMessage(error) {
  const message = String(error?.message ?? error ?? "");
  if (isCodexBundleSignatureRejectionMessage(message) || /^Process timed out after \d{1,9} ms$/.test(message)
    || /^Process exited with code=(?:-?\d{1,12}|null) signal=(?:SIG[A-Z0-9]{1,12}|none)$/.test(message)
    || isCodexExecutableSignatureRejectionMessage(message)
    || [
      "Codex executable escapes its official install root",
      "Codex executable candidate is not a file",
      "Codex executable changed during signature verification",
      "Codex executable changed during version verification",
      "Codex executable returned an unsupported version",
      "Authenticode inspection returned invalid JSON",
      "Recorded Codex executable identity is invalid",
      "Recorded Codex executable verification is Windows-only",
      "Recorded Codex executable canonical path changed",
      "Recorded Codex executable does not match its official install layout",
      "Recorded Codex executable SHA-256 changed",
      "signature is not trusted",
      "Required Codex code-mode host is missing from the selected bundle",
      "Recorded Codex bundle identity changed",
      "Codex bundle member signature is not trusted",
      "Codex bundle contains a reparse member",
      "Codex bundle member canonical path changed",
      "Codex executable changed during bundle verification",
    ].includes(message)) return message;
  if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO", "EBUSY", "ELOOP", "EINVAL", "UNKNOWN"].includes(error?.code)) {
    return `Codex executable inspection failed (${error.code})`;
  }
  if (/^Codex executable inspection failed \((?:ENOENT|ENOTDIR|EACCES|EPERM|EIO|EBUSY|ELOOP|EINVAL|UNKNOWN)\)$/.test(message)) return message;
  return "Codex executable inspection failed";
}

export function summarizeCodexExecutableRejections(rejected = []) {
  const entries = rejected.slice(0, 4).map((entry) => {
    const source = ["desktop", "vscode", "vscode-insiders"].includes(entry.source) ? entry.source : "candidate";
    return `${source}: ${codexExecutableRejectionMessage(entry.error)}`;
  });
  if (rejected.length > entries.length) entries.push(`${rejected.length - entries.length} more rejected`);
  return entries.length ? `; rejected: ${entries.join("; ")}` : "";
}

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
    child.stdout?.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (code === 0) finish(null, { stdout, stderr });
      else {
        finish(new Error(`Process exited with code=${code} signal=${signal ?? "none"}`));
      }
    });
    timer = setTimeout(() => {
      child.kill?.("SIGKILL");
      finish(new Error(`Process timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();
  });
}

async function sha256File(file, { measure = (_phase, work) => work() } = {}) {
  const hash = createHash("sha256");
  const handle = await measure("recordedMainOpenMs", () => open(file, "r"));
  try {
    const chunks = handle.createReadStream({ highWaterMark: CODEX_HASH_CHUNK_BYTES, autoClose: false })[Symbol.asyncIterator]();
    const first = await measure("recordedMainFirstReadMs", () => chunks.next());
    if (!first.done) hash.update(first.value);
    for await (const chunk of chunks) hash.update(chunk);
    return hash.digest("hex").toUpperCase();
  } finally {
    await handle.close();
  }
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
  let signature;
  try {
    signature = JSON.parse(stdout);
  } catch {
    throw new Error("Authenticode inspection returned invalid JSON");
  }
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

export async function readCodexExecutableFeatures(executable, { executableArgs = [], ...options } = {}) {
  const { stdout } = await runBounded(executable, [...executableArgs, "features", "list"], options);
  return { codeModeHost: /^code_mode_host\s+\S[^\r\n]*\s+true\s*$/mu.test(stdout) };
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

function sameCanonicalPath(left, right) {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function sameRelativePath(leftRoot, leftPath, rightRoot, rightPath) {
  return sameCanonicalPath(path.relative(leftRoot, leftPath), path.relative(rightRoot, rightPath));
}

function validRecordedCodexIdentity(candidate) {
  return Boolean(candidate
    && typeof candidate.path === "string" && path.isAbsolute(candidate.path)
    && typeof candidate.version === "string" && parseCodexVersion(candidate.version)
    && typeof candidate.sha256 === "string" && /^[A-F0-9]{64}$/.test(candidate.sha256)
    && typeof candidate.publisher === "string" && isOpenAiSignerSubject(candidate.publisher)
    && ["desktop", "vscode", "vscode-insiders"].includes(candidate.source)
    && (candidate.signatureStatus === undefined || candidate.signatureStatus === "Valid"));
}

function matchesOfficialCodexLayout(canonicalPath, canonicalRoot, source) {
  if (!pathInsideOrSame(canonicalPath, canonicalRoot)) return false;
  const parts = path.relative(canonicalRoot, canonicalPath).toLowerCase().split(path.sep);
  if (source === "desktop") return parts.length === 2 && parts[0] !== "" && parts[1] === "codex.exe";
  return parts.length === 4 && parts[0].startsWith("openai.chatgpt-")
    && parts[1] === "bin" && parts[2] === "windows-x86_64" && parts[3] === "codex.exe";
}

export async function verifyRecordedCodexExecutable(candidate, {
  environment = process.env,
  platform = process.platform,
  realpathImpl = realpath,
  statImpl = stat,
  hashFile = sha256File,
  inspectBundle = inspectCodexExecutableBundle,
  readFeatures = readCodexExecutableFeatures,
  acquireInspectionCustody,
  executableArgs = [],
  retainCustody,
  measure = (_phase, work) => work(),
} = {}) {
  if (platform !== "win32") throw new Error("Recorded Codex executable verification is Windows-only");
  if (!validRecordedCodexIdentity(candidate)) throw new Error("Recorded Codex executable identity is invalid");
  let canonicalPath;
  try {
    canonicalPath = await realpathImpl(candidate.path);
  } catch (error) {
    if (!installPathMissing(error)) throw error;
    throw Object.assign(new Error(codexExecutableRejectionMessage(error)), { code: CODEX_CANDIDATE_MISSING });
  }
  const layout = officialCodexInstallRoots({ environment }).find((entry) => entry.source === candidate.source);
  if (!layout) throw new Error("Recorded Codex executable does not match its official install layout");
  const canonicalRoot = await realpathImpl(layout.root);
  const suppliedRoot = pathInsideOrSame(candidate.path, layout.root)
    ? layout.root
    : (pathInsideOrSame(candidate.path, canonicalRoot) ? canonicalRoot : null);
  if (!suppliedRoot) {
    throw new Error("Recorded Codex executable does not match its official install layout");
  }
  if (!pathInsideOrSame(canonicalPath, canonicalRoot)) {
    throw new Error("Codex executable escapes its official install root");
  }
  if (!sameRelativePath(suppliedRoot, candidate.path, canonicalRoot, canonicalPath)) {
    throw new Error("Recorded Codex executable canonical path changed");
  }
  if (!pathInsideOrSame(canonicalPath, canonicalRoot)) throw new Error("Codex executable escapes its official install root");
  if (!matchesOfficialCodexLayout(canonicalPath, canonicalRoot, candidate.source)) {
    throw new Error("Recorded Codex executable does not match its official install layout");
  }
  const info = await statImpl(canonicalPath);
  if (!info.isFile()) throw new Error("Codex executable candidate is not a file");
  if (candidate.bundle && !validCodexBundle(candidate.bundle)) {
    throw new Error("Recorded Codex bundle identity is invalid");
  }
  // A full recorded bundle is hashed once by native custody before any probe.
  // A legacy main-only record must still establish the main digest separately.
  let verifiedMainSha256;
  if (!candidate.bundle || inspectBundle !== inspectCodexExecutableBundle) {
    verifiedMainSha256 = await measure("recordedMainHashMs", () => hashFile(canonicalPath, { measure }));
    if (verifiedMainSha256 !== candidate.sha256) {
      throw new Error("Recorded Codex executable SHA-256 changed");
    }
  }
  // Transfer the lease only after comparing the effective feature and full
  // recorded identity. Other callers still receive a verification-only result.
  let held;
  try {
    const bundle = await inspectBundle({ ...candidate, path: canonicalPath }, { hashFile, readFeatures, executableArgs,
      acquireInspectionCustody, installRoot: canonicalRoot, expectedBundle: candidate.bundle, verifiedMainSha256, measure,
      ...(retainCustody ? { retainCustody: custody => { held = custody; } } : {}) });
    if (candidate.bundle && !sameCodexBundleIdentity(bundle, candidate.bundle)) {
      throw Object.assign(new Error("Recorded Codex bundle identity changed"), { code: "CODEX_BUNDLE_UNAVAILABLE" });
    }
    if (held) {
      retainCustody(held);
      held = null;
    }
    return bundle ? { ...candidate, bundle } : candidate;
  } finally {
    if (held) await measure("inspectionReleaseMs", () => held.release());
  }
}

export async function enumerateOfficialCodexPaths({
  environment = process.env,
  platform = process.platform,
  readdirImpl = readdir,
  onIncomplete = () => {},
} = {}) {
  if (platform !== "win32") return [];
  const candidates = [];
  for (const layout of officialCodexInstallRoots({ environment })) {
    let entries;
    try {
      entries = await readdirImpl(layout.root, { withFileTypes: true });
    } catch (error) {
      if (!installPathMissing(error)) onIncomplete();
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
  trustedCandidates = [],
  inspectBundle = inspectCodexExecutableBundle,
  readFeatures = readCodexExecutableFeatures,
  acquireInspectionCustody,
  executableArgs = [],
  measure = (_phase, work) => work(),
} = {}) {
  let canonicalRoot, canonicalPath;
  try {
    canonicalRoot = await realpathImpl(candidate.installRoot);
    canonicalPath = await realpathImpl(candidate.executable);
  } catch (error) {
    if (!installPathMissing(error)) throw error;
    throw Object.assign(new Error(codexExecutableRejectionMessage(error)), { code: CODEX_CANDIDATE_MISSING });
  }
  if (!pathInsideOrSame(canonicalPath, canonicalRoot)) throw new Error("Codex executable escapes its official install root");
  const info = await statImpl(canonicalPath);
  if (!info.isFile()) throw new Error("Codex executable candidate is not a file");
  const hashBeforeSignature = await hashFile(canonicalPath);
  const trusted = trustedCandidates.find((entry) => validRecordedCodexIdentity(entry)
    && sameCanonicalPath(entry.path, canonicalPath)
    && entry.source === candidate.source && entry.sha256 === hashBeforeSignature);
  if (trusted) {
    const current = { ...trusted, path: canonicalPath };
    const bundle = await inspectBundle(current, { hashFile, readFeatures, executableArgs,
      acquireInspectionCustody, installRoot: canonicalRoot, measure });
    return bundle ? { ...current, bundle } : current;
  }
  const signature = await measure("signatureMs", () => verifySignature(canonicalPath));
  const hashAfterSignature = await hashFile(canonicalPath);
  if (hashBeforeSignature !== hashAfterSignature) {
    throw new Error("Codex executable changed during signature verification");
  }
  if (!signature?.valid) throw Object.assign(new Error(`Codex executable signature is not trusted (${signature?.status ?? "unknown"})`),
    { code: CODEX_EXECUTABLE_SIGNATURE_REJECTED });
  let version;
  const beforeFeatures = async () => {
    version = await measure("versionProbeMs", () => readVersion(canonicalPath));
    if (!parseCodexVersion(version)) throw new Error("Codex executable returned an unsupported version");
    if (hashAfterSignature !== await hashFile(canonicalPath)) {
      throw new Error("Codex executable changed during version verification");
    }
  };
  const inspected = {
    path: canonicalPath,
    sha256: hashAfterSignature,
    publisher: signature.publisher,
    signatureStatus: signature.status,
    source: candidate.source,
  };
  const bundle = await inspectBundle(inspected, { hashFile, readFeatures, executableArgs,
    beforeFeatures, acquireInspectionCustody, installRoot: canonicalRoot, measure });
  if (!parseCodexVersion(version)) throw new Error("Codex executable returned an unsupported version");
  return { ...inspected, version, ...(bundle ? { bundle } : {}) };
}

/**
 * selectedPath narrows fresh installed-layout enumeration by canonical path.
 * The enumerated descriptor supplies installRoot/source; selection supplies no trust.
 */
export async function discoverOfficialCodexExecutables({
  platform = process.platform,
  enumerateCandidates = enumerateOfficialCodexPaths,
  inspectCandidate = inspectOfficialCodexCandidate,
  selectedPath = null,
  realpathImpl = realpath,
  ...options
} = {}) {
  if (platform !== "win32") return { candidates: [], rejected: [], inspectionComplete: false };
  let inspectionComplete = true;
  const discovered = await enumerateCandidates({ platform, ...options, onIncomplete: () => { inspectionComplete = false; } });
  const candidates = [];
  const rejected = [];
  const reject = (candidate, error, observedMissing = false) => {
    if (!observedMissing && !definitiveDiscoveryRejection(error)) inspectionComplete = false;
    rejected.push({ path: candidate.executable, source: candidate.source, error: codexExecutableRejectionMessage(error) });
  };
  for (const candidate of discovered) {
    if (selectedPath !== null) {
      let matchesSelected = false;
      try {
        const canonicalPath = await realpathImpl(candidate.executable);
        matchesSelected = canonicalPath.toLowerCase() === selectedPath.toLowerCase();
        if (!matchesSelected) continue;
        const canonicalRoot = await realpathImpl(candidate.installRoot);
        if (!pathInsideOrSame(canonicalPath, canonicalRoot)) {
          throw new Error("Codex executable escapes its official install root");
        }
      } catch (error) {
        if (matchesSelected || path.resolve(candidate.executable).toLowerCase() === path.resolve(selectedPath).toLowerCase()) {
          reject(candidate, error, installPathMissing(error));
        }
        continue;
      }
    }
    try {
      candidates.push(await inspectCandidate(candidate, { ...options, realpathImpl }));
    } catch (error) {
      reject(candidate, error);
    }
    if (selectedPath !== null) break;
  }
  candidates.sort((left, right) => {
    const versionOrder = compareCodexVersions(right.version, left.version);
    return versionOrder || left.path.localeCompare(right.path, "en", { sensitivity: "base" });
  });
  return { candidates, rejected, inspectionComplete };
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

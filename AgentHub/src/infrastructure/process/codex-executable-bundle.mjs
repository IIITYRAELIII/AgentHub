import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { acquireCodexExecutableCustody, validBundleMemberName } from "./codex-executable-custody.mjs";

export const CODEX_REQUIRED_HELPER_MISSING = "required-helper-missing";
const signatureStatuses = "Valid|UnknownError|NotSigned|HashMismatch|NotTrusted|NotSupportedFileFormat|Incompatible|unknown";
const memberPattern = "[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*";
const versionPattern = "[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?";
const signatureMessage = new RegExp(
  `^Codex bundle member signature is not trusted \\(member=(?:${memberPattern}|<unavailable>), status=(?:${signatureStatuses}), reason=(?:signature-invalid|publisher-not-openai), version=(?:${versionPattern}|unknown)\\)$`, "u",
);

// Existing state and installer receipts can still carry helper signature diagnostics.
export function isCodexBundleSignatureRejectionMessage(message) {
  return typeof message === "string" && message.length <= 380 && signatureMessage.test(message);
}

export function codexBundleDigest(files, codeModeHost) {
  return createHash("sha256").update(JSON.stringify({ files, codeModeHost })).digest("hex").toUpperCase();
}

export function validCodexBundle(bundle) {
  return bundle?.schemaVersion === 1 && typeof bundle.root === "string" && path.isAbsolute(bundle.root)
    && typeof bundle.installRoot === "string" && path.isAbsolute(bundle.installRoot)
    && typeof bundle.codeModeHost === "boolean" && Array.isArray(bundle.files) && bundle.files.length > 0
    && bundle.files.every(file => validBundleMemberName(file?.name) && /^[A-F0-9]{64}$/u.test(file?.sha256 ?? "")
      && (file.publisher === undefined || typeof file.publisher === "string"))
    && new Set(bundle.files.map(file => file.name.toLowerCase())).size === bundle.files.length
    && bundle.digest === codexBundleDigest(bundle.files, bundle.codeModeHost);
}

function sameBundleFiles(left, right) {
  return left.length === right.length && left.every((file, index) =>
    file.name === right[index].name && file.sha256 === right[index].sha256);
}

export function sameCodexBundleIdentity(left, right) {
  if (!left || !right) return !left && !right;
  // Verify the old serialized digest before ignoring its publisher metadata.
  return validCodexBundle(left) && validCodexBundle(right)
    && left.codeModeHost === right.codeModeHost && sameBundleFiles(left.files, right.files);
}

export async function inspectCodexExecutableBundle(candidate, {
  hashFile, readFeatures, executableArgs = [], expectedBundle,
  installRoot = path.dirname(path.dirname(candidate.path)),
  beforeFeatures = async () => {},
  acquireInspectionCustody = acquireCodexExecutableCustody,
} = {}) {
  const root = path.dirname(candidate.path), files = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), info = await lstat(file);
      if (info.isSymbolicLink()) throw new Error("Codex bundle contains a reparse member");
      if (info.isDirectory()) { await walk(file); continue; }
      if (!info.isFile() || await realpath(file) !== file) throw new Error("Codex bundle member canonical path changed");
      const name = path.relative(root, file).split(path.sep).join("/");
      const sha256 = await hashFile(file);
      if (file === candidate.path && sha256 !== candidate.sha256) throw new Error("Codex executable changed during bundle verification");
      files.push({ name, sha256, ...(file === candidate.path && candidate.publisher ? { publisher: candidate.publisher } : {}) });
    }
  };
  await walk(root);
  files.sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (expectedBundle && (!validCodexBundle(expectedBundle) || !sameBundleFiles(files, expectedBundle.files))) {
    throw Object.assign(new Error("Recorded Codex bundle identity changed"), { code: "CODEX_BUNDLE_UNAVAILABLE" });
  }
  // Probe the executable only while the complete verified bundle is held.
  const custody = await acquireInspectionCustody({ installRoot, root, files });
  let features;
  try {
    custody.assertAlive();
    await beforeFeatures();
    custody.assertAlive();
    features = await readFeatures(candidate.path, { executableArgs });
    custody.assertAlive();
  } finally {
    await custody.release();
  }
  const codeModeHost = features.codeModeHost === true;
  if (codeModeHost && !files.some(file => file.name.toLowerCase() === "codex-code-mode-host.exe")) {
    throw Object.assign(new Error("Required Codex code-mode host is missing from the selected bundle"), {
      code: "CODEX_BUNDLE_UNAVAILABLE", reason: CODEX_REQUIRED_HELPER_MISSING,
    });
  }
  return { schemaVersion: 1, installRoot, root, files, codeModeHost, digest: codexBundleDigest(files, codeModeHost) };
}

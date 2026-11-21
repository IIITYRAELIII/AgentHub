import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { acquireCodexExecutableCustody, validBundleMemberName } from "./codex-executable-custody.mjs";

export const CODEX_BUNDLE_SIGNATURE_REJECTED = "CODEX_BUNDLE_SIGNATURE_REJECTED";
const signatureStatuses = "Valid|UnknownError|NotSigned|HashMismatch|NotTrusted|NotSupportedFileFormat|Incompatible|unknown";
const memberPattern = "[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*";
const versionPattern = "[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.+-]+)?";
const signatureMessage = new RegExp(
  `^Codex bundle member signature is not trusted \\(member=(?:${memberPattern}|<unavailable>), status=(?:${signatureStatuses}), reason=(?:signature-invalid|publisher-not-openai), version=(?:${versionPattern}|unknown)\\)$`, "u",
);

export function isCodexBundleSignatureRejectionMessage(message) {
  return typeof message === "string" && message.length <= 380 && signatureMessage.test(message);
}

function bundleSignatureRejection(name, signature, version) {
  const member = name.length <= 180 && new RegExp(`^${memberPattern}$`, "u").test(name) ? name : "<unavailable>";
  const status = signatureStatuses.split("|").includes(signature?.status) ? signature.status : "unknown";
  const reason = status === "Valid" ? "publisher-not-openai" : "signature-invalid";
  const checkedVersion = typeof version === "string" && version.length <= 64
    && new RegExp(`^${versionPattern}$`, "u").test(version) ? version : "unknown";
  return Object.assign(new Error(
    `Codex bundle member signature is not trusted (member=${member}, status=${status}, reason=${reason}, version=${checkedVersion})`,
  ), { code: CODEX_BUNDLE_SIGNATURE_REJECTED });
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

export async function inspectCodexExecutableBundle(candidate, {
  hashFile, verifySignature, readFeatures, executableArgs = [], trustedBundle = candidate.bundle,
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
      let publisher;
      if (/\.(?:exe|dll)$/iu.test(name)) {
        const trusted = validCodexBundle(trustedBundle) && trustedBundle.files.find(prior =>
          prior.name === name && prior.sha256 === sha256 && prior.publisher === candidate.publisher);
        if (file === candidate.path) publisher = candidate.publisher;
        else if (trusted) publisher = trusted.publisher;
        else {
          const signature = await verifySignature(file);
          if (!signature?.valid) throw bundleSignatureRejection(name, signature, candidate.version);
          if (sha256 !== await hashFile(file)) throw new Error("Codex bundle member changed during signature verification");
          publisher = signature.publisher;
        }
      }
      files.push({ name, sha256, ...(publisher ? { publisher } : {}) });
    }
  };
  await walk(root);
  files.sort((left, right) => left.name.localeCompare(right.name, "en"));
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
    throw Object.assign(new Error("Required Codex code-mode host is missing from the selected bundle"), { code: "CODEX_BUNDLE_UNAVAILABLE" });
  }
  return { schemaVersion: 1, installRoot, root, files, codeModeHost, digest: codexBundleDigest(files, codeModeHost) };
}

import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { validBundleMemberName } from "./codex-executable-custody.mjs";

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
          if (!signature?.valid) throw new Error("Codex bundle member signature is not trusted");
          if (sha256 !== await hashFile(file)) throw new Error("Codex bundle member changed during signature verification");
          publisher = signature.publisher;
        }
      }
      files.push({ name, sha256, ...(publisher ? { publisher } : {}) });
    }
  };
  await walk(root);
  files.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const features = await readFeatures(candidate.path, { executableArgs });
  const codeModeHost = features.codeModeHost === true;
  if (codeModeHost && !files.some(file => file.name.toLowerCase() === "codex-code-mode-host.exe")) {
    throw Object.assign(new Error("Required Codex code-mode host is missing from the selected bundle"), { code: "CODEX_BUNDLE_UNAVAILABLE" });
  }
  return { schemaVersion: 1, installRoot, root, files, codeModeHost, digest: codexBundleDigest(files, codeModeHost) };
}

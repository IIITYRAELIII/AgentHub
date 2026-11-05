import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

// The public packager already binds the complete raw prepared manifest. This
// relation recognizes only that exact parent, without rewriting either body or
// treating arbitrary equal file lists/version labels as the same artifact.
export function preparedRuntimeVariantMatchesPublic(preparedRaw, publicRaw) {
  try {
    const prepared = JSON.parse(preparedRaw), published = JSON.parse(publicRaw);
    const origin = published.distributionSource;
    if (!origin || Object.keys(origin).sort().join(",") !== "commit,preparedManifestSha256,repository"
      || origin.repository !== "IIITYRAELIII/AgentHub"
      || !/^[a-f0-9]{40}$/u.test(origin.commit ?? "")
      || origin.commit !== prepared.publicationRevision || origin.commit !== published.publicationRevision
      || origin.preparedManifestSha256 !== createHash("sha256").update(preparedRaw).digest("hex")
      || Object.hasOwn(prepared, "distributionSource") || Object.hasOwn(published, "sourceRoot")
      || typeof prepared.sourceRoot !== "string"
      || !(path.win32.isAbsolute(prepared.sourceRoot) || path.posix.isAbsolute(prepared.sourceRoot))) return false;
    const { sourceRoot: _sourceRoot, ...privateIdentity } = prepared;
    const { distributionSource: _origin, ...publicIdentity } = published;
    return isDeepStrictEqual(privateIdentity, publicIdentity);
  } catch { return false; }
}

export function runtimeManifestMatchesPackage(existingRaw, publicRaw) {
  return Buffer.from(existingRaw).equals(Buffer.from(publicRaw))
    || preparedRuntimeVariantMatchesPublic(existingRaw, publicRaw);
}

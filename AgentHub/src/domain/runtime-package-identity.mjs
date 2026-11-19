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

export const packageDigest = (value) => createHash("sha256").update(value).digest("hex");
export const packageBindingDigest = (value) => packageDigest(JSON.stringify(value));

export function packageHandoffBinding(operation) {
  const envelope = operation?.metadata?.packageHandoff;
  if (!envelope || envelope.schema !== 1 || !envelope.binding
    || packageBindingDigest(envelope.binding) !== envelope.sha256
    || envelope.binding.operationId !== operation.operationId || operation.kind !== "restart") {
    throw new Error("Restart has no exact admitted package binding");
  }
  return envelope.binding;
}


export function packageRestartInput(input) {
  const keys = ["operationId", "tag", "archive", "descriptor", "installer"];
  if (!input || Object.keys(input).some((key) => !keys.includes(key))
    || keys.some((key) => typeof input[key] !== "string" || !input[key])) {
    throw new Error("Package restart requires only its exact original and public asset paths");
  }
  return { operationId: input.operationId, tag: input.tag,
    archive: path.resolve(input.archive), descriptor: path.resolve(input.descriptor), installer: path.resolve(input.installer) };
}

export function packageResumeInput(value) {
  if (!value || Object.keys(value).sort().join(",") !== "expectedBindingSha256,expectedCurrent,expectedRevision,input"
    || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1
    || !/^[a-f0-9]{64}$/u.test(value.expectedBindingSha256 ?? "")) throw new Error("Package continuation requires its exact failed revision and binding");
  const old = value.expectedCurrent;
  if (!old || Object.keys(old).sort().join(",") !== "currentSha256,instanceSha256,manifestSha256,pid,releaseId"
    || !Number.isSafeInteger(old.pid) || old.pid < 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(old.releaseId ?? "")
    || ["currentSha256", "instanceSha256", "manifestSha256"].some(key => !/^[a-f0-9]{64}$/u.test(old[key] ?? ""))) {
    throw new Error("Package continuation requires exact fresh current identity");
  }
  return { input: packageRestartInput(value.input), expectedRevision: value.expectedRevision,
    expectedBindingSha256: value.expectedBindingSha256,
    expectedCurrent: { releaseId: old.releaseId, pid: old.pid, currentSha256: old.currentSha256,
      instanceSha256: old.instanceSha256, manifestSha256: old.manifestSha256 } };
}

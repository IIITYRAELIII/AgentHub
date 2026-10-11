import path from "node:path";

const SHA = /^[0-9a-f]{40}$/u;
const MAX_CONFLICTS = 16;
export const PUBLISHED_BINDINGS = Object.freeze(["taskId", "repositoryKey", "taskBaseCommit", "acceptedLocalMainCommit",
  "taskCommit", "devCommit", "proofCommit", "publishedCommit", "publicationGeneration", "remoteCommit", "bundleSha256"]);

export function normalizePublishedResolution(value) {
  if (value == null) return null;
  const keys = ["version", "kind", ...PUBLISHED_BINDINGS, "resolutionCommit",
    "resolutionBundlePath", "resolutionBundleSha256", "resolutions"];
  if (typeof value !== "object" || Array.isArray(value) || value.version !== 1
      || value.kind !== "ordinary-published-resolution-v1"
      || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error("Selected published resolution has an unsupported identity");
  }
  const input = { version: 1, kind: value.kind };
  for (const key of PUBLISHED_BINDINGS) {
    input[key] = String(value[key] ?? "").trim();
    if (!input[key]) throw new Error(`Selected published resolution is missing ${key}`);
  }
  input.resolutionCommit = exact(value.resolutionCommit, "published resolution commit");
  const bundle = String(value.resolutionBundlePath ?? "").trim();
  input.resolutionBundlePath = bundle ? path.resolve(bundle) : "";
  input.resolutionBundleSha256 = String(value.resolutionBundleSha256 ?? "").trim().toLowerCase();
  if (!bundle || !/^[0-9a-f]{64}$/u.test(input.resolutionBundleSha256)
      || !Array.isArray(value.resolutions) || !value.resolutions.length
      || value.resolutions.length > MAX_CONFLICTS) {
    throw new Error("Selected published resolution bundle or conflict identity is incomplete");
  }
  input.resolutions = value.resolutions.map((entry) => {
    if (!entry || Object.keys(entry).some((key) => !["path", "mode", "blob"].includes(key))
        || typeof entry.path !== "string" || !entry.path || entry.path.includes("\0")
        || entry.mode !== "100644") {
      throw new Error("Selected published resolution conflict entry is unsupported");
    }
    return { path: entry.path, mode: entry.mode, blob: exact(entry.blob, "published resolution blob") };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(input.resolutions.map((entry) => entry.path)).size !== input.resolutions.length) {
    throw new Error("Selected published resolution has duplicate conflicts");
  }
  return input;
}

function exact(value, label) {
  const result = String(value ?? "").trim().toLowerCase();
  if (!SHA.test(result)) throw new Error(`Selected composition ${label} is not an exact Git identity`);
  return result;
}


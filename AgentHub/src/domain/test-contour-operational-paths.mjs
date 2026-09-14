import { createHash } from "node:crypto";
import path from "node:path";

function sourcePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("An explicit absolute source path is required");
  const windows = /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\");
  const api = windows ? path.win32 : path.posix;
  if (!api.isAbsolute(value) || /^[\\/]{2}[?.][\\/]/.test(value)) throw new Error("Unsupported source path");
  const normalized = api.normalize(value);
  const key = windows ? normalized.toLowerCase() : normalized;
  return { api, normalized, key: key.replace(/[\\/]$/, ""), windows };
}

export function createContourOperationalPaths({ root, sources }) {
  if (!root || !path.isAbsolute(root) || !Array.isArray(sources) || !sources.length) throw new Error("Explicit contour root and typed source roots are required");
  const resolvedRoot = path.resolve(root);
  const mappings = sources.map(({ source, kind }) => {
    if (!["project", "attachment"].includes(kind)) throw new Error("Unknown operational path kind");
    const parsed = sourcePath(source);
    const id = createHash("sha256").update(`${kind}\0${parsed.key}`).digest("hex");
    return { ...parsed, kind, source, target: path.join(resolvedRoot, "execution", kind, id) };
  });
  if (new Set(mappings.map((m) => `${m.kind}\0${m.key}`)).size !== mappings.length) throw new Error("Duplicate operational source root");
  mappings.sort((a, b) => b.key.length - a.key.length);
  function map(value, kind) {
    const parsed = sourcePath(value);
    const selected = mappings.find((candidate) => {
      if (candidate.kind !== kind || candidate.windows !== parsed.windows) return false;
      const relative = candidate.api.relative(candidate.normalized, parsed.normalized);
      return !relative || (!candidate.api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${candidate.api.sep}`));
    });
    if (!selected) throw new Error(`Unmapped ${kind} path`);
    const relative = selected.api.relative(selected.normalized, parsed.normalized);
    const segments = relative ? relative.split(/[\\/]/) : [];
    if (segments.some((part) => !part || part === ".." || /[:\0]/.test(part))) throw new Error("Unsupported operational path component");
    return path.join(selected.target, ...segments);
  }
  function input(value) {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) throw new Error("Unsupported provider input");
    return value.map((item) => {
      if (item?.type === "text" && typeof item.text === "string") return structuredClone(item);
      if (["localImage", "localFile"].includes(item?.type)) return { ...structuredClone(item), path: map(item.path, "attachment") };
      throw new Error(`Unsupported provider input type: ${item?.type}`);
    });
  }
  return Object.freeze({ root: resolvedRoot, map, input,
    manifest: () => mappings.map(({ source, kind, target }) => ({ source, kind, target })),
    // Canonical object, command fingerprints, occupancy and annotations are not rewritten.
    executionView: (command) => ({ ...structuredClone(command),
      projectRoot: map(command.projectRoot, "project"),
      input: input(command.input),
      ...(command.temporaryFiles ? { temporaryFiles: command.temporaryFiles.map((file) => map(file, "attachment")) } : {}),
    }),
  });
}

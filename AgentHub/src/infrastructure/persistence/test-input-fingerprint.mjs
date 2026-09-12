import { createHash } from "node:crypto";
import { readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";

const SAFE_BUILTINS = new Set([
  "assert", "assert/strict", "test", "path", "path/posix", "path/win32", "url",
  "crypto", "buffer", "util", "events", "string_decoder", "timers", "timers/promises",
]);
const INPUT_LIMIT = 128 * 1024 * 1024;
const FILE_LIMIT = 10_000;

// This is a cache eligibility check, not a JavaScript dependency analyser.
// Computed imports, external IO and undeclared fixtures cannot establish reuse.
export async function fingerprintTestInputs(file, {
  cwd,
  root = cwd,
  runnerFile,
  declaration = null,
  environment = process.env,
  toolchain = { node: process.version, platform: process.platform, arch: process.arch, versions: process.versions, execArgv: process.execArgv },
  browserFile = "",
} = {}) {
  const hash = createHash("sha256").update("test-inputs-v4\0");
  hash.update(JSON.stringify(toolchain)).update("\0");
  // Values (including secrets) never leave this digest or appear in a checkpoint.
  const stableEnvironment = Object.entries(environment)
    .filter(([name]) => ![
      "AGENT_HUB_FULL_TEST_CHECKPOINT_ID",
      "AGENT_HUB_TEST_RUN_ID",
      "AGENT_HUB_PUBLICATION_SESSION",
      "AGENT_HUB_PUBLICATION_STAGE_DELEGATION",
    ].includes(name))
    .sort(([a], [b]) => a.localeCompare(b));
  hash.update(JSON.stringify(stableEnvironment)).update("\0");
  hash.update(JSON.stringify(declaration)).update("\0");
  const seen = new Set();
  let bytes = 0;
  let cacheable = true;
  const within = (absolute) => {
    const relative = path.relative(root, absolute);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  async function source(absolute, label = path.relative(root, absolute)) {
    const info = await lstat(absolute).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) { hash.update(`${label}\0<missing>\0`); return null; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > INPUT_LIMIT - bytes) {
      cacheable = false;
      return null;
    }
    bytes += info.size;
    const content = await readFile(absolute);
    hash.update(label).update("\0").update(content).update("\0");
    return content;
  }
  async function visit(absolute) {
    absolute = path.resolve(absolute);
    if (!within(absolute)) { cacheable = false; return; }
    if (seen.has(absolute)) return;
    if (seen.size >= FILE_LIMIT) { cacheable = false; return; }
    seen.add(absolute);
    const content = await source(absolute);
    if (!content) { cacheable = false; return; }
    if (!/\.[cm]?js$/u.test(absolute)) return;
    const text = content.toString("utf8");
    if (/\b(?:eval|Function)\s*\(|\bimport\s*\(\s*(?!["'])|\brequire\s*\(\s*(?!["'])|\b(?:require|import)\s*\/\*/u.test(text)) cacheable = false;
    if (!declaration && /\b(?:process|globalThis|global|fetch)\b/u.test(text)) cacheable = false;
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)["']([^"']+)["']/gu)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        const base = path.resolve(path.dirname(absolute), specifier);
        const candidates = path.extname(base) ? [base] : [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, "index.js")];
        let resolved = false;
        for (const candidate of candidates) {
          const info = await lstat(candidate).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
          if (info?.isFile()) { await visit(candidate); resolved = true; break; }
        }
        if (!resolved) cacheable = false;
      } else {
        const builtin = specifier.replace(/^node:/u, "");
        if (SAFE_BUILTINS.has(builtin)) continue;
        if (declaration && ["fs", "fs/promises", "vm"].includes(builtin)) continue;
        if (declaration?.packages?.includes(specifier)) continue;
        cacheable = false;
      }
    }
  }
  async function inputTree(absolute, depth = 0) {
    if (depth > 32 || seen.size >= FILE_LIMIT) { cacheable = false; return; }
    if (!within(absolute)) { cacheable = false; return; }
    const info = await lstat(absolute).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isDirectory() && !info.isSymbolicLink()) {
      seen.add(absolute);
      const names = await readdir(absolute);
      if (names.length > FILE_LIMIT - seen.size) { cacheable = false; return; }
      for (const name of names.sort()) await inputTree(path.join(absolute, name), depth + 1);
    } else {
      if (seen.size >= FILE_LIMIT) { cacheable = false; return; }
      seen.add(absolute);
      await source(absolute);
    }
  }
  if (runnerFile) await source(runnerFile, "<test-runner>");
  await source(import.meta.filename, "<fingerprint-policy>");
  for (const location of new Set([root, cwd])) {
    for (const name of ["package.json", "package-lock.json", "node_modules/.package-lock.json"]) await source(path.join(location, name));
  }
  if (declaration?.packages?.length) {
    for (const name of ["package-lock.json", "node_modules/.package-lock.json"]) {
      if (!await source(path.join(root, name))) cacheable = false;
    }
  }
  await visit(path.resolve(cwd, file));
  for (const input of declaration?.inputs ?? []) await inputTree(path.resolve(root, input));
  if (declaration?.browser) {
    if (!browserFile || !await source(browserFile, "<browser-binary>")) cacheable = false;
  }
  return cacheable ? hash.digest("hex") : null;
}

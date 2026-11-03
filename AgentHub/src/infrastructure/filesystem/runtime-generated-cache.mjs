import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { readRuntimeManifest } from "./runtime-installation-custody.mjs";

const proofs = new WeakMap(), hash = bytes => createHash("sha256").update(bytes).digest("hex");
const identity = s => [s.dev, s.ino, s.birthtimeNs, s.mtimeNs, s.ctimeNs, s.size, s.nlink].map(String).join(":");
const bindingKey = (root, binding) => JSON.stringify([path.resolve(root).toLowerCase(), binding.releaseId,
  binding.manifestSha256, binding.root]);
async function plain(file) {
  const named = await lstat(file, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size > 1024n * 1024n) {
    throw Error("runtime-generated-cache-file-refused");
  }
  const handle = await open(file, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (identity(named) !== identity(before)) throw Error("runtime-generated-cache-file-changed");
    const bytes = Buffer.alloc(Number(before.size) + 1);
    const used = await handle.read(bytes, 0, bytes.length, 0);
    if (used.bytesRead !== Number(before.size) || identity(before) !== identity(await handle.stat({ bigint: true }))) {
      throw Error("runtime-generated-cache-file-changed");
    }
    return { bytes: bytes.subarray(0, used.bytesRead), info: before, identity: identity(before) };
  } finally { await handle.close(); }
}

// Compile only: never import or execute a retained runtime module. Recreate
// the whole PYC including its original filename and timestamp/hash header.
const compile = String.raw`
import sys, pathlib, tempfile, py_compile, importlib.util, struct, json, base64, os
try:
    payload = json.loads(sys.stdin.buffer.read(3 * 1024 * 1024))
    original = base64.b64decode(payload['source'], validate=True)
    raw = base64.b64decode(payload['cache'], validate=True)
    assert len(original) <= 1024 * 1024 and len(raw) <= 1024 * 1024
    assert payload['cacheName'] == "whisper_runtime." + sys.implementation.cache_tag + ".pyc"
    assert raw[:4] == importlib.util.MAGIC_NUMBER and len(raw) >= 16
    flags = struct.unpack("<I", raw[4:8])[0]
    assert flags in (0, 1, 3)
    modes = {0: py_compile.PycInvalidationMode.TIMESTAMP, 1: py_compile.PycInvalidationMode.UNCHECKED_HASH, 3: py_compile.PycInvalidationMode.CHECKED_HASH}
    with tempfile.TemporaryDirectory(prefix="hub-cache-proof-") as temporary:
        source = pathlib.Path(temporary) / "source.py"
        source.write_bytes(original)
        stamp = int(payload['mtimeNs'])
        os.utime(source, ns=(stamp, stamp))
        output = pathlib.Path(temporary) / "compiled.pyc"
        py_compile.compile(str(source), cfile=str(output), dfile=payload['sourceName'], doraise=True, optimize=0, invalidation_mode=modes[flags])
        assert output.read_bytes() == raw
    print("verified")
except BaseException:
    sys.exit(1)
`;
async function compileMatches(pythonExe, source, cache, sourceName, cacheName) {
  if (!path.isAbsolute(pythonExe)) throw Error("runtime-generated-cache-python-required");
  await new Promise((resolve, reject) => {
    const child = spawn(pythonExe, ["-I", "-S", "-B", "-c", compile], {
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: Object.fromEntries(Object.entries({ SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP })
        .filter(([, value]) => value !== undefined)),
    });
    let output = "", refused = false;
    child.stdout.on("data", bytes => { if (output.length + bytes.length > 64) refused = true; else output += bytes; });
    child.stderr.on("data", () => { refused = true; });
    child.stdin.on("error", () => { refused = true; });
    child.once("error", () => { refused = true; });
    child.once("close", code => code === 0 && !refused && output.trim() === "verified"
      ? resolve() : reject(Error("runtime-generated-cache-not-derived")));
    child.stdin.end(JSON.stringify({ source: source.bytes.toString("base64"), cache: cache.bytes.toString("base64"),
      mtimeNs: String(source.info.mtimeNs), sourceName, cacheName }));
  });
}

/** Exact historical Whisper cache only; unknown data remains a native refusal. */
export async function verifyRuntimeGeneratedCache(root, binding, pythonExe = "") {
  const directory = path.join(root, "__pycache__");
  const dir = await lstat(directory).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!dir) return null;
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw Error("runtime-generated-cache-directory-refused");
  const { manifest, sha256 } = await readRuntimeManifest(root);
  if (sha256 !== binding.manifestSha256) throw Error("runtime-generated-cache-manifest-changed");
  const entries = await readdir(directory);
  if (entries.length !== 1 || !/^whisper_runtime\.cpython-\d+\.pyc$/u.test(entries[0])) {
    throw Error("runtime-generated-cache-directory-refused");
  }
  const relative = "__pycache__/" + entries[0];
  if (manifest.files.some(entry => entry.path.toLowerCase() === relative.toLowerCase())) return null;
  const sourceEntry = manifest.files.filter(entry => entry.path === "whisper_runtime.py");
  if (sourceEntry.length !== 1) throw Error("runtime-generated-cache-source-unproven");
  const source = path.join(root, "whisper_runtime.py"), cache = path.join(directory, entries[0]);
  const beforeSource = await plain(source), beforeCache = await plain(cache);
  if (hash(beforeSource.bytes) !== sourceEntry[0].sha256 || beforeSource.bytes.length !== sourceEntry[0].bytes) {
    throw Error("runtime-generated-cache-source-changed");
  }
  await compileMatches(pythonExe, beforeSource, beforeCache, source, entries[0]);
  const afterSource = await plain(source), afterCache = await plain(cache);
  if (beforeSource.identity !== afterSource.identity || beforeCache.identity !== afterCache.identity
      || !beforeSource.bytes.equals(afterSource.bytes) || !beforeCache.bytes.equals(afterCache.bytes)) {
    throw Error("runtime-generated-cache-proof-changed");
  }
  const info = beforeCache.info;
  const proof = Object.freeze({ path: relative, source: "whisper_runtime.py", sha256: hash(beforeCache.bytes), bytes: beforeCache.bytes.length,
    dev: String(info.dev), ino: String(info.ino), birthFileTime: String(info.birthtimeNs / 100n + 116444736000000000n) });
  proofs.set(proof, bindingKey(root, binding));
  return proof;
}

export function runtimeGeneratedCacheProof(root, binding, proof) {
  if (proof === null) return null;
  if (proofs.get(proof) !== bindingKey(root, binding)) throw Error("runtime-generated-cache-proof-required");
  return proof;
}

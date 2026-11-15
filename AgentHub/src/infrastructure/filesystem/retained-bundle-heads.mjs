import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

const BUDGET = 32 * 1024;
const RAW_BUDGET = 4 * 1024 * 1024;
const sha = value => createHash("sha256").update(value).digest("hex");
const valid = heads => Array.isArray(heads) && heads.length > 0 && heads.length <= 4096
  && heads.every(item => typeof item === "string" && /^[a-f0-9]{40,64} \S+$/u.test(item));

// Keep legacy bindings byte-shaped exactly as before. Larger complete lists
// use the SAME maintenance child, not another inventory or keeper-ref ledger.
export function bindBundleHeads(heads) {
  if (!valid(heads)) return null;
  const bytes = Buffer.from(JSON.stringify(heads));
  if (bytes.length <= BUDGET) return { heads };
  if (bytes.length > RAW_BUDGET) return null;
  const headsProof = { encoding: "gzip-json-v1", count: heads.length, sha256: sha(bytes),
    data: gzipSync(bytes).toString("base64") };
  return Buffer.byteLength(JSON.stringify({ headsProof })) <= BUDGET ? { headsProof } : null;
}

export function readBundleHeads(binding) {
  if (Object.hasOwn(binding ?? {}, "heads")) {
    if (Object.hasOwn(binding, "headsProof") || !valid(binding.heads)
        || Buffer.byteLength(JSON.stringify(binding.heads)) > BUDGET) throw new Error("bundle-head-proof-invalid");
    return binding.heads;
  }
  const proof = binding?.headsProof;
  if (!proof || proof.encoding !== "gzip-json-v1" || !Number.isInteger(proof.count)
      || proof.count < 1 || proof.count > 4096 || !/^[a-f0-9]{64}$/u.test(proof.sha256 ?? "")
      || typeof proof.data !== "string" || Buffer.byteLength(JSON.stringify({ headsProof: proof })) > BUDGET
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(proof.data)) {
    throw new Error("bundle-head-proof-invalid");
  }
  const packed = Buffer.from(proof.data, "base64");
  const bytes = gunzipSync(packed, { maxOutputLength: RAW_BUDGET });
  if (packed.toString("base64") !== proof.data || sha(bytes) !== proof.sha256) throw new Error("bundle-head-proof-invalid");
  const heads = JSON.parse(bytes);
  if (!valid(heads) || heads.length !== proof.count || JSON.stringify(heads) !== bytes.toString("utf8")) {
    throw new Error("bundle-head-proof-invalid");
  }
  return heads;
}

export async function bundleHeadsAnchored(git, heads) {
  // Object presence alone is not retention across ordinary future Git GC.
  // Preserve original annotated tag objects, not only their peeled commits.
  const objects = String(await git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
    input: heads.map(item => item.split(" ")[0]).join("\n") + "\n",
  })).split(/\r?\n/u);
  if (objects.length !== heads.length || objects.some((item, i) => !new RegExp(`^${heads[i].split(" ")[0]} (commit|tag)$`, "u").test(item))) return false;
  const commits = objects.filter(item => item.endsWith(" commit")).map(item => item.split(" ")[0]);
  if (commits.length && await git(["rev-list", "--max-count=1", "--stdin", "--not", "--all"], {
    input: commits.join("\n") + "\n",
  })) return false;
  const tags = heads.filter((item, i) => objects[i].endsWith(" tag"));
  if (tags.length) {
    if (tags.some(item => !item.split(" ")[1].startsWith("refs/"))) return false;
    let refs;
    try { refs = String(await git(["show-ref", "--verify", "--", ...tags.map(item => item.split(" ")[1])])).split(/\r?\n/u); }
    catch { return false; }
    if (refs.length !== tags.length || refs.some((item, i) => item !== tags[i])) return false;
  }
  return true;
}

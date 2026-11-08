import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { nativePhysicalIdentity } from "./native-capture-inventory.mjs";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const crlf = Buffer.from([13, 10]), cr = Buffer.from([13]);

// Exact CRLF-to-LF is the only supported checkout-byte difference. Do not run
// arbitrary clean/smudge filters or hydrate a large file into RAM for cleanup.
async function normalizedOid(file, identity, expectedSize) {
  const h = await open(file, "r"), hash = createHash("sha1").update("blob " + expectedSize + "\0"), raw = createHash("sha256");
  let pendingCR = false, bytes = 0;
  const add = part => { hash.update(part); bytes += part.length; };
  try {
    if (!same(nativePhysicalIdentity(await h.stat({ bigint: true })), nativePhysicalIdentity(identity))) throw new Error("Native tracked identity changed");
    for await (const chunk of h.createReadStream({ autoClose: false })) {
      raw.update(chunk);
      let start = 0, end = chunk.length;
      if (pendingCR) {
        if (chunk[0] === 10) { add(chunk.subarray(0, 1)); start = 1; } else add(cr);
        pendingCR = false;
      }
      if (end > start && chunk[end - 1] === 13) { pendingCR = true; end--; }
      for (;;) {
        const found = chunk.indexOf(crlf, start);
        if (found < 0 || found + 1 >= end) break;
        add(chunk.subarray(start, found)); start = found + 1;
      }
      add(chunk.subarray(start, end));
    }
    if (pendingCR) add(cr);
    const after = await lstat(file, { bigint: true });
    if (!same(nativePhysicalIdentity(after), nativePhysicalIdentity(identity)) || String(after.size) !== identity.bytes
        || raw.digest("hex") !== identity.sha256 || bytes !== expectedSize) throw new Error("Native tracked bytes changed");
    return hash.digest("hex");
  } finally { await h.close(); }
}

export async function assertNativeTrackedCapture({ repository, inventory, git, head }) {
  const flags = String(await git(["ls-files", "-v", "-z"], { rawOutput: true })).split("\0").filter(Boolean);
  if (flags.some(entry => !entry.startsWith("H "))) throw new Error("Native capture has concealed/sparse tracked state");
  const entries = String(await git(["ls-tree", "-r", "-z", head], { rawOutput: true })).split("\0").filter(Boolean).map(row => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(row);
    if (!match) throw new Error("Native capture contains unowned linked/submodule data");
    return { oid: match[2], path: match[3] };
  });
  const files = new Map(inventory.files.map(f => [f.path, f])), mismatches = [];
  for (const entry of entries) {
    const file = files.get(entry.path);
    if (!file) throw new Error("Native tracked file absent");
    if (file.rawBlobOid !== entry.oid) mismatches.push({ entry, file });
  }
  if (!mismatches.length) return;
  const sizes = String(await git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: mismatches.map(x => x.entry.oid).join("\n") + "\n" })).split(/\r?\n/u);
  if (sizes.length !== mismatches.length) throw new Error("Native tracked object sizes unavailable");
  for (const [i, { entry, file }] of mismatches.entries()) {
    const match = /^([a-f0-9]{40}) blob (\d+)$/u.exec(sizes[i]);
    if (!match || match[1] !== entry.oid || !Number.isSafeInteger(Number(match[2]))
        || await normalizedOid(path.join(repository, ...entry.path.split("/")), file.identity, Number(match[2])) !== entry.oid) {
      throw new Error("Native tracked file has unique unpublished bytes");
    }
  }
}

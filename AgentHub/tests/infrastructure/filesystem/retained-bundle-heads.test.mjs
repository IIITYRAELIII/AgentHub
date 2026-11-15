import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { bindBundleHeads, readBundleHeads } from "../../../src/infrastructure/filesystem/retained-bundle-heads.mjs";

const heads = Array.from({ length: 700 }, (_, i) => `${"a".repeat(40)} refs/agent-hub/retained/${String(i).padStart(5, "0")}/${"x".repeat(60)}`);

test("legacy arrays keep their identity shape; wide complete heads round-trip within existing metadata budget", () => {
  const legacy = [heads[0]];
  assert.equal(JSON.stringify(bindBundleHeads(legacy)), JSON.stringify({ heads: legacy }));
  assert.deepEqual(readBundleHeads({ heads: legacy }), legacy);
  assert.ok(Buffer.byteLength(JSON.stringify(heads)) > 32 * 1024);
  const binding = bindBundleHeads(heads);
  assert.equal(binding.heads, undefined);
  assert.equal(binding.headsProof.count, heads.length);
  assert.ok(Buffer.byteLength(JSON.stringify(binding)) <= 32 * 1024);
  assert.deepEqual(readBundleHeads(binding), heads);
});

test("malformed, changed, ambiguous and decompression-overbudget head proofs refuse", () => {
  const binding = bindBundleHeads(heads);
  for (const proof of [
    { ...binding, heads: [heads[0]] },
    { headsProof: { ...binding.headsProof, count: 1 } },
    { headsProof: { ...binding.headsProof, sha256: "0".repeat(64) } },
    { headsProof: { ...binding.headsProof, encoding: "other" } },
    { headsProof: { ...binding.headsProof, data: "invalid" } },
    { headsProof: { ...binding.headsProof, data: gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1)).toString("base64") } },
  ]) assert.throws(() => readBundleHeads(proof));
  assert.equal(bindBundleHeads([]), null);
  assert.equal(bindBundleHeads(Array(4097).fill(heads[0])), null);
  assert.equal(bindBundleHeads(["not a Git head"]), null);
});

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { normalizePublishedResolution, PUBLISHED_BINDINGS } from "../../src/domain/published-resolution.mjs";
import { normalizePublishedResolution as historical } from "../../src/infrastructure/filesystem/selected-composition-proof.mjs";

test("published resolution normalization retains strict historical identity across domain and recovery owners", () => {
  const input = { version: 1, kind: "ordinary-published-resolution-v1",
    ...Object.fromEntries(PUBLISHED_BINDINGS.map(key => [key, ` ${key} `])),
    resolutionCommit: "A".repeat(40), resolutionBundlePath: "fixture.bundle", resolutionBundleSha256: "B".repeat(64),
    resolutions: [{ path: "z.txt", mode: "100644", blob: "C".repeat(40) }, { path: "a.txt", mode: "100644", blob: "D".repeat(40) }] };
  const result = normalizePublishedResolution(input);
  assert.equal(historical, normalizePublishedResolution);
  assert.equal(result.resolutionBundlePath, path.resolve(input.resolutionBundlePath));
  assert.equal(result.resolutionCommit, "a".repeat(40));
  assert.deepEqual(result.resolutions.map(entry => entry.path), ["a.txt", "z.txt"]);
  assert.equal(normalizePublishedResolution(null), null);
  for (const changed of [ { ...input, kind: "foreign" }, { ...input, foreign: true }, { ...input, taskId: "" },
    { ...input, resolutionCommit: "bad" }, { ...input, resolutionBundleSha256: "bad" },
    { ...input, resolutions: [] }, { ...input, resolutions: [input.resolutions[0], input.resolutions[0]] },
    { ...input, resolutions: [{ ...input.resolutions[0], mode: "100755" }] } ]) {
    assert.throws(() => normalizePublishedResolution(changed));
  }
});

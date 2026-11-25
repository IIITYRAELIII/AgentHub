import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readReleaseToolPackage } from "../../../src/infrastructure/process/release-tool-package.mjs";

test("retained executor location binds plain physical directory and whole runtime bytes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "tool-location-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "immutable");
  const bodies = { "package.json": JSON.stringify({ name: "fixture-release-tool", version: "1.0.0" }),
    "entry.mjs": "export const verified = true;\n" };
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  const expectedSha256 = sha(JSON.stringify(Object.keys(bodies).sort().map(file => ({
    path: file, bytes: Buffer.byteLength(bodies[file]), sha256: sha(bodies[file]),
  }))));
  const materialize = async () => {
    await mkdir(source);
    for (const [file, body] of Object.entries(bodies)) await writeFile(path.join(source, file), body);
    await writeFile(path.join(source, "export-manifest.json"), JSON.stringify({ apiVersion: 1, files: Object.keys(bodies) }));
  };
  await materialize();
  const first = await readReleaseToolPackage({ root: source, expectedSha256 });
  const recorded = JSON.parse(JSON.stringify(first.location));
  assert.equal((await readReleaseToolPackage({ root: source, expectedSha256, expectedLocation: recorded })).sha256, expectedSha256);
  assert.equal((await first.module("entry.mjs")).verified, true);
  await writeFile(path.join(source, "entry.mjs"), "foreign\n");
  await assert.rejects(first.assertUnchanged(), /pinned version/u);
  await writeFile(path.join(source, "entry.mjs"), bodies["entry.mjs"]);
  await first.assertUnchanged();
  await rename(source, path.join(root, "retained-original"));
  await materialize();
  assert.equal(sha(await readFile(path.join(source, "entry.mjs"))), sha(bodies["entry.mjs"]));
  await assert.rejects(readReleaseToolPackage({ root: source, expectedSha256, expectedLocation: recorded }), /location changed/u);
  await assert.rejects(readReleaseToolPackage({ root: source, expectedSha256: null }), /requires.*pin/u);
});

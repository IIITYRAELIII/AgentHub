import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_HUB_VERSION,
  readAgentHubPackage,
  readAgentHubVersion,
} from "../../../src/infrastructure/filesystem/agent-hub-package.mjs";
import {
  agentHubCalendarVersion,
  prepareAgentHubReleaseVersion,
  prepareCommittedAgentHubReleaseVersion,
} from "../../../src/infrastructure/filesystem/release-version.mjs";

test("Agent Hub package metadata is the canonical product version", () => {
  assert.equal(readAgentHubVersion(), AGENT_HUB_VERSION);
  assert.equal(readAgentHubPackage().name, "agent-hub");
});

test("Agent Hub package metadata rejects missing and invalid versions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-package-"));
  const packageFile = path.join(root, "package.json");
  try {
    await writeFile(packageFile, JSON.stringify({ name: "agent-hub" }), "utf8");
    assert.throws(() => readAgentHubVersion({ packageFile }), /invalid version/u);
    await writeFile(packageFile, JSON.stringify({ name: "another-package", version: "1.2.3" }), "utf8");
    assert.throws(() => readAgentHubVersion({ packageFile }), /unexpected name/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release version preparation updates package metadata to the local calendar date", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-version-"));
  const packageFile = path.join(root, "package.json");
  const lockFile = path.join(root, "package-lock.json");
  try {
    await writeFile(packageFile, `${JSON.stringify({ name: "agent-hub", version: "2026.8.23" }, null, 2)}\n`, "utf8");
    await writeFile(lockFile, `${JSON.stringify({
      name: "agent-hub",
      version: "2026.8.23",
      lockfileVersion: 3,
      packages: { "": { name: "agent-hub", version: "2026.8.23" } },
    }, null, 2)}\n`, "utf8");

    const first = await prepareAgentHubReleaseVersion({ root, now: new Date(2026, 7, 24, 12) });
    assert.deepEqual(
      { changed: first.changed, previousVersion: first.previousVersion, version: first.version },
      { changed: true, previousVersion: "2026.8.23", version: "2026.8.24" },
    );
    assert.equal(JSON.parse(await readFile(packageFile, "utf8")).version, "2026.8.24");
    const lock = JSON.parse(await readFile(lockFile, "utf8"));
    assert.equal(lock.version, "2026.8.24");
    assert.equal(lock.packages[""].version, "2026.8.24");
    assert.equal((await prepareAgentHubReleaseVersion({ root, now: new Date(2026, 7, 24, 23) })).changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication preflight stops after preparing an uncommitted calendar version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-version-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "agent-hub",
      version: "2026.8.23",
    }), "utf8");
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      name: "agent-hub",
      version: "2026.8.23",
      packages: { "": { name: "agent-hub", version: "2026.8.23" } },
    }), "utf8");
    await assert.rejects(
      prepareCommittedAgentHubReleaseVersion({ root, now: new Date(2026, 7, 24, 12) }),
      /автоматически повышена до v2026\.8\.24/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("calendar version uses the machine-local release date", () => {
  assert.equal(agentHubCalendarVersion(new Date(2026, 7, 24, 0, 1)), "2026.8.24");
});

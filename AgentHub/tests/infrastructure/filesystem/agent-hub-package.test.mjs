import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_HUB_VERSION,
  readAgentHubPackage,
  readAgentHubReleaseVersion,
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

test("runtime manifest adds the visible same-day release sequence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-runtime-version-"));
  const packageFile = path.join(root, "package.json");
  const manifestFile = path.join(root, "runtime-manifest.json");
  try {
    await writeFile(packageFile, JSON.stringify({ name: "agent-hub", version: "2026.8.25" }), "utf8");
    assert.equal(readAgentHubReleaseVersion({ packageFile, manifestFile }), "2026.8.25");
    await writeFile(manifestFile, JSON.stringify({
      version: "2026.8.25",
      releaseVersion: "2026.8.25.2",
    }), "utf8");
    assert.equal(readAgentHubReleaseVersion({ packageFile, manifestFile }), "2026.8.25.2");
    await writeFile(manifestFile, JSON.stringify({
      version: "2026.8.25",
      releaseVersion: "2026.8.24.9",
    }), "utf8");
    assert.throws(
      () => readAgentHubReleaseVersion({ packageFile, manifestFile }),
      /invalid release version/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("release version preparation migrates calendar metadata to first installer 2.0.0", async () => {
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
      { changed: true, previousVersion: "2026.8.23", version: "2.0.0" },
    );
    assert.equal(JSON.parse(await readFile(packageFile, "utf8")).version, "2.0.0");
    const lock = JSON.parse(await readFile(lockFile, "utf8"));
    assert.equal(lock.version, "2.0.0");
    assert.equal(lock.packages[""].version, "2.0.0");
    assert.equal((await prepareAgentHubReleaseVersion({ root, expectedVersion: "2.0.0" })).changed, false);
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
      /автоматически повышена до v2\.0\.0/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("calendar version uses the machine-local release date", () => {
  assert.equal(agentHubCalendarVersion(new Date(2026, 7, 24, 0, 1)), "2026.8.24");
});

test("publication validation keeps the version frozen before midnight", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-frozen-version-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "agent-hub", version: "2026.8.24",
    }), "utf8");
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
      name: "agent-hub", version: "2026.8.24",
      packages: { "": { name: "agent-hub", version: "2026.8.24" } },
    }), "utf8");
    const result = await prepareCommittedAgentHubReleaseVersion({
      root,
      expectedVersion: "2026.8.24",
      now: new Date(2026, 7, 25, 0, 1),
    });
    assert.equal(result.changed, false);
    assert.equal(result.version, "2026.8.24");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

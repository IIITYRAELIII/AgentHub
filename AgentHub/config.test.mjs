import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalizeProjectRoots,
  findContainingProject,
  httpBaseUrl,
  pathInsideOrSame,
  repositoryWriteGuardEnabled,
  resolveConfigPath,
  samePath,
} from "./config.mjs";

test("concurrent repository write guard is opt-in", () => {
  assert.equal(repositoryWriteGuardEnabled(), false);
  assert.equal(repositoryWriteGuardEnabled({}), false);
  assert.equal(repositoryWriteGuardEnabled({ guardConcurrentRepositoryWrites: false }), false);
  assert.equal(repositoryWriteGuardEnabled({ guardConcurrentRepositoryWrites: true }), true);
  assert.equal(repositoryWriteGuardEnabled({ guardConcurrentRepositoryWrites: "true" }), false);
});


test("pathInsideOrSame accepts the project itself and nested caller directories", () => {
  assert.equal(pathInsideOrSame("C:\\Workspace", "C:\\Workspace"), true);
  assert.equal(pathInsideOrSame("C:\\Workspace\\Project\\src", "C:\\Workspace"), true);
  assert.equal(pathInsideOrSame("C:\\Workspace-other", "C:\\Workspace"), false);
});

test("findContainingProject chooses the most specific allowed project", () => {
  const projects = [
    { name: "Workspace", path: "C:\\Workspace" },
    { name: "Project", path: "C:\\Workspace\\Project" },
  ];
  assert.equal(
    findContainingProject(projects, "C:\\Workspace\\Project\\src").name,
    "Project",
  );
  assert.equal(findContainingProject(projects, "C:\\Other"), undefined);
});

test("samePath normalizes equivalent paths", () => {
  assert.equal(samePath("C:\\Workspace\\Project\\..\\Project", "C:\\Workspace\\Project"), true);
});

test("filesystem aliases resolve to the configured canonical project path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-project-alias-"));
  try {
    const canonical = path.join(root, "canonical");
    const alias = path.join(root, "alias");
    await mkdir(canonical);
    await symlink(canonical, alias, process.platform === "win32" ? "junction" : "dir");
    const projects = [{ name: "Workspace", path: canonical }];
    assert.equal(findContainingProject(projects, alias), projects[0]);
    assert.deepEqual(
      canonicalizeProjectRoots({
        activeProjectRoot: canonical,
        nested: [{ projectRoot: alias }],
        text: `Open ${path.join(alias, "README.md")}`,
        composite: `codex\0${alias.toLowerCase()}\0thread`,
      }, projects),
      {
        activeProjectRoot: canonical,
        nested: [{ projectRoot: canonical }],
        text: `Open ${path.join(canonical, "README.md")}`,
        composite: `codex\0${canonical.toLowerCase()}\0thread`,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Telegram API URL allows plaintext HTTP only on loopback", () => {
  assert.equal(httpBaseUrl("http://127.0.0.1:8081/", "api"), "http://127.0.0.1:8081");
  assert.equal(httpBaseUrl("https://telegram.example", "api"), "https://telegram.example");
  assert.throws(() => httpBaseUrl("http://telegram.example", "api"), /must use HTTPS/);
});

test("resolveConfigPath uses an activated external runtime but keeps the legacy fallback", async () => {
  const environment = { LOCALAPPDATA: "C:\\RuntimeBase" };
  const external = await resolveConfigPath({
    environment,
    agentHubRoot: "C:\\Workspace\\AgentHub",
    accessImpl: async () => {},
  });
  assert.equal(external, path.resolve("C:\\RuntimeBase", "Tyrael", "TelegramIntegration", "config.json"));

  const legacy = await resolveConfigPath({
    environment,
    agentHubRoot: "C:\\Workspace\\AgentHub",
    accessImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.equal(legacy, path.resolve("C:\\Workspace\\AgentHub", "config.json"));
});

test("resolveConfigPath honors the Agent Hub config before runtime discovery", async () => {
  assert.equal(
    await resolveConfigPath({
      environment: { AGENT_HUB_CONFIG: "C:\\Explicit\\config.json" },
      accessImpl: async () => { throw new Error("must not be called"); },
    }),
    path.resolve("C:\\Explicit\\config.json"),
  );
});

test("resolveConfigPath keeps the legacy config environment alias", async () => {
  assert.equal(
    await resolveConfigPath({
      environment: { TELEGRAM_CODEX_CONFIG: "C:\\Legacy\\config.json" },
      accessImpl: async () => { throw new Error("must not be called"); },
    }),
    path.resolve("C:\\Legacy\\config.json"),
  );
});

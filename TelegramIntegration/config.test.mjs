import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  findContainingProject,
  httpBaseUrl,
  pathInsideOrSame,
  resolveConfigPath,
  samePath,
} from "./config.mjs";


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

test("Telegram API URL allows plaintext HTTP only on loopback", () => {
  assert.equal(httpBaseUrl("http://127.0.0.1:8081/", "api"), "http://127.0.0.1:8081");
  assert.equal(httpBaseUrl("https://telegram.example", "api"), "https://telegram.example");
  assert.throws(() => httpBaseUrl("http://telegram.example", "api"), /must use HTTPS/);
});

test("resolveConfigPath uses an activated external runtime but keeps the legacy fallback", async () => {
  const environment = { LOCALAPPDATA: "C:\\RuntimeBase" };
  const external = await resolveConfigPath({
    environment,
    integrationRoot: "C:\\Workspace\\TelegramIntegration",
    accessImpl: async () => {},
  });
  assert.equal(external, path.resolve("C:\\RuntimeBase", "Tyrael", "TelegramIntegration", "config.json"));

  const legacy = await resolveConfigPath({
    environment,
    integrationRoot: "C:\\Workspace\\TelegramIntegration",
    accessImpl: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });
  assert.equal(legacy, path.resolve("C:\\Workspace\\TelegramIntegration", "config.json"));
});

test("resolveConfigPath honors an explicit config before runtime discovery", async () => {
  assert.equal(
    await resolveConfigPath({
      environment: { TELEGRAM_CODEX_CONFIG: "C:\\Explicit\\config.json" },
      accessImpl: async () => { throw new Error("must not be called"); },
    }),
    path.resolve("C:\\Explicit\\config.json"),
  );
});

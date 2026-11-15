import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNativeTrackedCapture } from "../../../src/infrastructure/filesystem/native-capture-content.mjs";
import { inventoryNativeCapture } from "../../../src/infrastructure/filesystem/native-capture-inventory.mjs";

test("tracked capture accepts only exact CRLF normalization across stream boundaries and preserves lone CR bytes", async t => {
  const repository = await mkdtemp(path.join(os.tmpdir(), "hub-capture-content-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const git = (args, { input = null } = {}) => new Promise((resolve, reject) => {
    const c = spawn("git", args, { cwd: repository, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }), out = [], err = [];
    c.stdout.on("data", b => out.push(b)); c.stderr.on("data", b => err.push(b)); c.on("error", reject);
    c.on("close", code => code ? reject(Error(Buffer.concat(err).toString("utf8"))) : resolve(Buffer.concat(out).toString("utf8").replace(/\r?\n$/u, "")));
    c.stdin.end(input);
  });
  await git(["init", "-b", "main"]);
  await git(["config", "core.autocrlf", "false"]);
  const physical = "x".repeat(65535) + "\r\n" + "y".repeat(65532) + "\r\n\rZ\r";
  const canonical = physical.replace(/\r\n/gu, "\n");
  const file = path.join(repository, "content.txt");
  await writeFile(file, canonical);
  await git(["add", "."]);
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "canonical"]);
  const head = await git(["rev-parse", "HEAD"]);
  await writeFile(file, physical);
  await assertNativeTrackedCapture({ repository, inventory: await inventoryNativeCapture(repository), git, head });
  await writeFile(file, physical.replace("Z", "Q"));
  await assert.rejects(assertNativeTrackedCapture({ repository, inventory: await inventoryNativeCapture(repository), git, head }), /unique unpublished bytes/u);
});

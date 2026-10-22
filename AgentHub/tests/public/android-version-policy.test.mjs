import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
const exec = promisify(execFile);
test("actual Android public-version guard preserves legacy upgrade and refuses semantic downgrade", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-android-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = path.join(root, "Probe.java");
  await writeFile(probe, `package app.agenthub.mobile;
public class Probe {
  static void check(boolean value) { if (!value) throw new AssertionError("version guard"); }
  public static void main(String[] args) {
    check(MobileVersion.allowsUpgrade("2026.10.22.1240", 29800000, "2.0.0", 30000001));
    check(MobileVersion.allowsUpgrade("2.0.9", 30000001, "2.0.10", 30000002));
    check(MobileVersion.allowsUpgrade("2.0.0-rc.1", 30000001, "2.0.0", 30000002));
    check(MobileVersion.allowsUpgrade("2.0.0-beta.2", 30000001, "2.0.0-beta.11", 30000002));
    check(!MobileVersion.allowsUpgrade("2.0.0", 30000001, "2.0.0-rc.1", 30000002));
    check(!MobileVersion.allowsUpgrade("2.0.10", 30000001, "2.0.9", 30000002));
    check(!MobileVersion.allowsUpgrade("2.0.0", 30000001, "2.0.1", 30000001));
    check(!MobileVersion.allowsUpgrade("unknown", 30000001, "2.0.0", 30000002));
    check(!MobileVersion.allowsUpgrade("2.0.0", 30000001, "2.0.1-01", 30000002));
    check(!MobileVersion.allowsUpgrade("2.0.0", 30000001, "2026.10.22", 30000002));
    check(!MobileVersion.allowsUpgrade("2026.10.22.1240", 29800000, "1.0.0", 30000001));
    System.out.println("11 Android guards PASS");
  }
}`, "utf8");
  await exec("javac", ["-d", root, path.resolve(import.meta.dirname,
    "../../AndroidApp/app/src/main/java/app/agenthub/mobile/MobileVersion.java"), probe], { timeout: 30_000, windowsHide: true });
  const result = await exec("java", ["-cp", root, "app.agenthub.mobile.Probe"], { timeout: 30_000, windowsHide: true });
  assert.equal(result.stdout.trim(), "11 Android guards PASS");
});

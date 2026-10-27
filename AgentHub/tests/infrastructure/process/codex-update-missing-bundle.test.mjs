import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexExecutableUpdateService } from "../../../src/infrastructure/process/codex-executable-update-service.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub348-selection-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const make = async (name, content) => {
    const directory = path.join(root, name); await mkdir(directory);
    await writeFile(path.join(directory, "codex.exe"), content);
    await writeFile(path.join(directory, "codex-code-mode-host.exe"), "helper");
    return { path: path.join(directory, "codex.exe"), version: "0.164.0-alpha.11.1",
      sha256: createHash("sha256").update(content).digest("hex").toUpperCase(),
      publisher: "CN=OpenAI OpCo, LLC", source: "desktop" };
  };
  const old = await make("old", "old-main"), next = await make("next", "new-main");
  let visible = [old], canaries = 0;
  const verifyRecorded = async identity => {
    const bytes = await readFile(identity.path);
    await readFile(path.join(path.dirname(identity.path), "codex-code-mode-host.exe"));
    if (createHash("sha256").update(bytes).digest("hex").toUpperCase() !== identity.sha256) throw new Error("SHA-256 changed");
    return identity;
  };
  const service = options => new CodexExecutableUpdateService({ stateFile: path.join(root, "state.json"),
    platform: "win32", verifyRecorded,
    discover: async () => {
      const candidates = [];
      for (const identity of visible) { try { await verifyRecorded(identity); candidates.push(identity); } catch {} }
      return { candidates, rejected: [] };
    },
    runCanary: async identity => { await verifyRecorded(identity); canaries += 1; return { ok: true }; },
    ...options });
  const baseline = service(); await baseline.selectForStart(); await baseline.markStartupSuccess();
  return { root, old, next, service, verifyRecorded, canaries: () => canaries,
    show: list => { visible = list; } };
}

for (const missing of ["codex.exe", "codex-code-mode-host.exe"]) {
  test(`persisted LKG with missing ${missing} selects a trusted same-version replacement`, async context => {
    const f = await fixture(context);
    await unlink(path.join(path.dirname(f.old.path), missing)); f.show([f.next]);
    const update = f.service();
    assert.equal(await update.selectForStart(), f.next.path);
    await update.verifySelectedForLaunch(f.next.path); await update.markStartupSuccess();
    assert.equal(update.diagnostics().active.sha256, f.next.sha256);
    assert.equal(f.canaries(), 2);
  });
}

test("a removed prepared candidate falls back to verified LKG without claiming activation", async context => {
  const f = await fixture(context); f.show([f.next, f.old]);
  const background = f.service(); await background.refreshInBackground();
  await unlink(f.next.path);
  const update = f.service();
  assert.equal(await update.selectForStart(), f.old.path);
  assert.equal(update.diagnostics().active.path, f.old.path);
});

test("disappearance after selection recovers only through the existing one-retry lifecycle decision", async context => {
  const f = await fixture(context); const update = f.service();
  await update.selectForStart(); await unlink(f.old.path); f.show([f.next]);
  let original;
  try { await update.verifySelectedForLaunch(f.old.path); } catch (error) { original = error; }
  assert.equal(original?.code, "ENOENT");
  assert.equal(await update.markStartupFailure(original), true);
  assert.equal(await update.selectForStart(), f.next.path);
});

test("unavailable pin or disabled automatic adoption cannot become false ready", async context => {
  for (const options of [{ autoUpdateEnabled: false }, { versionPin: "0.100.0" }]) {
    const f = await fixture(context); await unlink(f.old.path); f.show([f.next]);
    const update = f.service(options);
    await assert.rejects(update.selectForStart());
    assert.notEqual(update.diagnostics().status, "ready");
    assert.equal(f.canaries(), 1);
  }
});

test("lost-transport recovery retains active run identity without dispatching or clearing it", async context => {
  const f = await fixture(context); await unlink(f.old.path); f.show([f.next]);
  const run = { provider: "codex", threadId: "original-thread", turnId: "original-turn", clientId: "original-command", status: "running" };
  const before = structuredClone(run);
  const guarded = f.service({ activeRuns: () => [run] });
  await assert.rejects(guarded.selectForStart(), /deferred/u);
  const recovery = f.service({ activeRuns: () => [run], canRecoverUnavailableSelection: () => true });
  assert.equal(await recovery.selectForStart(), f.next.path);
  assert.deepEqual(run, before);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exactCanarySafeCommand, runCodexAppServerCompatibilityCanary } from "../../src/composition/codex-app-server-canary.mjs";

const fixture = path.resolve(import.meta.dirname, "../fixtures/codex-update-canary-app-server.mjs");
async function run(context, kind, environmentOverrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub348-approval-"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await mkdir(path.join(root, "home")); await writeFile(path.join(root, "home/auth.json"), "{}\n");
  const ledger = path.join(root, "effects.txt");
  const result = runCodexAppServerCompatibilityCanary({ path: process.execPath }, {
    dataDir: path.join(root, "data"),
    executableArgs: [fixture, `--command-case=${kind}`, `--tool-ledger=${ledger}`],
    environment: { ...process.env, CODEX_HOME: path.join(root, "home"), ...environmentOverrides }, protectDirectory: async () => {},
    rpcTimeoutMs: 3000, totalTimeoutMs: 15000, logger: { error() {} },
  });
  return { result, detail: async () => JSON.parse(await readFile(`${ledger}.detail.json`, "utf8")),
    effects: async () => (await readFile(ledger, "utf8").catch(e => {
    if (e.code === "ENOENT") return ""; throw e;
  })).trim().split("\n").filter(Boolean) };
}

for (const kind of ["direct-system", "direct-pwsh", "direct-pwsh-before-ack"]) {
  test(`confirms one actual fixed-shell tool without approval: ${kind}`, async context => {
    const probe = await run(context, kind), result = await probe.result;
    assert.equal(result.ok, true); assert.equal(result.evidence.safeToolCount, 1);
    assert.equal(result.evidence.safeToolApprovalCount, 0);
    assert.equal((await probe.effects()).length, 1);
    const details = await probe.detail();
    assert.equal(details.exitCode, 0); assert.equal(details.stdoutMatches, true); assert.equal(details.effectCount, 1);
  });
}
for (const invalid of ["foreign-thread", "foreign-turn", "cwd", "command", "item", "output", "exit", "missing-start", "shell", "environment"]) {
  test(`refuses invalid direct-tool proof: ${invalid}`, async context => {
    const probe = await run(context, `direct-pwsh-${invalid}`);
    await assert.rejects(probe.result, /safe-tool/u);
    assert.equal((await probe.effects()).length, 1, "fixture executes only the original safe command");
  });
}

test("safe command grammar accepts only the exact trusted shell and nonce body", () => {
  const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const nonce = "HUB_CANARY_TOOL_0123456789abcdef01234567";
  for (const command of [`"${shell}" -Command "Write-Output ${nonce}"`,
    `'${shell}' -NoProfile -Command 'Write-Output ${nonce}'`, `${shell} -Command Write-Output ${nonce}`]) {
    assert.equal(exactCanarySafeCommand(command, nonce, shell), true);
  }
  for (const command of [`Write-Output ${nonce}`, `"${shell}" -Command "Write-Output '${nonce}'"`,
    `"${shell}" -Command "Write-Output ${nonce}; whoami"`, `"${shell}" -Command "Write-Output ${nonce}" > out`,
    `"${shell}" -EncodedCommand ${nonce}`, `other.exe -Command "Write-Output ${nonce}"`]) {
    assert.equal(exactCanarySafeCommand(command, nonce, shell), false);
  }
});

for (const kind of ["normal", "profile", "before-ack", "missing-decisions"]) {
  test(`one bound safe-command approval: ${kind}`, async context => {
    const probe = await run(context, kind), result = await probe.result;
    assert.equal(result.ok, true); assert.equal(result.evidence.safeToolApprovalCount, 1);
    assert.equal(result.evidence.safeToolCount, 1); assert.equal(result.evidence.mcpReadCount, 1);
    assert.equal(result.evidence.restartResume, true); assert.equal((await probe.effects()).length, 1);
  });
}
for (const kind of ["thread", "turn", "cwd", "command", "nonce", "shell", "item", "decisions", "stdin", "approval-id", "environment", "network", "duplicate", "late", "wrong-completion"]) {
  test(`refuses unbound or repeated safe-command approval: ${kind}`, async context => {
    const probe = await run(context, kind);
    await assert.rejects(probe.result, /safe-tool|protocol|unbound|cancel/u);
    const count = (await probe.effects()).length;
    assert.ok(count <= (["duplicate", "late", "wrong-completion"].includes(kind) ? 1 : 0));
  });
}

test("uppercase ProgramFiles supplies the direct-shell candidate when canonical is undefined", async context => {
  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES;
  assert.ok(programFiles);
  const probe = await run(context, "direct-pwsh", { ProgramFiles: undefined, PROGRAMFILES: programFiles });
  const result = await probe.result;
  assert.equal(result.ok, true);
  assert.equal(result.evidence.safeToolCount, 1);
  assert.equal(result.evidence.safeToolApprovalCount, 0);
  assert.equal((await probe.effects()).length, 1);
  const detail = await probe.detail();
  assert.equal(detail.exitCode, 0);
  assert.equal(detail.stdoutMatches, true);
});

test("invalid canonical ProgramFiles never falls back to the uppercase alias", async context => {
  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES;
  assert.ok(programFiles);
  for (const ProgramFiles of ["", "C:\\Repository\\Program Files"]) {
    const probe = await run(context, "direct-pwsh", { ProgramFiles, PROGRAMFILES: programFiles });
    await assert.rejects(probe.result, /safe-tool/u);
    assert.equal((await probe.effects()).length, 1, "fixture executed the same safe command; candidate refused its mismatched root");
    const detail = await probe.detail();
    assert.equal(detail.exitCode, 0);
    assert.equal(detail.stdoutMatches, true);
  }
});

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { E2eChildProcessOwner } from "../../e2e/telegram-harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("installed production factories wire every retention owner through ready, timer and shutdown drain", { timeout: 40_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-retention-startup-"));
  const owner = new E2eChildProcessOwner({ label: "isolated production retention" });
  t.after(async () => {
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(["data", "project", "profile", "temp"].map(name => mkdir(path.join(root, name))));
  const config = path.join(root, "config.json");
  await writeFile(config, JSON.stringify({
    components: { telegram: false, miniApp: false, androidApp: false, testContour: false },
    provider: "codex", projectRoot: path.join(root, "project"), dataDir: path.join(root, "data"),
    projects: [{ name: "Private startup fixture", path: path.join(root, "project") }],
    codexExecutable: process.execPath,
    codexExecutableArgs: [path.join(ROOT, "e2e/fake-codex-app-server.mjs"), "--state", path.join(root, "fake.json")],
    claudeExecutable: process.execPath, claudeExecutableArgs: [path.join(ROOT, "e2e/fake-claude-cli.mjs")],
    codexRolloutContext: { enabled: false }, voiceEnabled: false, ttsEnabled: false,
    taskBoard: { triageEnabled: false },
  }));
  // Do not inherit live Hub identity, provider homes, credentials, ports or flags.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"].includes(name.toUpperCase())));
  Object.assign(env, { HOME: path.join(root, "profile"), USERPROFILE: path.join(root, "profile"),
    CODEX_HOME: path.join(root, "profile/codex"), CLAUDE_CONFIG_DIR: path.join(root, "profile/claude"),
    TEMP: path.join(root, "temp"), TMP: path.join(root, "temp"),
    AGENT_HUB_CONFIG: config, AGENT_HUB_RUNTIME_ROOT: root, AGENT_HUB_RELEASE_ID: "isolated-installed-retention",
    AGENT_HUB_DISABLE_SECRET_ACL: "1" });
  const child = owner.start(() => fork(path.join(ROOT, "tests/fixtures/storage-retention-startup.mjs"), [],
    { cwd: ROOT, env, execArgv: ["--no-warnings"], silent: true, windowsHide: true }));
  let report, stderr = "";
  const stages = [];
  child.on("message", message => {
    if (message.stage) stages.push(message); else report = message;
    t.diagnostic(JSON.stringify(message));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const log = await readFile(path.join(root, "data/agent-hub-error.log"), "utf8").catch(() => "");
  assert.equal(code, 0, `${report?.error ?? stderr}\n${JSON.stringify(stages)}\n${log}`);
  assert.equal(report?.ok, true, JSON.stringify(report));
  // These are normal startup/fake-provider diagnostics, not JS exceptions.
  const expectedDiagnostic = /^(?:Starting Codex: .+|Local Codex rollout index does not cover the active project; using thread\/list|Cannot poll Claude rate limits: Claude did not return recognizable limit data)$/u;
  assert.deepEqual(stderr.split(/\r?\n/u).filter(line => line && !expectedDiagnostic.test(line)), []);
  await assert.rejects(access(path.join(root, "data/bot.lock")), { code: "ENOENT" });
});

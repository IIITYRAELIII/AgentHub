import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { importCompositionWithPorts } from "../helpers/composition-ports.fixture.mjs";
import * as startupTrace from "../../src/composition/command-trace-composition.mjs";

test("actual startup propagates the ordinary store open failure without quarantining data", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-startup-open-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "journal.sqlite");
  const original = Buffer.from("not a sqlite database");
  await fs.writeFile(file, original);
  const logs = [], captured = [];
  let released = false;
  const { createHubInfrastructure } = await importCompositionWithPorts(
    new URL("../../src/composition/infrastructure-composition.mjs", import.meta.url), {
      "../infrastructure/persistence/rotating-log.mjs": { installRotatingConsole() {} },
      "../infrastructure/diagnostics/sentry-diagnostics.mjs": { sentryDiagnostics: {
        configure() {}, captureException(error) { captured.push(error); },
      } },
      "../infrastructure/process/instance-lock.mjs": { SingleInstanceGuard: class {
        instanceToken = "isolated-open-failure";
        async acquire() {}
        async release() { released = true; }
      } },
      "../infrastructure/persistence/trusted-device-store.mjs": { TrustedDeviceStore: class {
        async load() {}
      } },
      "./command-trace-composition.mjs": { ...startupTrace,
        measureStartupBeforeTrace: (stage, operation, options) => startupTrace.measureStartupBeforeTrace(
          stage, operation, { ...options, logger: { info: (_prefix, body) => logs.push(JSON.parse(body)) } }),
      },
    });
  let failure;
  await assert.rejects(createHubInfrastructure({
    config: { dataDir: root, projectRoot: root, diagnostics: { sentry: {} },
      components: {}, miniApp: { enabled: false }, projects: [] },
    agentHubRoot: root, runtimeCommandRoot: root, journalDatabaseFile: file,
    instanceLockFile: path.join(root, "instance.lock"),
  }), error => { failure = error; return /not a database/u.test(error.message); });
  assert.equal(captured.includes(failure), true);
  assert.equal(released, true);
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal((await fs.readdir(root)).some(name => /recovery|quarantine/u.test(name)), false);
  assert.equal(logs.find(p => p.stage === "task-board-open" && p.outcome === "failed")?.error, failure.message);
  assert.equal(logs.some(p => /inspection|copy|quarantine/u.test(p.phase ?? "")), false);
});

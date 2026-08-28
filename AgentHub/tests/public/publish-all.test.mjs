import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseArguments,
  publicationSteps,
  publishAll,
  restartRuntimeAndVerify,
  runStep,
  waitForRuntimeReplacement,
} from "../../publish-all.mjs";
import { classifyPublicationChanges, parseChangedArguments, publishChanged } from "../../publish-changed.mjs";
import { runPublicationSteps } from "../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { detectGitCommonDirectory, ensureWrangler, resolveWrangler } from "../../wrangler-runner.mjs";
import {
  assertCleanPublicationTree,
  assertCurrentPublicationRevision,
  parseWorkingTreeStatus,
} from "../../src/infrastructure/persistence/publication-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("publication rejects a dirty AgentHub working tree", async () => {
  assert.deepEqual(parseWorkingTreeStatus(" M AgentHub/server.mjs\n?? AgentHub/new.mjs\n"), [
    " M AgentHub/server.mjs",
    "?? AgentHub/new.mjs",
  ]);
  await assert.rejects(
    assertCleanPublicationTree({
      cwd: ROOT,
      status: async () => " M AgentHub/server.mjs\n",
    }),
    /dirty working tree/u,
  );
  assert.equal(await assertCleanPublicationTree({ cwd: ROOT, status: async () => "" }), true);
});

test("publication rejects a checkout older than the current main revision", async () => {
  const revisions = new Map([
    ["HEAD", "old"],
    ["refs/heads/main", "new"],
  ]);
  await assert.rejects(
    assertCurrentPublicationRevision({
      cwd: ROOT,
      revision: async (args) => revisions.get(args.at(-1)),
    }),
    /устаревшей ревизии/u,
  );
  revisions.set("HEAD", "new");
  assert.equal(await assertCurrentPublicationRevision({
    cwd: ROOT,
    revision: async (args) => revisions.get(args.at(-1)),
  }), "new");
});

test("publication allows a detached checkout at origin main", async () => {
  const revisions = new Map([
    ["HEAD", "origin"],
    ["refs/heads/main", "stale-local"],
    ["refs/remotes/origin/main", "origin"],
  ]);
  assert.equal(await assertCurrentPublicationRevision({
    cwd: ROOT,
    revision: async (args) => {
      if (args[0] === "symbolic-ref") throw new Error("detached");
      return revisions.get(args.at(-1));
    },
  }), "origin");
});

test("publication runs Test Contour only when explicitly requested", () => {
  const steps = publicationSteps({
    fullTestCheckpointId: "release-checkpoint",
  });
  assert.deepEqual(steps.map((item) => item.label), [
    "Полные тесты Agent Hub",
    "Сборка Agent Hub Mobile",
    "Сборка runtime-релиза",
    "Развёртывание Mini App Worker",
    "Проверка Mini App Worker",
    "Активация runtime-релиза",
    "Установка расширения VS Code",
  ]);

  assert.deepEqual(steps[0].args.slice(-2), ["run", "test:all"]);
  assert.equal(steps[0].env.AGENT_HUB_FULL_TEST_CHECKPOINT_ID, "release-checkpoint");
  assert.deepEqual(steps[1].args.slice(-2), ["run", "android:build"]);
  assert.equal(
    steps.findIndex((step) => step.label.includes("Развёртывание")),
    3,
    "deployment must start only after all validation surfaces pass",
  );
  assert.ok(
    steps.findIndex((step) => step.label === "Сборка runtime-релиза")
      < steps.findIndex((step) => step.label === "Проверка Mini App Worker"),
    "the live direct asset gateway must observe the candidate runtime before Worker verification",
  );

  const withContour = publicationSteps({ testContour: true });
  assert.deepEqual(withContour.slice(0, 3).map((item) => item.label), [
    "Полные тесты Agent Hub",
    "Тестовый контур Agent Hub",
    "Сборка Agent Hub Mobile",
  ]);
  assert.deepEqual(withContour[1].args.slice(-4), ["run", "contour:verify", "--", "--require-installed"]);
});

test("publication arguments reject typos and support bounded skips", () => {
  assert.deepEqual(parseArguments(["--skip-tests", "--skip-worker", "--skip-restart"]), {
    skipTests: true,
    skipWorker: true,
    skipRestart: true,
    testContour: false,
  });
  assert.equal(parseArguments(["--test-contour"]).testContour, true);
  assert.throws(() => parseArguments(["--skip-everything"]), /Неизвестные аргументы/u);
  assert.deepEqual(
    publicationSteps({ skipTests: true, skipWorker: true }).map((step) => step.label),
    [
      "Сборка Agent Hub Mobile",
      "Сборка runtime-релиза",
      "Активация runtime-релиза",
      "Установка расширения VS Code",
    ],
  );
});

test("publication requests the server's safe deferred restart last", async () => {
  const events = [];
  await publishAll(["--skip-tests", "--skip-worker"], {
    run: async (step) => events.push(step.label),
    restart: async (action) => {
      events.push(action);
      return { message: "scheduled" };
    },
    record: async () => events.push("record-publication"),
  });
  assert.deepEqual(events, [
    "Сборка Agent Hub Mobile",
    "Сборка runtime-релиза",
    "Активация runtime-релиза",
    "Установка расширения VS Code",
    "restart-server",
    "record-publication",
  ]);
});

test("publication restart tolerates a stalled outgoing runtime", async () => {
  let request = null;
  await restartRuntimeAndVerify(async (...args) => {
    request = args;
    return { accepted: true };
  }, async () => {}, "C:\\runtime");
  assert.deepEqual(request, [
    "restart-server",
    {},
    { runtimeRoot: "C:\\runtime", timeoutMs: 30_000 },
  ]);
});

test("publication skips optional test contour when the component is disabled", async () => {
  const events = [];
  await publishAll([], {
    run: async (step) => events.push(step.label),
    restart: async (action) => {
      events.push(action);
      return { message: "scheduled" };
    },
    record: async () => events.push("record-publication"),
    ensureWorkerDependency: async () => {},
    testContourEnabled: async () => false,
  });
  assert.ok(events.includes("Полные тесты Agent Hub"));
  assert.ok(!events.includes("Тестовый контур Agent Hub"));
  assert.ok(events.indexOf("Полные тесты Agent Hub") < events.indexOf("Сборка Agent Hub Mobile"));
});

test("full publication does not wait on the release turn that blocks its safe restart", async () => {
  const events = [];
  await publishAll(["--skip-tests", "--skip-worker"], {
    prepareVersion: async () => events.push("release-version"),
    run: async (step) => events.push(step.label),
    restart: async () => {
      events.push("restart-server");
      return { accepted: true, waiting: true, message: "waiting for active turn" };
    },
    verifyRestart: async () => assert.fail("deferred restart cannot finish before the active release turn"),
    record: async () => events.push("record-publication"),
  });
  assert.equal(events[0], "release-version");
  assert.deepEqual(events.slice(-2), ["restart-server", "record-publication"]);
});

test("publication stage timeout terminates the complete process tree", async () => {
  const child = new EventEmitter();
  child.pid = 4242;
  let stoppedPid = null;
  await assert.rejects(runStep({
    label: "Зависшая стадия",
    command: "ignored",
    args: [],
    timeoutMs: 1,
  }, {
    spawnImpl: () => child,
    stopTree: async (pid) => { stoppedPid = pid; },
  }), /превышен таймаут/u);
  assert.equal(stoppedPid, 4242);
});

test("publication stage forwards its test checkpoint identity", async () => {
  const child = new EventEmitter();
  let spawnedEnvironment = null;
  const completed = runStep({
    label: "Полные тесты",
    command: "ignored",
    args: [],
    env: { AGENT_HUB_FULL_TEST_CHECKPOINT_ID: "release-checkpoint" },
  }, {
    spawnImpl: (_command, _args, options) => {
      spawnedEnvironment = options.env;
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
  });
  await completed;
  assert.equal(spawnedEnvironment.AGENT_HUB_FULL_TEST_CHECKPOINT_ID, "release-checkpoint");
});

test("runtime readiness requires a replacement endpoint and a successful probe", async () => {
  const endpoints = [{ endpointId: "old" }, { endpointId: "new" }];
  const probes = [];
  const result = await waitForRuntimeReplacement({
    previousEndpointId: "old",
    timeoutMs: 100,
    readEndpoint: async () => endpoints.shift() ?? { endpointId: "new" },
    probe: async (action) => probes.push(action),
    delay: async () => {},
  });
  assert.equal(result.endpointId, "new");
  assert.deepEqual(probes, ["snapshot"]);
});

test("selective publication maps shared UI to runtime, Worker and surface tests", async () => {
  assert.deepEqual(
    classifyPublicationChanges([
      "CHANGELOG.md",
      "1C_ACCESS/access.json",
      "AgentHub/config.example.json",
      "AgentHub/architecture-migration-inventory.json",
      "AgentHub/assets/web-app/app.js",
      "AgentHub/message-lifecycle.test.mjs",
    ]),
    {
      runtime: true,
      runtimeRestart: true,
      worker: true,
      android: false,
      vscode: false,
      unitTests: true,
      surfaceTests: true,
      fullTests: false,
      unknown: [],
    },
  );
  assert.deepEqual(
    classifyPublicationChanges(["AgentHub/unclassified-artifact.bin"]).unknown,
    ["AgentHub/unclassified-artifact.bin"],
  );
  assert.deepEqual(
    classifyPublicationChanges(["AgentHub/theme-registry.cjs"]),
    {
      runtime: true,
      runtimeRestart: true,
      worker: true,
      android: false,
      vscode: false,
      unitTests: true,
      surfaceTests: true,
      fullTests: false,
      unknown: [],
    },
  );
  assert.deepEqual(
    classifyPublicationChanges(["AgentHub/RuntimeHost/AgentHub.RuntimeHost.cs"]),
    {
      runtime: true,
      runtimeRestart: true,
      worker: false,
      android: false,
      vscode: false,
      unitTests: true,
      surfaceTests: true,
      fullTests: false,
      unknown: [],
    },
  );
  assert.deepEqual(
    classifyPublicationChanges(["AgentHub/package-lock.json"]),
    {
      runtime: true,
      runtimeRestart: true,
      worker: false,
      android: false,
      vscode: false,
      unitTests: true,
      surfaceTests: true,
      fullTests: false,
      unknown: [],
    },
  );
  assert.deepEqual(parseChangedArguments(["--from", "abc", "--skip-restart", "--full-tests"]), {
    from: "abc",
    skipRestart: true,
    fullTests: true,
    testContour: false,
  });
  assert.equal(parseChangedArguments(["--test-contour"]).testContour, true);
});

test("selective publication runs unit and cross-surface E2E tests for runtime code", async () => {
  const labels = [];
  const result = await publishChanged(["--from", "base", "--skip-restart"], {
    run: async (step) => labels.push(step.label),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async () => {},
    revision: async () => "head",
    diff: async () => ["AgentHub/task-catalog.mjs"],
  });

  assert.equal(result.plan.unitTests, true);
  assert.equal(result.plan.fullTests, false);
  assert.deepEqual(labels, [
    "Проверка синтаксиса Agent Hub",
    "Unit-тесты Agent Hub",
    "Межповерхностные E2E Agent Hub",
    "Тесты расширения VS Code",
    "Сборка runtime-релиза",
    "Активация runtime-релиза",
  ]);
  assert.ok(!labels.includes("Полные тесты Agent Hub"));
});

test("selective publication keeps Test Contour optional with full tests", async () => {
  const steps = [];
  await publishChanged(["--from", "base", "--skip-restart", "--full-tests"], {
    run: async (step) => steps.push(step),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async () => {},
    revision: async () => "head",
    diff: async () => ["AgentHub/assets/web-app/app.js"],
    ensureWorkerDependency: async () => {},
    testContourEnabled: async () => true,
  });
  const labels = steps.map((step) => step.label);
  assert.ok(labels.includes("Полные тесты Agent Hub"));
  assert.ok(!labels.includes("Тестовый контур Agent Hub"));
  assert.ok(!labels.includes("Тесты расширения VS Code"));
  assert.ok(!labels.includes("Контракт интерфейсов Agent Hub"));
  assert.match(
    steps.find((step) => step.label === "Полные тесты Agent Hub").env.AGENT_HUB_FULL_TEST_CHECKPOINT_ID,
    /^[0-9a-f]{64}$/u,
  );
  assert.equal(
    steps.find((step) => step.label === "Полные тесты Agent Hub").env.AGENT_HUB_FULL_TEST_SOURCE_FINGERPRINT,
    undefined,
  );
});

test("selective publication can opt into Test Contour without full tests", async () => {
  const labels = [];
  await publishChanged(["--from", "base", "--skip-restart", "--test-contour"], {
    run: async (step) => labels.push(step.label),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async () => {},
    revision: async () => "head",
    diff: async () => ["AgentHub/assets/web-app/app.js"],
    ensureWorkerDependency: async () => {},
  });
  assert.ok(labels.includes("Unit-тесты Agent Hub"));
  assert.ok(labels.includes("Тестовый контур Agent Hub"));
  assert.ok(labels.indexOf("Тестовый контур Agent Hub") < labels.indexOf("Сборка runtime-релиза"));
});

test("selective publication records the exact published revision", async () => {
  const steps = [];
  let written = null;
  const result = await publishChanged(["--from", "base", "--skip-restart"], {
    run: async (step) => steps.push(step),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async (value) => { written = value; },
    revision: async () => "head",
    diff: async () => ["AgentHub/assets/web-app/app.js"],
    ensureWorkerDependency: async () => {},
  });
  assert.equal(result.revision, "head");
  assert.equal(written.revision, "head");
  assert.deepEqual(steps.map((step) => step.label), [
    "Проверка синтаксиса Agent Hub",
    "Unit-тесты Agent Hub",
    "Межповерхностные E2E Agent Hub",
    "Тесты расширения VS Code",
    "Сборка runtime-релиза",
    "Развёртывание Mini App Worker",
    "Проверка Mini App Worker",
    "Активация runtime-релиза",
  ]);
  assert.deepEqual(
    steps.find((step) => step.label === "Межповерхностные E2E Agent Hub").args.slice(-2),
    ["run", "test:e2e"],
  );
  assert.deepEqual(
    classifyPublicationChanges(["AgentHub/AGENT_HUB_GUIDE.md"]),
    {
      runtime: true,
      runtimeRestart: true,
      worker: false,
      android: false,
      vscode: false,
      unitTests: true,
      surfaceTests: true,
      fullTests: false,
      unknown: [],
    },
  );
});

test("Worker packages only a verified published Android artifact", () => {
  const build = fs.readFileSync(path.join(ROOT, "cloudflare-worker", "build-assets.mjs"), "utf8");
  assert.match(build, /assets["'], ["']mobile/u);
  assert.match(build, /update\.json/u);
  assert.match(build, /createHash\("sha256"\)/u);
  assert.doesNotMatch(build, /app["'],\s*"build"/u);
});

test("selective frontend publication records state after verified restart", async () => {
  const events = [];
  await publishChanged(["--from", "base"], {
    run: async (step) => events.push(step.label),
    restart: async () => events.push("restart-server"),
    readState: async () => null,
    writeState: async () => events.push("record-publication"),
    revision: async () => "head",
    diff: async () => ["AgentHub/assets/web-app/app.js"],
    ensureWorkerDependency: async () => {},
  });
  assert.ok(events.includes("record-publication"));
  assert.ok(events.indexOf("restart-server") < events.indexOf("record-publication"));
});

test("selective backend publication records state after verified restart", async () => {
  const events = [];
  await publishChanged(["--from", "base"], {
    run: async (step) => events.push(step.label),
    restart: async () => events.push("restart-server"),
    readState: async () => null,
    writeState: async () => events.push("record-publication"),
    revision: async () => "head",
    diff: async () => ["AgentHub/src/interfaces/web/mini-app-server.mjs"],
  });
  assert.ok(events.indexOf("restart-server") < events.indexOf("record-publication"));
});

test("selective backend publication records an already queued safe restart without waiting", async () => {
  const events = [];
  await publishChanged(["--from", "base"], {
    run: async (step) => events.push(step.label),
    restart: async () => {
      events.push("restart-server");
      return { accepted: false, message: "already queued" };
    },
    verifyRestart: async () => assert.fail("an existing safe restart is deferred"),
    readState: async () => null,
    writeState: async () => events.push("record-publication"),
    revision: async () => "head",
    diff: async () => ["AgentHub/src/interfaces/web/mini-app-server.mjs"],
  });
  assert.deepEqual(events.slice(-2), ["restart-server", "record-publication"]);
});

test("every validation failure stops publication before deployment", async () => {
  const scenarios = [
    { args: [], failedLabel: "Полные тесты Agent Hub", expected: ["Полные тесты Agent Hub"] },
    {
      args: ["--test-contour"],
      failedLabel: "Тестовый контур Agent Hub",
      expected: ["Полные тесты Agent Hub", "Тестовый контур Agent Hub"],
    },
    {
      args: [],
      failedLabel: "Сборка Agent Hub Mobile",
      expected: ["Полные тесты Agent Hub", "Сборка Agent Hub Mobile"],
    },
  ];

  for (const { args, failedLabel, expected } of scenarios) {
    const events = [];
    let restartCalled = false;

    await assert.rejects(
      publishAll(args, {
        run: async (step) => {
          events.push(step.label);
          if (step.label === failedLabel) {
            throw new Error(`synthetic validation failure: ${failedLabel}`);
          }
        },
        restart: async () => {
          restartCalled = true;
        },
        ensureWorkerDependency: async () => {},
        testContourEnabled: async () => true,
      }),
      /synthetic validation failure/u,
    );

    assert.deepEqual(
      events,
      expected,
    );
    assert.equal(restartCalled, false);
  }
});

test("CI runs all Agent Hub client checks without deployment", () => {
  const workflow = fs.readFileSync(
    path.resolve(ROOT, "..", ".github", "workflows", "agent-hub-ci.yml"),
    "utf8",
  );

  assert.match(workflow, /runs-on:\s*windows-latest/u);
  assert.match(workflow, /npm run test:all/u);
  assert.match(workflow, /npm test --prefix VSCodeExtension/u);
  assert.match(workflow, /AndroidApp[\\/]build\.ps1/u);
  assert.doesNotMatch(workflow, /worker:deploy|publish:all|runtime:deploy|wrangler deploy/u);
  assert.doesNotMatch(workflow, /\bsecrets\.[A-Za-z0-9_]+/u);
});

test("clean worktrees reuse the pinned Wrangler from the main worktree", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-clean-publish-"));
  try {
    const cleanRoot = path.join(temporary, "clean", "AgentHub");
    const repositoryRoot = path.join(temporary, "main");
    const dependencyRoot = path.join(repositoryRoot, "AgentHub");
    const installedRoot = path.join(dependencyRoot, "node_modules", "wrangler");
    const expected = path.join(installedRoot, "bin", "wrangler.js");
    fs.mkdirSync(path.dirname(expected), { recursive: true });
    fs.mkdirSync(cleanRoot, { recursive: true });
    fs.writeFileSync(path.join(cleanRoot, "package.json"), JSON.stringify({
      devDependencies: { wrangler: "4.115.0" },
    }));
    fs.writeFileSync(path.join(installedRoot, "package.json"), JSON.stringify({ version: "4.115.0" }));
    fs.writeFileSync(expected, "");

    assert.equal(
      resolveWrangler({
        root: cleanRoot,
        environment: {},
        gitCommonDirectory: path.join(repositoryRoot, ".git"),
      }),
      expected,
    );

  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("publication restores the exact locked Wrangler before validation", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-wrangler-preflight-"));
  try {
    const root = path.join(temporary, "AgentHub");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      devDependencies: { wrangler: "4.115.0" },
    }));
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
      packages: {
        "node_modules/wrangler": {
          version: "4.115.0",
          integrity: "sha512-test",
        },
      },
    }));
    let installs = 0;
    const entry = await ensureWrangler({
      root,
      environment: {},
      gitCommonDirectory: "",
      install: async () => {
        installs += 1;
        const installedRoot = path.join(root, "node_modules", "wrangler");
        fs.mkdirSync(path.join(installedRoot, "bin"), { recursive: true });
        fs.writeFileSync(path.join(installedRoot, "package.json"), JSON.stringify({ version: "4.115.0" }));
        fs.writeFileSync(path.join(installedRoot, "bin", "wrangler.js"), "");
      },
    });
    assert.equal(installs, 1);
    assert.equal(entry, path.join(root, "node_modules", "wrangler", "bin", "wrangler.js"));
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("selective publication resumes after the last successful stage", async () => {
  let savedCheckpoint = null;
  const checkpoint = {
    read: async () => savedCheckpoint,
    write: async (value) => { savedCheckpoint = value; },
    clear: async () => { savedCheckpoint = null; },
  };
  const common = {
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async () => {},
    revision: async () => "head",
    diff: async () => ["AgentHub/assets/web-app/app.js"],
    ensureWorkerDependency: async () => {},
    checkpoint,
  };
  const firstRun = [];
  await assert.rejects(
    publishChanged(["--from", "base", "--skip-restart"], {
      ...common,
      run: async (step) => {
        firstRun.push(step.label);
        if (step.label === "Проверка Mini App Worker") throw new Error("verification failed");
      },
    }),
    /verification failed/u,
  );
  const resumedRun = [];
  await publishChanged(["--from", "base", "--skip-restart"], {
    ...common,
    run: async (step) => resumedRun.push(step.label),
  });
  assert.ok(firstRun.includes("Unit-тесты Agent Hub"));
  assert.deepEqual(resumedRun, [
    "Проверка Mini App Worker",
    "Активация runtime-релиза",
  ]);
  assert.equal(savedCheckpoint, null);
});

test("selective publication prepares the committed product version before validation", async () => {
  const events = [];
  await publishChanged(["--from", "base", "--skip-restart"], {
    before: async () => events.push("clean-tree"),
    prepareVersion: async () => events.push("release-version"),
    run: async (step) => events.push(step.label),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async () => {},
    revision: async () => "head",
    diff: async () => ["AgentHub/task-catalog.mjs"],
  });
  assert.deepEqual(events.slice(0, 3), [
    "clean-tree",
    "release-version",
    "Проверка синтаксиса Agent Hub",
  ]);
});

test("publication reuses content-identical stages across correction revisions", async () => {
  let savedCheckpoint = null;
  const checkpoint = {
    read: async () => savedCheckpoint,
    write: async (value) => { savedCheckpoint = structuredClone(value); },
  };
  const first = [];
  await assert.rejects(runPublicationSteps([
    { label: "deploy", fingerprint: "payload-v1" },
    { label: "verify", fingerprint: "verifier-v1" },
  ], {
    checkpoint,
    checkpointScope: { mode: "changed", from: "base" },
    identity: { revision: "correction-1" },
    run: async (step) => {
      first.push(step.label);
      if (step.label === "verify") throw new Error("network");
    },
  }), /network/u);

  const second = [];
  await runPublicationSteps([
    { label: "deploy", fingerprint: "payload-v1" },
    { label: "verify", fingerprint: "verifier-v2" },
  ], {
    checkpoint,
    checkpointScope: { mode: "changed", from: "base" },
    identity: { revision: "correction-2" },
    run: async (step) => second.push(step.label),
  });
  assert.deepEqual(first, ["deploy", "verify"]);
  assert.deepEqual(second, ["verify"]);
});

test("clean worktrees resolve the common Git directory without invoking Git", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-git-common-"));
  try {
    const repositoryRoot = path.join(temporary, "worktree");
    const agentHubRoot = path.join(repositoryRoot, "AgentHub");
    const linkedGitDirectory = path.join(temporary, "main", ".git", "worktrees", "release");
    const commonGitDirectory = path.join(temporary, "main", ".git");
    fs.mkdirSync(agentHubRoot, { recursive: true });
    fs.mkdirSync(linkedGitDirectory, { recursive: true });
    fs.writeFileSync(path.join(repositoryRoot, ".git"), `gitdir: ${linkedGitDirectory}\n`);
    fs.writeFileSync(path.join(linkedGitDirectory, "commondir"), "../..\n");

    assert.equal(detectGitCommonDirectory(agentHubRoot), commonGitDirectory);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("Wrangler dependency discovery never falls back to a Git subprocess", () => {
  const runner = fs.readFileSync(path.join(ROOT, "wrangler-runner.mjs"), "utf8");
  assert.doesNotMatch(runner, /spawnSync\(/u);
  assert.doesNotMatch(runner, /--git-common-dir/u);
});

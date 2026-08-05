import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArguments, publicationSteps, publishAll } from "./publish-all.mjs";
import { classifyPublicationChanges, parseChangedArguments, publishChanged } from "./publish-changed.mjs";
import { detectGitCommonDirectory, resolveWrangler } from "./wrangler-runner.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test("publication validates every client before the first deployment", () => {
  const steps = publicationSteps();
  assert.deepEqual(steps.map((item) => item.label), [
    "Полные тесты Agent Hub",
    "Тесты расширения VS Code",
    "Сборка и smoke-проверка Agent Hub Desktop",
    "Сборка Agent Hub Mobile",
    "Публикация Mini App Worker",
    "Сборка runtime-релиза",
    "Активация runtime-релиза",
    "Установка расширения VS Code",
  ]);

  assert.deepEqual(steps[0].args.slice(-2), ["run", "test:all"]);
  assert.deepEqual(steps[1].args.slice(-3), ["test", "--prefix", "VSCodeExtension"]);
  assert.match(steps[2].args.at(-1), /ci[\\/]desktop-smoke\.ps1$/u);
  assert.deepEqual(steps[3].args.slice(-2), ["run", "android:build"]);
  assert.equal(
    steps.findIndex((step) => step.label.includes("Публикация")),
    4,
    "deployment must start only after all four validation surfaces pass",
  );
});

test("publication arguments reject typos and support bounded skips", () => {
  assert.deepEqual(parseArguments(["--skip-tests", "--skip-worker", "--skip-restart"]), {
    skipTests: true,
    skipWorker: true,
    skipRestart: true,
  });
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

test("selective publication maps shared UI to runtime and Worker only", async () => {
  assert.deepEqual(
    classifyPublicationChanges([
      "CHANGELOG.md",
      "1C_ACCESS/access.json",
      "AgentHub/config.example.json",
      "AgentHub/assets/mini-app/app.js",
      "AgentHub/message-lifecycle.test.mjs",
    ]),
    {
      runtime: true,
      worker: true,
      android: false,
      desktop: false,
      vscode: false,
      unitTests: false,
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
      worker: false,
      android: false,
      desktop: false,
      vscode: false,
      unitTests: true,
      fullTests: false,
      unknown: [],
    },
  );
  assert.deepEqual(
    classifyPublicationChanges(["AgentHub/RuntimeHost/AgentHub.RuntimeHost.cs"]),
    {
      runtime: true,
      worker: false,
      android: false,
      desktop: false,
      vscode: false,
      unitTests: true,
      fullTests: false,
      unknown: [],
    },
  );
  assert.deepEqual(parseChangedArguments(["--from", "abc", "--skip-restart", "--full-tests"]), {
    from: "abc",
    skipRestart: true,
    fullTests: true,
  });
});

test("selective publication runs unit tests for runtime code without the slow process E2E suite", async () => {
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
    "Тесты расширения VS Code",
    "Сборка runtime-релиза",
    "Активация runtime-релиза",
  ]);
  assert.ok(!labels.includes("Полные тесты Agent Hub"));
});

test("selective publication can request the full Agent Hub test suite explicitly", async () => {
  const labels = [];
  await publishChanged(["--from", "base", "--skip-restart", "--full-tests"], {
    run: async (step) => labels.push(step.label),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async () => {},
    revision: async () => "head",
    diff: async () => ["AgentHub/assets/mini-app/app.js"],
  });
  assert.ok(labels.includes("Полные тесты Agent Hub"));
  assert.ok(!labels.includes("Тесты жизненного цикла сообщений"));
});

test("selective publication records the exact published revision", async () => {
  const labels = [];
  let written = null;
  const result = await publishChanged(["--from", "base", "--skip-restart"], {
    run: async (step) => labels.push(step.label),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async (value) => { written = value; },
    revision: async () => "head",
    diff: async () => ["AgentHub/assets/mini-app/app.js"],
  });
  assert.equal(result.revision, "head");
  assert.equal(written.revision, "head");
  assert.deepEqual(labels, [
    "Проверка синтаксиса Agent Hub",
    "Тесты жизненного цикла сообщений",
    "Тесты расширения VS Code",
    "Публикация Mini App Worker",
    "Сборка runtime-релиза",
    "Активация runtime-релиза",
  ]);
});

test("Worker packages only a verified published Android artifact", () => {
  const build = fs.readFileSync(path.join(ROOT, "cloudflare-worker", "build-assets.mjs"), "utf8");
  assert.match(build, /assets["'], ["']mobile/u);
  assert.match(build, /update\.json/u);
  assert.match(build, /createHash\("sha256"\)/u);
  assert.doesNotMatch(build, /app["'],\s*"build"/u);
});

test("every validation failure stops publication before deployment", async () => {
  const validations = [
    "Полные тесты Agent Hub",
    "Тесты расширения VS Code",
    "Сборка и smoke-проверка Agent Hub Desktop",
    "Сборка Agent Hub Mobile",
  ];

  for (const failedLabel of validations) {
    const events = [];
    let restartCalled = false;

    await assert.rejects(
      publishAll([], {
        run: async (step) => {
          events.push(step.label);
          if (step.label === failedLabel) {
            throw new Error(`synthetic validation failure: ${failedLabel}`);
          }
        },
        restart: async () => {
          restartCalled = true;
        },
      }),
      /synthetic validation failure/u,
    );

    assert.deepEqual(
      events,
      validations.slice(0, validations.indexOf(failedLabel) + 1),
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
  assert.match(workflow, /ci[\\/]desktop-smoke\.ps1/u);
  assert.match(workflow, /AndroidApp[\\/]build\.ps1/u);
  assert.doesNotMatch(workflow, /worker:deploy|publish:all|runtime:deploy|wrangler deploy/u);
  assert.doesNotMatch(workflow, /\bsecrets\.[A-Za-z0-9_]+/u);
});

test("Desktop smoke hashes the executable without optional PowerShell cmdlets", () => {
  const smoke = fs.readFileSync(
    path.resolve(ROOT, "ci", "desktop-smoke.ps1"),
    "utf8",
  );
  assert.match(smoke, /Security\.Cryptography\.SHA256/u);
  assert.doesNotMatch(smoke, /Get-FileHash/u);
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

    const packageScript = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
      .scripts["worker:deploy"];
    assert.match(packageScript, /node wrangler-runner\.mjs deploy/u);
    assert.doesNotMatch(packageScript, /\bnpx\b/u);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
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

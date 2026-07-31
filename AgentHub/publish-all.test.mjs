import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArguments, publicationSteps, publishAll } from "./publish-all.mjs";

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
});

test("publication requests the server's safe deferred restart last", async () => {
  const events = [];
  await publishAll(["--skip-tests", "--skip-worker"], {
    run: async (step) => events.push(step.label),
    restart: async (action) => {
      events.push(action);
      return { message: "scheduled" };
    },
  });
  assert.deepEqual(events, [
    "Сборка runtime-релиза",
    "Активация runtime-релиза",
    "Установка расширения VS Code",
    "restart-server",
  ]);
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

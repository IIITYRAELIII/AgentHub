import assert from "node:assert/strict";
import test from "node:test";

import { parseArguments, publicationSteps, publishAll } from "./publish-all.mjs";

test("publication plan validates, publishes every surface and installs the extension", () => {
  assert.deepEqual(
    publicationSteps().map((item) => item.label),
    [
      "Проверка синтаксиса",
      "Тесты Agent Hub",
      "Тесты расширения",
      "Публикация Mini App Worker",
      "Сборка runtime-релиза",
      "Активация runtime-релиза",
      "Установка расширения VS Code",
    ],
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

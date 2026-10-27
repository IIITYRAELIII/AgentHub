export const E2E_FILES = [
  "tests/e2e/agent-hub-server.e2e.test.mjs",
  "tests/e2e/agent-hub-server.claude.e2e.test.mjs",
  "tests/e2e/agent-hub-server.local-control.e2e.test.mjs",
  "tests/e2e/agent-hub-server.journal.e2e.test.mjs",
  "tests/e2e/agent-hub-server.recording-contour.e2e.test.mjs",
  "tests/e2e/test-contour-recording-refresh.e2e.test.mjs",
  "tests/e2e/test-contour-model-catalog.e2e.test.mjs",
  // Измерено 2026-09-10: 1.4 с, 5 из 5 проверок пройдено. Дешёвая проверка
  // владения Thread и восстановления MCP-моста, ранее не выполнялась ни одной
  // группой. Стоимость обычного выпуска практически не меняется.
  "tests/e2e/fake-codex-accept-all.e2e.test.mjs",
  // Протокольная защита harness: fake Codex отвечает на каждый запрос даже при
  // отказе записи state. Без неё потерянный ответ выглядит как 30-секундный
  // таймаут thread/read и ложное «app-server завис». Около 2 с.
  "tests/e2e/fake-codex-app-server.e2e.test.mjs",
];
// Дорогие сценарии надёжности на настоящих процессах. Не входят в `all`.
// Запускаются профилем `reliability` при правках соответствующих подсистем.
export const RELIABILITY_E2E_FILES = [
  "tests/e2e/terminal-queue-contention.local-control.e2e.test.mjs",
];
export const VSCODE_FILES = [
  "render.test.js",
  "agent-hub-bridge.test.js",
  "runtime-reload-policy.test.js",
  "activity-bar-launch.test.js",
  "vscode-direct-transport.test.js",
];
export const VISUAL_FILES = [
  "tests/public/card-layout-dom.test.mjs",
  "tests/public/journal-account-provider-column.test.mjs",
];
// Файлы, содержащие проверки под профилем. Профильный режим выполняет эти файлы
// с включённым профилем; их остальные проверки при этом выполняются повторно.
// Это сознательный размен: диапазон правки — один аргумент у каждой проверки,
// а профили запускаются по требованию, а не в каждом выпуске.
export const PROFILE_FILES = {
  cosmetic: [
    "tests/public/card-layout-dom.test.mjs",
    "tests/public/journal-account-provider-column.test.mjs",
  ],
  stress: [
    "tests/public/stream-tabs-controller.test.mjs",
  ],
  reliability: [...RELIABILITY_E2E_FILES],
};
